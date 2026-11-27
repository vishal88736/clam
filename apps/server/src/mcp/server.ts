import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { mcpTokenKind } from '@siftvane/shared';
import type {
  AgentRecord,
  EphemeralEmail,
  McpToolName,
  SafeEmailDetail,
  SafeEmailSummary,
} from '@siftvane/shared';
import type { AgentService } from '../agents/service.js';
import type { ApprovalService } from '../approvals/service.js';
import type { AuditLogger } from '../audit/logger.js';
import type { KillSwitchService } from '../killswitch/service.js';
import type { MailService } from '../mail/service.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { GoogleAccounts } from '../auth/google.js';
import type { InboxEngine } from '../inbox/engine.js';
import { createInboxMcpServer } from './google.js';
import { createPodMcpServer } from './pod.js';

import type { MissionRunner } from '../platform/runner.js';
import type { PlatformService } from '../platform/service.js';

export interface McpDeps {
  agentService: AgentService;
  policyEngine: PolicyEngine;
  mailService: MailService;
  approvalService: ApprovalService;
  auditLogger: AuditLogger;
  killSwitchService: KillSwitchService;
  artifactsDir: string;
  accounts: GoogleAccounts;
  inbox: InboxEngine;
  platform: PlatformService;
  missions: MissionRunner;
  calendarId: string;
  stagingDir: string;
  tracesDir: string;
  verificationRedirects: Record<string, string[]>;
}

function toSafeSummary(email: EphemeralEmail, semanticCategory: string | null): SafeEmailSummary {
  return {
    id: email.id,
    threadId: email.threadId,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    snippet: email.snippet,
    labels: email.labels,
    hasAttachments: email.hasAttachments,
    semanticCategory,
  };
}

function toSafeDetail(email: EphemeralEmail, semanticCategory: string | null): SafeEmailDetail {
  return {
    ...toSafeSummary(email, semanticCategory),
    body: email.body,
    attachmentNames: email.attachmentNames ?? [],
  };
}

