import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SensitiveCategorySchema,
  type ApprovalStatus,
  type AuditDecision,
  type EphemeralEmail,
  type LlmProvider,
  type McpToolName,
  type SensitiveCategory,
} from '@clam/shared';
import type { AgentService } from '../agents/service.js';
import type { ApprovalService } from '../approvals/service.js';
import type { AuditLogger, RealtimeEventHub } from '../audit/logger.js';
import type { ClamConfig } from '../config.js';
import type { MailService } from '../mail/service.js';
import { buildMcpConfigSnippets } from '../mcp/server.js';
import { compilePolicy, type LlmCompilerRuntimeConfig } from '../policy/compiler.js';
import type { PolicyEngine } from '../policy/engine.js';

const VAULT_LLM_KEY = 'llm_provider_config';

export interface StoredLlmSettings {
  provider: LlmProvider;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  ollamaBaseUrl?: string;
}

export interface ApiDeps {
  config: ClamConfig;
  agentService: AgentService;
  policyEngine: PolicyEngine;
  mailService: MailService;
  approvalService: ApprovalService;
  auditLogger: AuditLogger;
  hub: RealtimeEventHub;
  getLlmConfig: () => Promise<LlmCompilerRuntimeConfig>;
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'clam-firewall',
    zero_retention: true,
    mail_mode: deps.mailService.getMode(),
    timestamp: new Date().toISOString(),
  }));

  // Live SSE Event Stream for Console UI
  app.get('/api/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    reply.hijack();

    const sendEvent = (event: string, payload: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // Ignore closed stream writes
      }
    };

    sendEvent('connected', {
      timestamp: new Date().toISOString(),
      mail_mode: deps.mailService.getMode(),
    });

    const onEvent = (evt: { type: string; timestamp: string; data: unknown }) => {
      sendEvent(evt.type, evt);
    };

    deps.hub.on('event', onEvent);

    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        // Ignore
      }
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      deps.hub.off('event', onEvent);
    });
  });

  // Overview summary
  app.get('/api/overview', async () => {
    const [allAgents, pendingApprovals, metrics, gmailStatus] = await Promise.all([
      deps.agentService.listAgents(),
      deps.approvalService.list('PENDING'),
      deps.auditLogger.getMetrics(),
      deps.mailService.getGmailStatus(),
    ]);

    return {
      mail_mode: deps.mailService.getMode(),
      gmail_status: gmailStatus,
      zero_retention_verified: true,
      active_agents_count: allAgents.filter((a) => a.status === 'active').length,
      total_agents_count: allAgents.length,
      pending_approvals_count: pendingApprovals.length,
      metrics,
    };
  });

  // Agents CRUD + Compile Preview + Policy Simulator + MCP Tokens
  app.get('/api/agents', async () => {
    const list = await deps.agentService.listAgents();
    return { agents: list };
  });

  app.get('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await deps.agentService.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const tokens = await deps.agentService.listTokens(id);
    return { agent, tokens };
  });

  app.post('/api/agents', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(80),
      description: z.string().max(300).optional(),
      raw_rules: z.string().min(1),
      overridden_sensitive_categories: z.array(SensitiveCategorySchema).optional(),
      rate_limit_per_min: z.number().int().min(1).max(1000).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const created = await deps.agentService.createAgent({
      name: parsed.data.name,
      description: parsed.data.description,
      rawRules: parsed.data.raw_rules,
      overriddenSensitiveCategories: parsed.data.overridden_sensitive_categories,
      rateLimitPerMin: parsed.data.rate_limit_per_min,
    });
    return reply.code(201).send({
      agent: created.agent,
      token: created.initialToken.info,
      raw_token: created.initialToken.rawToken,
    });
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(300).optional(),
      raw_rules: z.string().min(1).optional(),
      status: z.enum(['active', 'paused']).optional(),
      rate_limit_per_min: z.number().int().min(1).max(1000).optional(),
      overridden_sensitive_categories: z.array(SensitiveCategorySchema).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const updated = await deps.agentService.updateAgent(id, {
        name: parsed.data.name,
        description: parsed.data.description,
        rawRules: parsed.data.raw_rules,
        status: parsed.data.status,
        rateLimitPerMin: parsed.data.rate_limit_per_min,
        overriddenSensitiveCategories: parsed.data.overridden_sensitive_categories,
      });
      return { agent: updated };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'Not found' });
    }
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.agentService.deleteAgent(id);
    return reply.code(204).send();
  });

  app.post('/api/agents/:id/compile-preview', async (request, reply) => {
    const schema = z.object({
      raw_rules: z.string(),
      overridden_sensitive_categories: z.array(SensitiveCategorySchema).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const policy_ir = await compilePolicy({
      rawRules: parsed.data.raw_rules,
      overriddenSensitiveCategories: parsed.data.overridden_sensitive_categories as
        | SensitiveCategory[]
        | undefined,
      llmConfig: await deps.getLlmConfig(),
    });
    return { policy_ir };
  });

  // Policy Simulator (Dry-Run — never persists email content)
  app.post('/api/agents/:id/simulate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await deps.agentService.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const schema = z.object({
      tool: z.enum([
        'list_emails',
        'search_emails',
        'read_email',
        'create_draft',
        'send_email',
        'archive_email',
        'apply_label',
      ]),
      raw_rules_override: z.string().optional(),
      sandbox_email_id: z.string().optional(),
      custom_email: z
        .object({
          from: z.string(),
          subject: z.string(),
          body: z.string(),
          attachmentNames: z.array(z.string()).optional(),
        })
        .optional(),
      outbound: z
        .object({
          to: z.string().optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    let effectiveAgent = agent;
    if (parsed.data.raw_rules_override !== undefined) {
      effectiveAgent = {
        ...agent,
        raw_rules: parsed.data.raw_rules_override,
        policy_ir: await compilePolicy({
          rawRules: parsed.data.raw_rules_override,
          overriddenSensitiveCategories: agent.policy_ir.overridden_sensitive_categories,
          llmConfig: await deps.getLlmConfig(),
        }),
      };
    }

    let email: EphemeralEmail | null = null;
    if (parsed.data.sandbox_email_id) {
      email = await deps.mailService.sandbox.getMessage(parsed.data.sandbox_email_id);
    } else if (parsed.data.custom_email) {
      email = {
        id: 'sim_custom_ephemeral',
        threadId: 'sim_thread',
        from: parsed.data.custom_email.from,
        to: ['alex.chen@example.com'],
        subject: parsed.data.custom_email.subject,
        date: new Date().toISOString(),
        snippet: parsed.data.custom_email.body.slice(0, 120),
        body: parsed.data.custom_email.body,
        labels: ['INBOX'],
        hasAttachments: Boolean(parsed.data.custom_email.attachmentNames?.length),
        attachmentNames: parsed.data.custom_email.attachmentNames ?? [],
      };
    }

    const trace = await deps.policyEngine.evaluate(
      {
        agent: effectiveAgent,
        tool: parsed.data.tool as McpToolName,
        email,
        outbound: parsed.data.outbound,
      },
      { skipRateLimit: true }
    );

    return { trace, evaluated_policy_ir: effectiveAgent.policy_ir };
  });

  // Scoped Token Management
  app.get('/api/agents/:id/tokens', async (request) => {
    const { id } = request.params as { id: string };
    return { tokens: await deps.agentService.listTokens(id) };
  });

  app.post('/api/agents/:id/tokens', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { label?: string };
    try {
      const issued = await deps.agentService.issueToken(id, body.label || 'MCP Client Token');
      return reply.code(201).send({ token: issued.info, raw_token: issued.rawToken });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'Not found' });
    }
  });

  app.post('/api/agents/:id/tokens/rotate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { token_id?: string };
    try {
      const issued = await deps.agentService.rotateToken(id, body.token_id);
      return reply.code(201).send({ token: issued.info, raw_token: issued.rawToken });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'Not found' });
    }
  });

  app.delete('/api/agents/:id/tokens/:tokenId', async (request, reply) => {
    const { id, tokenId } = request.params as { id: string; tokenId: string };
    await deps.agentService.revokeToken(id, tokenId);
    return reply.code(204).send();
  });

  app.get('/api/agents/:id/mcp-config', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { token } = request.query as { token?: string };
    const agent = await deps.agentService.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return {
      snippets: buildMcpConfigSnippets({
        publicUrl: deps.config.publicUrl,
        agent,
        tokenPlaceholder: token,
      }),
    };
  });

  // Sandbox inbox inspector for Simulator dropdown
  app.get('/api/sandbox/emails', async () => {
    return {
      emails: deps.mailService.sandbox.getAllForSimulator(),
      state: deps.mailService.sandbox.getStateSummary(),
    };
  });

  app.post('/api/sandbox/reset', async () => {
    deps.mailService.sandbox.reset();
    return { ok: true };
  });

  // HITL Approvals API
  app.get('/api/approvals', async (request) => {
    const { status } = request.query as { status?: ApprovalStatus };
    const approvals = await deps.approvalService.list(status);
    return { approvals };
  });

  app.get('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const approval = await deps.approvalService.getById(id);
    if (!approval) return reply.code(404).send({ error: 'Approval not found' });
    return { approval };
  });

  app.post('/api/approvals/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      to?: string;
      subject?: string;
      body?: string;
      label?: string;
    };
    try {
      const outcome = await deps.approvalService.resolveApproval({
        id,
        resolution: 'APPROVED',
        channel: 'app',
        editedPayload: body,
      });
      return outcome;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Approval error' });
    }
  });

  app.post('/api/approvals/:id/deny', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const outcome = await deps.approvalService.resolveApproval({
        id,
        resolution: 'REJECTED',
        channel: 'app',
      });
      return outcome;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Denial error' });
    }
  });

  // Zero-Content Audit Ledger API
  app.get('/api/audit', async (request) => {
    const q = request.query as {
      agent_id?: string;
      decision?: AuditDecision;
      mcp_tool?: string;
      from?: string;
      to?: string;
      search?: string;
      limit?: string;
    };
    const logs = await deps.auditLogger.list({
      agentId: q.agent_id || undefined,
      decision: q.decision || undefined,
      mcpTool: q.mcp_tool || undefined,
      fromIso: q.from || undefined,
      toIso: q.to || undefined,
      search: q.search || undefined,
      limit: q.limit ? Number(q.limit) : 100,
    });
    return { logs };
  });

  // Settings: Mail Mode, LLM Classifier, Slack/Telegram/WhatsApp Channels
  app.get('/api/settings', async () => {
    const [gmailStatus, channels, llmRuntime, storedLlm] = await Promise.all([
      deps.mailService.getGmailStatus(),
      deps.approvalService.getChannelConfigs(),
      deps.getLlmConfig(),
      deps.mailService.getVaultJson<StoredLlmSettings>(VAULT_LLM_KEY),
    ]);

    return {
      gmail: gmailStatus,
      llm: {
        provider: llmRuntime.provider,
        model: llmRuntime.model ?? '',
        ollamaBaseUrl: llmRuntime.ollamaBaseUrl ?? deps.config.ollamaBaseUrl,
        hasOpenaiKey: Boolean(storedLlm?.openaiApiKey || deps.config.openaiApiKey),
        hasAnthropicKey: Boolean(storedLlm?.anthropicApiKey || deps.config.anthropicApiKey),
        hasGeminiKey: Boolean(storedLlm?.geminiApiKey || deps.config.geminiApiKey),
      },
      channels: {
        slack: {
          configured: Boolean(
            channels.slack.webhookUrl || (channels.slack.botToken && channels.slack.channelId)
          ),
          channelId: channels.slack.channelId ?? '',
          hasBotToken: Boolean(channels.slack.botToken),
          hasWebhookUrl: Boolean(channels.slack.webhookUrl),
          hasSigningSecret: Boolean(channels.slack.signingSecret),
          callbackUrl: `${deps.config.publicUrl.replace(/\/$/, '')}/webhooks/slack`,
        },
        telegram: {
          configured: Boolean(channels.telegram.botToken && channels.telegram.chatId),
          chatId: channels.telegram.chatId ?? '',
          hasBotToken: Boolean(channels.telegram.botToken),
          hasWebhookSecret: Boolean(channels.telegram.webhookSecret),
          callbackUrl: `${deps.config.publicUrl.replace(/\/$/, '')}/webhooks/telegram`,
        },
        whatsapp: {
          configured: Boolean(
            channels.whatsapp.accessToken &&
              channels.whatsapp.phoneNumberId &&
              channels.whatsapp.recipientNumber
          ),
          phoneNumberId: channels.whatsapp.phoneNumberId ?? '',
          recipientNumber: channels.whatsapp.recipientNumber ?? '',
          hasAccessToken: Boolean(channels.whatsapp.accessToken),
          hasVerifyToken: Boolean(channels.whatsapp.verifyToken),
          hasAppSecret: Boolean(channels.whatsapp.appSecret),
          callbackUrl: `${deps.config.publicUrl.replace(/\/$/, '')}/webhooks/whatsapp`,
        },
      },
    };
  });

  app.patch('/api/settings/mail-mode', async (request, reply) => {
    const schema = z.object({ mode: z.enum(['sandbox', 'gmail']) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const mode = await deps.mailService.setMode(parsed.data.mode);
      deps.hub.publish('settings.updated', { mail_mode: mode });
      return { mode };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Mode switch failed' });
    }
  });

  app.patch('/api/settings/llm', async (request, reply) => {
    const schema = z.object({
      provider: z.enum(['local_heuristic', 'openai', 'anthropic', 'gemini', 'ollama']),
      model: z.string().optional(),
      openaiApiKey: z.string().optional(),
      anthropicApiKey: z.string().optional(),
      geminiApiKey: z.string().optional(),
      ollamaBaseUrl: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const existing = (await deps.mailService.getVaultJson<StoredLlmSettings>(VAULT_LLM_KEY)) ?? {
      provider: deps.config.llmProvider,
    };
    const next: StoredLlmSettings = {
      provider: parsed.data.provider,
      model: parsed.data.model ?? existing.model,
      openaiApiKey: parsed.data.openaiApiKey || existing.openaiApiKey,
      anthropicApiKey: parsed.data.anthropicApiKey || existing.anthropicApiKey,
      geminiApiKey: parsed.data.geminiApiKey || existing.geminiApiKey,
      ollamaBaseUrl: parsed.data.ollamaBaseUrl || existing.ollamaBaseUrl,
    };
    await deps.mailService.setVaultJson(VAULT_LLM_KEY, next);
    deps.hub.publish('settings.updated', { section: 'llm', provider: next.provider });
    return { ok: true, provider: next.provider };
  });

  app.patch('/api/settings/channels', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const saved = await deps.approvalService.saveChannelConfigs(body);
      return {
        ok: true,
        slackConfigured: Boolean(
          saved.slack.webhookUrl || (saved.slack.botToken && saved.slack.channelId)
        ),
        telegramConfigured: Boolean(saved.telegram.botToken && saved.telegram.chatId),
        whatsappConfigured: Boolean(
          saved.whatsapp.accessToken &&
            saved.whatsapp.phoneNumberId &&
            saved.whatsapp.recipientNumber
        ),
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  app.post('/api/channels/test-approval', async () => {
    const approval = await deps.approvalService.sendTestApproval();
    return { approval };
  });

  // Gmail OAuth Endpoints
  app.post('/api/auth/gmail/start', async (request, reply) => {
    const body = (request.body ?? {}) as { scopes?: ('readonly' | 'compose' | 'modify')[] };
    try {
      const flow = deps.mailService.startOAuthFlow(body.scopes);
      return { auth_url: flow.url };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'OAuth error' });
    }
  });

  app.get('/api/auth/gmail/callback', async (request, reply) => {
    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (error) {
      return reply.code(400).send({ error: `Google OAuth denied: ${error}` });
    }
    if (!code || !state) {
      return reply.code(400).send({ error: 'Missing code or state parameter' });
    }
    try {
      const result = await deps.mailService.completeOAuthCallback(code, state);
      deps.hub.publish('settings.updated', { mail_mode: 'gmail', email: result.email });
      const webRedirect = `http://localhost:${deps.config.webPort}/settings?gmail=connected`;
      return reply.redirect(webRedirect);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Callback failed' });
    }
  });

  app.post('/api/auth/gmail/disconnect', async () => {
    await deps.mailService.disconnectGmail();
    deps.hub.publish('settings.updated', { mail_mode: 'sandbox' });
    return { ok: true, mode: 'sandbox' };
  });
}
