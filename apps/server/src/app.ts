import { existsSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { AutonomousRunnerService } from './agents/runnerService.js';
import { AgentService } from './agents/service.js';
import { ApprovalService } from './approvals/service.js';
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
import { MailService } from './mail/service.js';
import { GmailLiveAdapter } from './mail/gmail.js';
import { CryptoVault } from './mail/vault.js';
import { registerMcpRoutes } from './mcp/server.js';
import { verificationRedirects } from './mcp/verification.js';
import type { SemanticClassifierFn } from './policy/classifier.js';
import { PolicyEngine } from './policy/engine.js';
import { registerApiRoutes, type StoredLlmSettings } from './routes/api.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { MissionRunner } from './platform/runner.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { PlatformService } from './platform/service.js';
import { LiveGoogleWorkspaceAdapter } from './workspace/adapters.js';

export interface SiftvaneRuntime {
  app: FastifyInstance;
  config: SiftvaneConfig;
  dbHandle: DbHandle;
  agentService: AgentService;
  policyEngine: PolicyEngine;
  mailService: MailService;
  approvalService: ApprovalService;
  auditLogger: AuditLogger;
  killSwitchService: KillSwitchService;
  runnerService: AutonomousRunnerService;
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
  customClassifier?: SemanticClassifierFn;
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
  const vault = new CryptoVault(config.encryptionKey);
  const hub = new RealtimeEventHub();
  const mailService = new MailService(dbHandle.db, vault, config);

  const getLlmConfig = async () => {
    const stored = await mailService.getVaultJson<StoredLlmSettings>('llm_provider_config');
    return {
      provider: stored?.provider ?? 'local_heuristic' as const,
      model: stored?.model ?? config.llmModel,
      openaiApiKey: stored?.openaiApiKey ?? config.openaiApiKey,
      anthropicApiKey: stored?.anthropicApiKey ?? config.anthropicApiKey,
      geminiApiKey: stored?.geminiApiKey ?? config.geminiApiKey,
      ollamaBaseUrl: stored?.ollamaBaseUrl ?? config.ollamaBaseUrl,
      timeoutMs: config.classifierTimeoutMs,
    };
  };

  const agentService = new AgentService(dbHandle.db, getLlmConfig, hub);
  await agentService.seedDefaultsIfEmpty();

  const policyEngine = new PolicyEngine(getLlmConfig, overrides?.customClassifier);
  const auditLogger = new AuditLogger(dbHandle.db, hub);
  const killSwitchService = new KillSwitchService(dbHandle.db, auditLogger, hub, {
    violation_threshold: config.circuitBreaker.violationThreshold,
    window_seconds: config.circuitBreaker.windowSeconds,
    max_calls_per_min: config.circuitBreaker.maxCallsPerMin,
    trip_on_critical_injection: config.circuitBreaker.tripOnCriticalInjection,
  });
  await killSwitchService.init();

  const approvalService = new ApprovalService(
    dbHandle.db,
    mailService,
    auditLogger,
    hub,
    config,
    killSwitchService
  );
  approvalService.startExpirySweeper();

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

  const runnerService = new AutonomousRunnerService(
    app,
    config,
    agentService,
    mailService,
    auditLogger,
    killSwitchService,
    hub,
    getLlmConfig
  );

  registerApiRoutes(app, {
    config,
    agentService,
    policyEngine,
    mailService,
    approvalService,
    auditLogger,
    killSwitchService,
    runnerService,
    hub,
    getLlmConfig,
  });

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
  const platform = new PlatformService(inbox.store, dbHandle.sqlite, inbox.registry);
  const missions = new MissionRunner(inbox, platform, { webOrigin: config.webOrigin });
  missions.start();
  registerPlatformRoutes(app, { inbox, platform, missions, accounts, config });
  registerGoogleAuthRoutes(app, accounts, config, inbox);
  registerInboxRoutes(app, inbox, config, killSwitchService, accounts, lockfile, platform);

  registerWebhookRoutes(app, approvalService);

  registerMcpRoutes(app, {
    agentService,
    policyEngine,
    mailService,
    approvalService,
    auditLogger,
    killSwitchService,
    artifactsDir: config.artifactsDir,
    accounts,
    inbox,
    platform,
    missions,
    calendarId: config.calendarId,
    stagingDir: config.mailAttachmentsDir,
    tracesDir: config.tracesDir,
    verificationRedirects: verificationRedirects(process.env.SIFTVANE_VERIFICATION_REDIRECTS),
  });

  return {
    app,
    config,
    dbHandle,
    agentService,
    policyEngine,
    mailService,
    approvalService,
    auditLogger,
    killSwitchService,
    runnerService,
    hub,
    inbox,
    accounts,
    platform,
    missions,
    close: async () => {
      approvalService.stopExpirySweeper();
      app.server.closeAllConnections?.();
      await missions.close();
      await app.close();
      await inbox.close();
      dbHandle.close();
    },
  };
}