function jsonContent(data: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function createAgentMcpServer(
  agentSnapshot: AgentRecord,
  deps: McpDeps,
  getRunId: () => string | null = () => null
): McpServer {
  const server = new McpServer({
    name: 'siftvane-email-firewall',
    version: '1.0.0',
  });

  const getFreshAgent = async (): Promise<AgentRecord> => {
    return (await deps.agentService.getAgent(agentSnapshot.id)) ?? agentSnapshot;
  };

  const checkKillSwitchForTool = async (agent: AgentRecord, toolName: string) => {
    if (!deps.killSwitchService.isHalted(agent.id)) return null;
    const ks = deps.killSwitchService.getState();
    await deps.auditLogger.record({
      runId: getRunId(),
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: toolName,
      decision: 'DENY',
      matchedRuleId: 'kill_switch',
      ruleCitation: `Kill Switch engaged (${ks.reason ?? 'HALTED'}): tool call rejected.`,
      semanticCategory: 'kill_switch',
      confidence: 1,
      latencyMs: 1,
    });
    return jsonContent(
      {
        error: 'KILL_SWITCH_ENGAGED',
        decision: 'DENY',
        reasoning_code: 'KILL_SWITCH_ENGAGED',
        reason: ks.reason,
      },
      true
    );
  };

  async function handleListOrSearch(
    toolName: 'list_emails' | 'search_emails',
    query?: string,
    maxResults = 25
  ) {
    const agent = await getFreshAgent();
    const haltedReply = await checkKillSwitchForTool(agent, toolName);
    if (haltedReply) return haltedReply;

    const runId = getRunId();
    const start = performance.now();
    const gateTrace = await deps.policyEngine.evaluate({
      agent,
      tool: toolName,
    });

    if (gateTrace.decision === 'DENY') {
      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: 'DENY',
        matchedRuleId: gateTrace.matched_rule_id,
        ruleCitation: gateTrace.rule_citation,
        semanticCategory: gateTrace.semantic_category,
        confidence: gateTrace.confidence,
        injectionRiskScore: gateTrace.injection_risk_score,
        injectionSignals: gateTrace.injection_signals,
        latencyMs: gateTrace.latency_ms,
      });
      await deps.killSwitchService.recordToolOutcome({
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: 'DENY',
        reasoningCode: gateTrace.reasoning_code,
        injectionRiskScore: gateTrace.injection_risk_score,
        runId,
      });
      return jsonContent(
        {
          error: 'SIFTVANE_POLICY_DENIED',
          decision: 'DENY',
          reasoning_code: gateTrace.reasoning_code,
          rule_citation: gateTrace.rule_citation,
        },
        true
      );
    }

    const provider = deps.mailService.getActiveProvider();
    const candidates = await provider.listMessages(query, maxResults);

    // SILENT FILTERING: Evaluate each ephemeral message in RAM and drop non-matching/injected emails without leaking count or metadata.
    const permitted: SafeEmailSummary[] = [];
    for (const email of candidates) {
      const itemTrace = await deps.policyEngine.evaluate(
        {
          agent,
          tool: 'read_email',
          email,
        },
        { skipRateLimit: true }
      );

      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: itemTrace.decision,
        matchedRuleId: itemTrace.matched_rule_id,
        ruleCitation: itemTrace.rule_citation,
        semanticCategory: itemTrace.semantic_category,
        confidence: itemTrace.confidence,
        injectionRiskScore: itemTrace.injection_risk_score,
        injectionSignals: itemTrace.injection_signals,
        rawMessageId: email.id,
        latencyMs: itemTrace.latency_ms,
      });

      if (itemTrace.decision === 'ALLOW') {
        permitted.push(toSafeSummary(email, itemTrace.semantic_category));
      }
    }

    if (candidates.length === 0) {
      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: 'ALLOW',
        matchedRuleId: gateTrace.matched_rule_id,
        ruleCitation: gateTrace.rule_citation,
        semanticCategory: null,
        confidence: 1,
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
      });
    }

    await deps.killSwitchService.recordToolOutcome({
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: toolName,
      decision: 'ALLOW',
      reasoningCode: 'ALLOWED_BY_RULE',
      injectionRiskScore: 0,
      runId,
    });

    return jsonContent({
      emails: permitted,
      returned: permitted.length,
    });
  }

  server.registerTool(
    'list_emails',
    {
      description:
        'List emails permitted by your Siftvane policy. Unauthorized, sensitive, or prompt-injected emails are silently stripped.',
      inputSchema: {
        query: z.string().optional().describe('Optional search filter'),
        maxResults: z.number().int().min(1).max(50).optional().describe('Max emails to return'),
      },
    },
    async ({ query, maxResults }) => handleListOrSearch('list_emails', query, maxResults)
  );

  server.registerTool(
    'search_emails',
    {
      description:
        'Search emails permitted by your Siftvane policy. Unauthorized, sensitive, or prompt-injected emails are silently stripped.',
      inputSchema: {
        query: z.string().min(1).describe('Search query'),
        maxResults: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, maxResults }) => handleListOrSearch('search_emails', query, maxResults)
  );

  server.registerTool(
    'read_email',
    {
      description:
        'Read a single email by messageId. Always re-verifies deterministic, semantic, and prompt-injection checks.',
      inputSchema: {
        messageId: z.string().min(1).describe('Email message ID'),
      },
    },
    async ({ messageId }) => {
      const agent = await getFreshAgent();
      const haltedReply = await checkKillSwitchForTool(agent, 'read_email');
      if (haltedReply) return haltedReply;

      const runId = getRunId();
      const stageACheck = await deps.policyEngine.evaluate({
        agent,
        tool: 'read_email',
      });

      if (stageACheck.decision === 'DENY') {
        await deps.auditLogger.record({
          runId,
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'read_email',
          decision: 'DENY',
          matchedRuleId: stageACheck.matched_rule_id,
          ruleCitation: stageACheck.rule_citation,
          semanticCategory: null,
          confidence: 1,
          injectionRiskScore: stageACheck.injection_risk_score,
          injectionSignals: stageACheck.injection_signals,
          rawMessageId: messageId,
          latencyMs: stageACheck.latency_ms,
        });
        await deps.killSwitchService.recordToolOutcome({
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'read_email',
          decision: 'DENY',
          reasoningCode: stageACheck.reasoning_code,
          injectionRiskScore: stageACheck.injection_risk_score,
          runId,
        });
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: stageACheck.reasoning_code,
            rule_citation: stageACheck.rule_citation,
          },
          true
        );
      }

      const email = await deps.mailService.getActiveProvider().getMessage(messageId);
      if (!email) {
        await deps.auditLogger.record({
          runId,
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'read_email',
          decision: 'DENY',
          matchedRuleId: null,
          ruleCitation: 'Requested messageId does not exist or is inaccessible.',
          semanticCategory: null,
          confidence: 1,
          rawMessageId: messageId,
          latencyMs: 1,
        });
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: 'MESSAGE_NOT_ACCESSIBLE',
          },
          true
        );
      }

      const trace = await deps.policyEngine.evaluate(
        {
          agent,
          tool: 'read_email',
          email,
        },
        { skipRateLimit: true }
      );

      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: 'read_email',
        decision: trace.decision,
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
        injectionRiskScore: trace.injection_risk_score,
        injectionSignals: trace.injection_signals,
        rawMessageId: email.id,
        latencyMs: trace.latency_ms,
      });

      await deps.killSwitchService.recordToolOutcome({
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: 'read_email',
        decision: trace.decision,
        reasoningCode: trace.reasoning_code,
        injectionRiskScore: trace.injection_risk_score,
        runId,
      });

      if (trace.decision !== 'ALLOW') {
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: trace.reasoning_code,
            rule_citation: trace.rule_citation,
            injection_risk_score: trace.injection_risk_score,
          },
          true
        );
      }

      return jsonContent({
        email: toSafeDetail(email, trace.semantic_category),
        policy_trace: {
          matched_rule_id: trace.matched_rule_id,
          semantic_category: trace.semantic_category,
          confidence: trace.confidence,
          injection_risk_score: trace.injection_risk_score,
        },
      });
    }
  );

  async function handleOutboundOrMutation(params: {
    tool: McpToolName;
    to?: string;
    subject?: string;
    body?: string;
    threadId?: string;
    messageId?: string;
    label?: string;
    waitForApprovalMs?: number;
  }) {
    const agent = await getFreshAgent();
    const haltedReply = await checkKillSwitchForTool(agent, params.tool);
    if (haltedReply) return haltedReply;

    const runId = getRunId();
    const provider = deps.mailService.getActiveProvider();

    let contextEmail: EphemeralEmail | null = null;
    if (params.messageId) {
      contextEmail = await provider.getMessage(params.messageId);
      if (!contextEmail && params.tool !== 'delete_email') {
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: 'TARGET_MESSAGE_NOT_ACCESSIBLE',
          },
          true
        );
      }
    } else if (params.threadId) {
      const list = await provider.listMessages(undefined, 50);
      contextEmail = list.find((m) => m.threadId === params.threadId) ?? null;
    }

    const trace = await deps.policyEngine.evaluate({
      agent,
      tool: params.tool,
      email: contextEmail,
      outbound:
        params.to !== undefined || params.subject !== undefined || params.body !== undefined
          ? { to: params.to, subject: params.subject, body: params.body }
          : undefined,
    });

    if (trace.decision === 'DENY') {
      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        decision: 'DENY',
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
        injectionRiskScore: trace.injection_risk_score,
        injectionSignals: trace.injection_signals,
        rawMessageId: params.messageId ?? params.threadId ?? null,
        latencyMs: trace.latency_ms,
      });

      await deps.killSwitchService.recordToolOutcome({
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        decision: 'DENY',
        reasoningCode: trace.reasoning_code,
        injectionRiskScore: trace.injection_risk_score,
        runId,
      });

      return jsonContent(
        {
          error: 'SIFTVANE_POLICY_DENIED',
          decision: 'DENY',
          stage: trace.stage,
          reasoning_code: trace.reasoning_code,
          rule_citation: trace.rule_citation,
          injection_risk_score: trace.injection_risk_score,
        },
        true
      );
    }

    if (trace.decision === 'PENDING_APPROVAL') {
      const approval = await deps.approvalService.createApproval({
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        payload: {
          tool: params.tool,
          to: params.to,
          subject: params.subject,
          body: params.body,
          threadId: params.threadId,
          messageId: params.messageId,
          label: params.label,
        },
      });

      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        decision: 'PENDING_APPROVAL',
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
        injectionRiskScore: trace.injection_risk_score,
        injectionSignals: trace.injection_signals,
        approvalId: approval.id,
        rawMessageId: params.messageId ?? params.threadId ?? approval.id,
        latencyMs: trace.latency_ms,
      });

      if (params.waitForApprovalMs && params.waitForApprovalMs > 0) {
        const outcome = await deps.approvalService.waitForResolution(
          approval.id,
          Math.min(params.waitForApprovalMs, 30_000)
        );
        if (outcome && outcome.approval.status === 'APPROVED') {
          return jsonContent({
            status: 'APPROVED',
            approval_id: approval.id,
            resolved_by: outcome.approval.resolved_by,
            result: outcome.executionResult,
          });
        }
        if (outcome && outcome.approval.status !== 'PENDING') {
          return jsonContent(
            {
              status: outcome.approval.status,
              approval_id: approval.id,
              resolved_by: outcome.approval.resolved_by,
            },
            true
          );
        }
      }

      return jsonContent({
        status: 'PENDING_APPROVAL',
        approval_id: approval.id,
        expires_at: approval.expires_at,
        rule_citation: trace.rule_citation,
        delivery_status: approval.delivery_status,
        message: 'Human approval required before executing this action.',
      });
    }

    const dispatchHalt = await checkKillSwitchForTool(agent, params.tool);
    if (dispatchHalt) return dispatchHalt;
    if (!deps.mailService.legacyMutationAllowed()) {
      return jsonContent({ error: 'USE_INBOX_EXECUTOR', decision: 'DENY' }, true);
    }
    let result: unknown;
    if (params.tool === 'create_draft') {
      result = await provider.createDraft({
        to: params.to ?? '',
        subject: params.subject ?? '',
        body: params.body ?? '',
        threadId: params.threadId,
      });
    } else if (params.tool === 'send_email') {
      result = await provider.sendMessage({
        to: params.to ?? '',
        subject: params.subject ?? '',
        body: params.body ?? '',
        threadId: params.threadId,
      });
    } else if (params.tool === 'archive_email' && params.messageId) {
      result = await provider.archiveMessage(params.messageId);
    } else if (params.tool === 'apply_label' && params.messageId && params.label) {
      result = await provider.applyLabel(params.messageId, params.label);
    } else if (params.tool === 'delete_email') {
      return jsonContent(
        {
          error: 'SIFTVANE_POLICY_DENIED',
          decision: 'DENY',
          reasoning_code: 'DELETE_DISABLED_AT_GATEWAY',
          rule_citation: 'Permanent email deletion is disabled at the Siftvane MCP gateway.',
        },
        true
      );
    }

    await deps.auditLogger.record({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: params.tool,
      decision: 'ALLOW',
      matchedRuleId: trace.matched_rule_id,
      ruleCitation: trace.rule_citation,
      semanticCategory: trace.semantic_category,
      confidence: trace.confidence,
      injectionRiskScore: trace.injection_risk_score,
      injectionSignals: trace.injection_signals,
      rawMessageId: params.messageId ?? params.threadId ?? null,
      latencyMs: trace.latency_ms,
    });

    await deps.killSwitchService.recordToolOutcome({
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: params.tool,
      decision: 'ALLOW',
      reasoningCode: trace.reasoning_code,
      injectionRiskScore: trace.injection_risk_score,
      runId,
    });

    return jsonContent({
      status: 'EXECUTED',
      result,
    });
  }

  server.registerTool(
    'create_draft',
    {
      description: 'Create an email draft subject to Siftvane policy rules and HITL review gates.',
      inputSchema: {
        to: z.string().min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
        threadId: z.string().optional(),
        waitForApprovalMs: z.number().int().min(0).max(30000).optional(),
      },
    },
    async (args) => handleOutboundOrMutation({ tool: 'create_draft', ...args })
  );

  server.registerTool(
    'send_email',
    {
      description:
        'Send an email. Deterministically blocked when Never-Send rules are active; otherwise subject to HITL approval.',
      inputSchema: {
        to: z.string().min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
        threadId: z.string().optional(),
        waitForApprovalMs: z.number().int().min(0).max(30000).optional(),
      },
    },
    async (args) => handleOutboundOrMutation({ tool: 'send_email', ...args })
  );

  server.registerTool(
    'archive_email',
    {
      description: 'Archive a permitted email message, subject to mutation & HITL rules.',
      inputSchema: {
        messageId: z.string().min(1),
        waitForApprovalMs: z.number().int().min(0).max(30000).optional(),
      },
    },
    async (args) => handleOutboundOrMutation({ tool: 'archive_email', ...args })
  );

  server.registerTool(
    'apply_label',
    {
      description: 'Apply a label to a permitted email message.',
      inputSchema: {
        messageId: z.string().min(1),
        label: z.string().min(1),
        waitForApprovalMs: z.number().int().min(0).max(30000).optional(),
      },
    },
    async (args) => handleOutboundOrMutation({ tool: 'apply_label', ...args })
  );

  server.registerTool(
    'delete_email',
    {
      description:
        'Delete an email permanently. Deterministically blocked when Never-Delete or default-deny rules apply.',
      inputSchema: {
        messageId: z.string().min(1),
      },
    },
    async (args) => handleOutboundOrMutation({ tool: 'delete_email', ...args })
  );

  server.registerTool(
    'save_itinerary_artifact',
    {
      description:
        'Write a scoped itinerary or digest deliverable (.md, .json, .ics) into Siftvane artifacts workspace after outbound secret checks.',
      inputSchema: {
        filename: z.string().min(1),
        content: z.string().min(1),
      },
    },
    async ({ filename, content }) => {
      const agent = await getFreshAgent();
      const haltedReply = await checkKillSwitchForTool(agent, 'save_itinerary_artifact');
      if (haltedReply) return haltedReply;

      const runId = getRunId();
      const safeBase = path.basename(filename);
      if (
        safeBase !== filename ||
        !/^[a-zA-Z0-9._-]+\.(md|json|ics|txt)$/.test(safeBase)
      ) {
        await deps.auditLogger.record({
          runId,
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'save_itinerary_artifact',
          decision: 'DENY',
          matchedRuleId: 'artifact_path_guard',
          ruleCitation: 'Blocked invalid artifact filename or path traversal attempt.',
          semanticCategory: null,
          confidence: 1,
          latencyMs: 1,
        });
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: 'INVALID_ARTIFACT_FILENAME',
          },
          true
        );
      }

      const trace = await deps.policyEngine.evaluate({
        agent,
        tool: 'save_itinerary_artifact',
        outbound: { subject: safeBase, body: content },
      });

      if (trace.decision !== 'ALLOW') {
        await deps.auditLogger.record({
          runId,
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'save_itinerary_artifact',
          decision: 'DENY',
          matchedRuleId: trace.matched_rule_id,
          ruleCitation: trace.rule_citation,
          semanticCategory: trace.semantic_category,
          confidence: trace.confidence,
          injectionRiskScore: trace.injection_risk_score,
          injectionSignals: trace.injection_signals,
          rawMessageId: safeBase,
          latencyMs: trace.latency_ms,
        });
        await deps.killSwitchService.recordToolOutcome({
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'save_itinerary_artifact',
          decision: 'DENY',
          reasoningCode: trace.reasoning_code,
          injectionRiskScore: trace.injection_risk_score,
          runId,
        });
        return jsonContent(
          {
            error: 'SIFTVANE_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: trace.reasoning_code,
            rule_citation: trace.rule_citation,
          },
          true
        );
      }

      await fs.mkdir(deps.artifactsDir, { recursive: true });
      const dispatchHalt = await checkKillSwitchForTool(agent, 'save_itinerary_artifact');
      if (dispatchHalt) return dispatchHalt;
      if (!deps.mailService.legacyMutationAllowed()) return jsonContent({ error: 'USE_INBOX_EXECUTOR', decision: 'DENY' }, true);
      const targetPath = path.join(deps.artifactsDir, safeBase);
      await fs.writeFile(targetPath, content, 'utf8');

      await deps.auditLogger.record({
        runId,
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: 'save_itinerary_artifact',
        decision: 'ALLOW',
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: 'itinerary_artifact',
        confidence: 1,
        rawMessageId: safeBase,
        latencyMs: trace.latency_ms,
      });

      return jsonContent({
        status: 'EXECUTED',
        filename: safeBase,
        path: targetPath,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }
  );

  return server;
}

