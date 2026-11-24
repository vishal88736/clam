import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type {
  AgentRecord,
  EphemeralEmail,
  McpToolName,
  SafeEmailDetail,
  SafeEmailSummary,
} from '@clam/shared';
import type { AgentService } from '../agents/service.js';
import type { ApprovalService } from '../approvals/service.js';
import type { AuditLogger } from '../audit/logger.js';
import type { MailService } from '../mail/service.js';
import type { PolicyEngine } from '../policy/engine.js';

export interface McpDeps {
  agentService: AgentService;
  policyEngine: PolicyEngine;
  mailService: MailService;
  approvalService: ApprovalService;
  auditLogger: AuditLogger;
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

export function createAgentMcpServer(agentSnapshot: AgentRecord, deps: McpDeps): McpServer {
  const server = new McpServer({
    name: 'clam-email-firewall',
    version: '1.0.0',
  });

  const getFreshAgent = async (): Promise<AgentRecord> => {
    return (await deps.agentService.getAgent(agentSnapshot.id)) ?? agentSnapshot;
  };

  async function handleListOrSearch(
    toolName: 'list_emails' | 'search_emails',
    query?: string,
    maxResults = 20
  ) {
    const agent = await getFreshAgent();
    const start = performance.now();
    const gateTrace = await deps.policyEngine.evaluate({
      agent,
      tool: toolName,
    });

    if (gateTrace.decision === 'DENY') {
      await deps.auditLogger.record({
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: 'DENY',
        matchedRuleId: gateTrace.matched_rule_id,
        ruleCitation: gateTrace.rule_citation,
        semanticCategory: gateTrace.semantic_category,
        confidence: gateTrace.confidence,
        latencyMs: gateTrace.latency_ms,
      });
      return jsonContent(
        {
          error: 'CLAM_POLICY_DENIED',
          decision: 'DENY',
          reasoning_code: gateTrace.reasoning_code,
          rule_citation: gateTrace.rule_citation,
        },
        true
      );
    }

    const provider = deps.mailService.getActiveProvider();
    const candidates = await provider.listMessages(query, maxResults);

    // SILENT FILTERING: Evaluate each ephemeral message in RAM and drop non-matching emails without leaking count or metadata.
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
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: toolName,
        decision: itemTrace.decision,
        matchedRuleId: itemTrace.matched_rule_id,
        ruleCitation: itemTrace.rule_citation,
        semanticCategory: itemTrace.semantic_category,
        confidence: itemTrace.confidence,
        rawMessageId: email.id,
        latencyMs: itemTrace.latency_ms,
      });

