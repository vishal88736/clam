import { existsSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { AuditLogger, RealtimeEventHub } from './audit/logger.js';
import { GoogleAccounts, validateGoogleConfig } from './auth/google.js';
import { registerGoogleAuthRoutes } from './auth/routes.js';
import { loadConfig, type SiftvaneConfig } from './config.js';
import { createDatabase, type DbHandle } from './db/index.js';
import { resolveAgentConfig, type AgentConfig } from './inbox/agentConfig.js';
import { InboxEngine } from './inbox/engine.js';
import { registerInboxRoutes } from './inbox/routes.js';
import { LiveTarget } from './inbox/targets.js';
import { KillSwitchService } from './killswitch/service.js';
import { GmailLiveAdapter } from './mail/gmail.js';
import { registerMcpRoutes } from './mcp/server.js';
import { verificationRedirects } from './mcp/verification.js';
import { MissionRunner } from './platform/runner.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { AiSettings } from './platform/aiSettings.js';
import { PlatformService } from './platform/service.js';
import { LiveGoogleWorkspaceAdapter } from './workspace/adapters.js';

export interface SiftvaneRuntime {
  app: FastifyInstance;
  config: SiftvaneConfig;
  dbHandle: DbHandle;
  auditLogger: AuditLogger;
  killSwitchService: KillSwitchService;
  hub: RealtimeEventHub;
  inbox: InboxEngine;
  accounts: GoogleAccounts;
  platform: PlatformService;
  missions: MissionRunner;
  close(): Promise<void>;
}

export async function createSiftvaneApp(overrides?: {
  databasePath?: string;
  config?: Partial<SiftvaneConfig>;
  agent?: AgentConfig;
  google?: ConstructorParameters<typeof GoogleAccounts>[2];
}): Promise<SiftvaneRuntime> {
  const baseConfig = loadConfig();
  const config: SiftvaneConfig = {
    ...baseConfig,
    ...overrides?.config,
    databasePath: overrides?.databasePath ?? overrides?.config?.databasePath ?? baseConfig.databasePath,
  };

  validateGoogleConfig(config);
  const dbHandle = createDatabase(config.databasePath);
  const accounts = new GoogleAccounts(dbHandle.sqlite, config, overrides?.google);
  const hub = new RealtimeEventHub();
  const auditLogger = new AuditLogger(dbHandle.db, hub);
  const killSwitchService = new KillSwitchService(dbHandle.db, auditLogger, hub, {
    violation_threshold: config.circuitBreaker.violationThreshold,
    window_seconds: config.circuitBreaker.windowSeconds,
    max_calls_per_min: config.circuitBreaker.maxCallsPerMin,
    trip_on_critical_injection: config.circuitBreaker.tripOnCriticalInjection,
  });
  await killSwitchService.init();

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: [config.webOrigin, `http://127.0.0.1:${config.webPort}`],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'Accept',
      'Mcp-Session-Id',
      'Last-Event-ID',
      'X-Siftvane-Run-Id',
      'X-Siftvane-Inbox-Id',
      'X-Siftvane-Operator-Token',
      'X-Clam-Run-Id',
      'X-Clam-Inbox-Id',
      'X-Clam-Operator-Token',
    ],
    exposedHeaders: ['Mcp-Session-Id'],
  });

  app.get('/api/health', async () => ({ status: 'ok', halted: killSwitchService.getState().status === 'HALTED' }));

  const lockfile = config.databasePath === ':memory:' ? undefined : config.lockfile;
  const inbox: InboxEngine = new InboxEngine({
    databasePath: config.databasePath, tracesDir: config.tracesDir, lockfile, stagingDir: config.mailAttachmentsDir,
    // Keep the original key derivation context for stored handoff signatures.
    handoffKey: createHmac('sha256', config.encryptionKey).update('clam:agent-handoff:v1').digest(),
    externalHalt: () => killSwitchService.getState().status === 'HALTED',
    onTrip: (reason, runId) => killSwitchService.engage({ reason, runId, triggerMode: 'circuit_breaker' }),
    onRun: (id, controller) => killSwitchService.registerInFlight(id, 'ag_autonomous', controller),
    agent: overrides?.agent ?? resolveAgentConfig(),
    live: config.inboxLive ? {
      ready: (mode) => mode.startsWith('live:') && accounts.connection(mode.slice(5))?.status === 'active',
      modes: () => accounts.activeInboxIds().map((id) => `live:${id}` as const),
      target: (mode, guard, store) => {
        const inboxId = mode.slice(5);
        return new LiveTarget(store, new GmailLiveAdapter(accounts, inboxId, guard), config.calendarId, guard, { inboxId, accounts });
      },
      reader: async (mode, search, signal) => {
        const inboxId = mode.slice(5);
        return new LiveTarget(inbox.store, new GmailLiveAdapter(accounts, inboxId, inbox.guard),
          config.calendarId, inbox.guard, { inboxId, accounts }).readerMessages(search, signal);
      },
      mutationScope: (mode, kind) => {
        if (['mail','send','draft'].includes(kind)) accounts.requireScope(mode.slice(5), 'mail:write');
        if (kind === 'calendar') accounts.requireScope(mode.slice(5), 'calendar:write');
        if (kind === 'workspace') accounts.requireScope(mode.slice(5), 'drive:write');
      },
      workspace: (mode, guard, registry) => new LiveGoogleWorkspaceAdapter(accounts, mode.slice(5), registry, guard, config.mailAttachmentsDir),
      redact: (mode, value) => accounts.redact(mode.slice(5), value),
    } : undefined,
  });
  killSwitchService.attachExternalHalt(inbox.halted, () => {
    if (lockfile) rmSync(lockfile, { force: true });
    inbox.latch(false);
  });
  hub.on('event', (event) => {
    if (event.type !== 'killswitch.changed') return;
    const data = event.data as { status: string };
    if (data.status === 'HALTED' || (lockfile && existsSync(lockfile))) inbox.latch(true);
  });
  if (inbox.halted()) inbox.latch(true);
  inbox.startScheduler();
  // The AI provider can be picked in the website; tests that inject a model keep it.
  const ai = new AiSettings(inbox.store.sqlite, config.googleTokenKey, inbox.agent, (choice) => inbox.useAgent(choice));
  if (!overrides?.agent) ai.load();
  const platform = new PlatformService(inbox.store, dbHandle.sqlite, inbox.registry);
  const missions = new MissionRunner(inbox, platform, { webOrigin: config.webOrigin });
  missions.start();
  registerPlatformRoutes(app, { inbox, platform, missions, accounts, config, ai });
  registerGoogleAuthRoutes(app, accounts, config, inbox);
  registerInboxRoutes(app, inbox, config, killSwitchService, accounts, lockfile, platform);

  registerMcpRoutes(app, {
    accounts,
    inbox,
    platform,
    missions,
    calendarId: config.calendarId,
    stagingDir: config.mailAttachmentsDir,
    verificationRedirects: verificationRedirects(process.env.SIFTVANE_VERIFICATION_REDIRECTS),
  });

  return {
    app,
    config,
    dbHandle,
    auditLogger,
    killSwitchService,
    hub,
    inbox,
    accounts,
    platform,
    missions,
    close: async () => {
      app.server.closeAllConnections?.();
      await missions.close();
      await app.close();
      await inbox.close();
      dbHandle.close();
    },
  };
}