function mcpCredential(request: FastifyRequest): string | undefined {
  // The MCP endpoints have no query parameters for authentication or tool arguments.
  const [route, query] = request.url.split('?', 2);
  if (query && (route !== '/mcp/messages' || [...new URLSearchParams(query).keys()].some((name) => name !== 'sessionId'))) return undefined;
  const authorization = request.headers.authorization;
  const key = request.headers['x-api-key'];
  if (authorization !== undefined && !/^Bearer [\w-]+$/i.test(authorization)) return undefined;
  if (key !== undefined && (typeof key !== 'string' || !/^[\w-]+$/.test(key))) return undefined;
  const bearer = authorization?.slice('Bearer '.length);
  if (bearer && key && bearer !== key) return undefined;
  return bearer ?? key;
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  const streamableSessions = new Map<
    string,
    {
      agentId: string;
      transport: StreamableHTTPServerTransport;
      server: McpServer;
      setRunId: (id: string | null) => void;
    }
  >();
  const sseSessions = new Map<
    string,
    {
      agentId: string;
      transport: SSEServerTransport;
      server: McpServer;
      setRunId: (id: string | null) => void;
    }
  >();

  async function authenticateRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AgentRecord | null> {
    const token = mcpCredential(request);
    if (!token) {
      reply.code(401).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: send the Siftvane token in Authorization or x-api-key.',
        },
        id: null,
      });
      return null;
    }

    const agent = await deps.agentService.authenticateBearerToken(token);
    if (!agent) {
      reply.code(401).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: invalid or revoked Siftvane agent token.',
        },
        id: null,
      });
      return null;
    }
    return agent;
  }

  async function rejectIfHalted(
    agent: AgentRecord,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<boolean> {
    if (!deps.killSwitchService.isHalted(agent.id)) return false;
    const ks = deps.killSwitchService.getState();
    const runIdHeader = request.headers['x-siftvane-run-id'] ?? request.headers['x-clam-run-id'];
    const runId = typeof runIdHeader === 'string' && runIdHeader.trim() ? runIdHeader.trim() : null;

    await deps.auditLogger.record({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: 'mcp.transport',
      decision: 'DENY',
      matchedRuleId: 'kill_switch',
      ruleCitation: `Rejected HTTP 423 Locked: Kill Switch engaged (${ks.reason ?? 'HALTED'}).`,
      semanticCategory: 'kill_switch',
      confidence: 1,
      latencyMs: 1,
    });

    reply.code(423).send({
      jsonrpc: '2.0',
      error: {
        code: -32023,
        message: 'KILL_SWITCH_ENGAGED',
        data: {
          code: 'KILL_SWITCH_ENGAGED',
          status: ks.status,
          reason: ks.reason,
          engaged_at: ks.engaged_at,
        },
      },
      id: null,
    });
    return true;
  }

  function hijackWithCors(reply: FastifyReply): void {
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) {
        reply.raw.setHeader(k, v as string | string[] | number);
      }
    }
    reply.hijack();
  }

  function extractRunId(request: FastifyRequest): string | null {
    const hdr = request.headers['x-siftvane-run-id'] ?? request.headers['x-clam-run-id'];
    return typeof hdr === 'string' && hdr.trim() ? hdr.trim() : null;
  }

  // Primary Streamable HTTP endpoint (supports both stateful MCP sessions AND stateless one-shot JSON-RPC)
  const handleMcpHttp = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = mcpCredential(request);
    let owner: string;
    let makeServer: (getRunId: () => string | null) => McpServer;
    const kind = token ? mcpTokenKind(token) : undefined;
    if (token && (kind === 'pod' || kind === 'inbox')) {
      const podGrant = kind === 'pod' ? deps.inbox.handoffs.authenticate(token) : undefined;
      const grant = kind === 'inbox' ? deps.accounts.authenticateMcp(token) : undefined;
      if (!grant && !podGrant) return reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid inbox token.' } });
      owner = podGrant ? 'pod:' + podGrant.tokenId : 'inbox:' + grant!.tokenId;
      makeServer = () => podGrant ? createPodMcpServer(deps.inbox, podGrant, deps.stagingDir) : createInboxMcpServer({ ...deps, grant: grant! });
    } else {
      const agent = await authenticateRequest(request, reply);
      if (!agent || await rejectIfHalted(agent, request, reply)) return;
      owner = 'agent:' + agent.id;
      makeServer = (getRunId) => createAgentMcpServer(agent, deps, getRunId);
    }

    const reqRunId = extractRunId(request);
    const sessionId = request.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const session = streamableSessions.get(sessionId);
      if (!session || session.agentId !== owner) {
        reply.code(404).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'MCP session not found for this agent' },
          id: null,
        });
        return;
      }
      session.setRunId(reqRunId);
      hijackWithCors(reply);
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    const bodyObj = request.body as { method?: string } | undefined;
    const isInitialize = request.method === 'POST' && bodyObj?.method === 'initialize';

    if (isInitialize && !(request.headers['x-siftvane-stateless'] ?? request.headers['x-clam-stateless'])) {
      let generatedId = '';
      let activeRunId: string | null = reqRunId;
      const setRunId = (id: string | null) => {
        activeRunId = id;
      };
      const server = makeServer(() => activeRunId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => {
          generatedId = crypto.randomUUID();
          return generatedId;
        },
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          streamableSessions.set(sid, { agentId: owner, transport, server, setRunId });
        },
        onsessionclosed: (sid) => {
          streamableSessions.delete(sid);
        },
      });
      transport.onclose = () => {
        if (generatedId) streamableSessions.delete(generatedId);
      };
      await server.connect(transport);
      hijackWithCors(reply);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    if (request.method === 'GET') {
      reply.code(400).send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'GET /mcp requires Mcp-Session-Id header, or use GET /mcp/sse for SSE fallback.',
        },
        id: null,
      });
      return;
    }

    // Stateless JSON-RPC POST fallback (ideal for direct tools/list, tools/call & curl)
    const server = makeServer(() => reqRunId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    hijackWithCors(reply);
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  app.get('/mcp', handleMcpHttp);
  app.post('/mcp', handleMcpHttp);
  app.delete('/mcp', handleMcpHttp);

  // Legacy SSE fallback transport
  app.get('/mcp/sse', async (request, reply) => {
    const agent = await authenticateRequest(request, reply);
    if (!agent) return;
    if (await rejectIfHalted(agent, request, reply)) return;

    let activeRunId: string | null = extractRunId(request);
    const setRunId = (id: string | null) => {
      activeRunId = id;
    };
    hijackWithCors(reply);
    const server = createAgentMcpServer(agent, deps, () => activeRunId);
    const transport = new SSEServerTransport('/mcp/messages', reply.raw);
    sseSessions.set(transport.sessionId, { agentId: agent.id, transport, server, setRunId });

    reply.raw.on('close', () => {
      sseSessions.delete(transport.sessionId);
      void server.close();
    });

    await server.connect(transport);
  });

  app.post('/mcp/messages', async (request, reply) => {
    const agent = await authenticateRequest(request, reply);
    if (!agent) return;
    if (await rejectIfHalted(agent, request, reply)) return;

    const sessionId = (request.query as { sessionId?: string }).sessionId;
    if (!sessionId) {
      reply.code(400).send({ error: 'Missing sessionId query parameter' });
      return;
    }
    const session = sseSessions.get(sessionId);
    if (!session || session.agentId !== agent.id) {
      reply.code(404).send({ error: 'SSE session not found for agent' });
      return;
    }

    session.setRunId(extractRunId(request));
    hijackWithCors(reply);
    await session.transport.handlePostMessage(request.raw, reply.raw, request.body);
  });

  app.addHook('onClose', async () => {
    for (const s of streamableSessions.values()) {
      await s.transport.close().catch(() => {});
      await s.server.close().catch(() => {});
    }
    streamableSessions.clear();
    for (const s of sseSessions.values()) {
      await s.transport.close().catch(() => {});
      await s.server.close().catch(() => {});
    }
    sseSessions.clear();
  });
}