      if (itemTrace.decision === 'ALLOW') {
        permitted.push(toSafeSummary(email, itemTrace.semantic_category));
      }
    }

    if (candidates.length === 0) {
      await deps.auditLogger.record({
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

    return jsonContent({
      emails: permitted,
      returned: permitted.length,
    });
  }

  server.registerTool(
    'list_emails',
    {
      description:
        'List emails permitted by your Clam policy. Unauthorized or sensitive emails are silently stripped.',
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
        'Search emails permitted by your Clam policy. Unauthorized or sensitive emails are silently stripped.',
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
        'Read a single email by messageId. Always re-verifies deterministic and semantic policy rules.',
      inputSchema: {
        messageId: z.string().min(1).describe('Email message ID'),
      },
    },
    async ({ messageId }) => {
      const agent = await getFreshAgent();
      const stageACheck = await deps.policyEngine.evaluate({
        agent,
        tool: 'read_email',
      });

      if (stageACheck.decision === 'DENY') {
        await deps.auditLogger.record({
          agentId: agent.id,
          agentName: agent.name,
          mcpTool: 'read_email',
          decision: 'DENY',
          matchedRuleId: stageACheck.matched_rule_id,
          ruleCitation: stageACheck.rule_citation,
          semanticCategory: null,
          confidence: 1,
          rawMessageId: messageId,
          latencyMs: stageACheck.latency_ms,
        });
        return jsonContent(
          {
            error: 'CLAM_POLICY_DENIED',
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
            error: 'CLAM_POLICY_DENIED',
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
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: 'read_email',
        decision: trace.decision,
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
        rawMessageId: email.id,
        latencyMs: trace.latency_ms,
      });

      if (trace.decision !== 'ALLOW') {
        return jsonContent(
          {
            error: 'CLAM_POLICY_DENIED',
            decision: 'DENY',
            reasoning_code: trace.reasoning_code,
            rule_citation: trace.rule_citation,
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
    const provider = deps.mailService.getActiveProvider();

    let contextEmail: EphemeralEmail | null = null;
    if (params.messageId) {
      contextEmail = await provider.getMessage(params.messageId);
      if (!contextEmail) {
        return jsonContent(
          {
            error: 'CLAM_POLICY_DENIED',
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
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        decision: 'DENY',
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
        rawMessageId: params.messageId ?? params.threadId ?? null,
        latencyMs: trace.latency_ms,
      });
      return jsonContent(
        {
          error: 'CLAM_POLICY_DENIED',
          decision: 'DENY',
          stage: trace.stage,
          reasoning_code: trace.reasoning_code,
          rule_citation: trace.rule_citation,
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
        agentId: agent.id,
        agentName: agent.name,
        mcpTool: params.tool,
        decision: 'PENDING_APPROVAL',
        matchedRuleId: trace.matched_rule_id,
        ruleCitation: trace.rule_citation,
        semanticCategory: trace.semantic_category,
        confidence: trace.confidence,
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

    // Allowed directly
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
    }

    await deps.auditLogger.record({
      agentId: agent.id,
      agentName: agent.name,
      mcpTool: params.tool,
      decision: 'ALLOW',
      matchedRuleId: trace.matched_rule_id,
      ruleCitation: trace.rule_citation,
      semanticCategory: trace.semantic_category,
      confidence: trace.confidence,
      rawMessageId: params.messageId ?? params.threadId ?? null,
      latencyMs: trace.latency_ms,
    });

    return jsonContent({
      status: 'EXECUTED',
      result,
    });
  }

  server.registerTool(
    'create_draft',
    {
      description: 'Create an email draft subject to Clam policy rules and HITL review gates.',
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

  return server;
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  const streamableSessions = new Map<
    string,
    { agentId: string; transport: StreamableHTTPServerTransport; server: McpServer }
  >();
  const sseSessions = new Map<
    string,
    { agentId: string; transport: SSEServerTransport; server: McpServer }
  >();

  async function authenticateRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AgentRecord | null> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: Authorization: Bearer clm_ag_<token> header required.',
        },
        id: null,
      });
      return null;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const agent = await deps.agentService.authenticateBearerToken(token);
    if (!agent) {
      reply.code(401).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: invalid or revoked Clam agent token.',
        },
        id: null,
      });
      return null;
    }
    return agent;
  }

  function hijackWithCors(reply: FastifyReply): void {
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) {
        reply.raw.setHeader(k, v as string | string[] | number);
      }
    }
    reply.hijack();
  }

  // Primary Streamable HTTP endpoint (supports both stateful MCP sessions AND stateless one-shot JSON-RPC)
  const handleMcpHttp = async (request: FastifyRequest, reply: FastifyReply) => {
    const agent = await authenticateRequest(request, reply);
    if (!agent) return;

    const sessionId = request.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const session = streamableSessions.get(sessionId);
      if (!session || session.agentId !== agent.id) {
        reply.code(404).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'MCP session not found for this agent' },
          id: null,
        });
        return;
      }
      hijackWithCors(reply);
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    const bodyObj = request.body as { method?: string } | undefined;
    const isInitialize = request.method === 'POST' && bodyObj?.method === 'initialize';

    // If client calls initialize with Accept SSE or standard MCP Streamable HTTP session
    if (isInitialize && !request.headers['x-clam-stateless']) {
      let generatedId = '';
      const server = createAgentMcpServer(agent, deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => {
          generatedId = crypto.randomUUID();
          return generatedId;
        },
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          streamableSessions.set(sid, { agentId: agent.id, transport, server });
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
    const server = createAgentMcpServer(agent, deps);
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

    hijackWithCors(reply);
    const server = createAgentMcpServer(agent, deps);
    const transport = new SSEServerTransport('/mcp/messages', reply.raw);
    sseSessions.set(transport.sessionId, { agentId: agent.id, transport, server });

    reply.raw.on('close', () => {
      sseSessions.delete(transport.sessionId);
      void server.close();
    });

    await server.connect(transport);
  });

  app.post('/mcp/messages', async (request, reply) => {
    const agent = await authenticateRequest(request, reply);
    if (!agent) return;

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
  const token = params.tokenPlaceholder || 'clm_ag_<YOUR_AGENT_TOKEN>';
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
            [`clam-${safeSlug}`]: {
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
            [`clam-${safeSlug}`]: {
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
            [`clam-${safeSlug}`]: {
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
        `# 2. Call list_emails (silent semantic filtering applied)`,
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
