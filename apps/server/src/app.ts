import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { AutonomousRunnerService } from './agents/runnerService.js';
import { AgentService } from './agents/service.js';
import { ApprovalService } from './approvals/service.js';
import { AuditLogger, RealtimeEventHub } from './audit/logger.js';
import { loadConfig, type ClamConfig } from './config.js';
import { createDatabase, type DbHandle } from './db/index.js';
import { KillSwitchService } from './killswitch/service.js';
import { MailService } from './mail/service.js';
import { CryptoVault } from './mail/vault.js';
import { registerMcpRoutes } from './mcp/server.js';
import type { SemanticClassifierFn } from './policy/classifier.js';
import { PolicyEngine } from './policy/engine.js';
import { registerApiRoutes, type StoredLlmSettings } from './routes/api.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface ClamRuntime {
  app: FastifyInstance;
  config: ClamConfig;
  dbHandle: DbHandle;
  agentService: AgentService;
  policyEngine: PolicyEngine;
  mailService: MailService;
  approvalService: ApprovalService;
  auditLogger: AuditLogger;
  killSwitchService: KillSwitchService;
  runnerService: AutonomousRunnerService;
  hub: RealtimeEventHub;
  close(): Promise<void>;
}

export async function createClamApp(overrides?: {
  databasePath?: string;
  config?: Partial<ClamConfig>;
  customClassifier?: SemanticClassifierFn;
}): Promise<ClamRuntime> {
  const baseConfig = loadConfig();
  const config: ClamConfig = {
    ...baseConfig,
    ...overrides?.config,
    databasePath: overrides?.databasePath ?? overrides?.config?.databasePath ?? baseConfig.databasePath,
  };

  const dbHandle = createDatabase(config.databasePath);
  const vault = new CryptoVault(config.encryptionKey);
  const hub = new RealtimeEventHub();
  const mailService = new MailService(dbHandle.db, vault, config);
  await mailService.init();

  const getLlmConfig = async () => {
    const stored = await mailService.getVaultJson<StoredLlmSettings>('llm_provider_config');
    return {
      provider: stored?.provider ?? config.llmProvider,
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
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Mcp-Session-Id',
      'Last-Event-ID',
      'X-Clam-Run-Id',
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

  registerWebhookRoutes(app, approvalService);

  registerMcpRoutes(app, {
    agentService,
    policyEngine,
    mailService,
    approvalService,
    auditLogger,
    killSwitchService,
    artifactsDir: config.artifactsDir,
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
    close: async () => {
      approvalService.stopExpirySweeper();
      app.server.closeAllConnections?.();
      await app.close();
      dbHandle.close();
    },
  };
}