export function buildMcpConfigSnippets(params: {
  publicUrl: string;
  agent: AgentRecord;
  tokenPlaceholder?: string;
}) {
  const mcpUrl = `${params.publicUrl.replace(/\/$/, '')}/mcp`;
  const sseUrl = `${params.publicUrl.replace(/\/$/, '')}/mcp/sse`;
  const token = params.tokenPlaceholder || 'siftvane_ag_<YOUR_AGENT_TOKEN>';
  const safeSlug = params.agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    claude_desktop: {
      filename: 'claude_desktop_config.json',
      content: JSON.stringify(
        {
          mcpServers: {
            [`siftvane-${safeSlug}`]: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                mcpUrl,
                '--header',
                `Authorization: Bearer ${token}`,
              ],
            },
          },
        },
        null,
        2
      ),
    },
    cursor_codex: {
      filename: 'mcp.json / .codex/config.toml',
      content: JSON.stringify(
        {
          mcpServers: {
            [`siftvane-${safeSlug}`]: {
              type: 'http',
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        },
        null,
        2
      ),
    },
    gemini_cli: {
      filename: '~/.gemini/settings.json',
      content: JSON.stringify(
        {
          mcpServers: {
            [`siftvane-${safeSlug}`]: {
              httpUrl: mcpUrl,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        },
        null,
        2
      ),
    },
    curl_http: {
      filename: 'curl (Streamable HTTP JSON-RPC)',
      content: [
        `# 1. List allowed MCP tools`,
        `curl -s -X POST "${mcpUrl}" \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        ``,
        `# 2. Call list_emails (silent semantic & injection filtering applied)`,
        `curl -s -X POST "${mcpUrl}" \\`,
        `  -H "Authorization: Bearer ${token}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_emails","arguments":{"maxResults":10}}}'`,
        ``,
        `# Legacy SSE endpoint: ${sseUrl}`,
      ].join('\n'),
    },
  };
}
