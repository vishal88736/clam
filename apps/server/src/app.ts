import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { AgentService } from './agents/service.js';
import { ApprovalService } from './approvals/service.js';
import { AuditLogger, RealtimeEventHub } from './audit/logger.js';
import { loadConfig, type ClamConfig } from './config.js';
import { createDatabase, type DbHandle } from './db/index.js';
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
  const approvalService = new ApprovalService(
    dbHandle.db,
    mailService,
    auditLogger,
    hub,
    config
  );
  approvalService.startExpirySweeper();

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'Last-Event-ID'],
    exposedHeaders: ['Mcp-Session-Id'],
  });

  registerApiRoutes(app, {
    config,
    agentService,
    policyEngine,
    mailService,
    approvalService,
    auditLogger,
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
    hub,
    close: async () => {
      approvalService.stopExpirySweeper();
      app.server.closeAllConnections?.();
      await app.close();
      dbHandle.close();
    },
  };
}
