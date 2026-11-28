import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpTokenKind } from '@siftvane/shared';
import type { GoogleAccounts } from '../auth/google.js';
import type { InboxEngine } from '../inbox/engine.js';
import type { MissionRunner } from '../platform/runner.js';
import type { PlatformService } from '../platform/service.js';
import { createInboxMcpServer } from './google.js';
import { createPodMcpServer } from './pod.js';

export interface McpDeps {
  accounts: GoogleAccounts;
  inbox: InboxEngine;
  platform: PlatformService;
  missions: MissionRunner;
  calendarId: string;
  stagingDir: string;
  verificationRedirects: Record<string, string[]>;
}

/** Bearer token (or X-Api-Key) from a request; malformed or conflicting credentials count as none. */
function mcpCredential(request: FastifyRequest): string | undefined {
  // The MCP endpoint takes no query parameters for authentication or tool arguments.
  if (request.url.includes('?')) return undefined;
  const authorization = request.headers.authorization;
  const key = request.headers['x-api-key'];
  if (authorization !== undefined && !/^Bearer [\w-]+$/i.test(authorization)) return undefined;
  if (key !== undefined && (typeof key !== 'string' || !/^[\w-]+$/.test(key))) return undefined;
  const bearer = authorization?.slice('Bearer '.length);
  if (bearer && key && bearer !== key) return undefined;
  return bearer ?? key;
}

const rpcError = (reply: FastifyReply, status: number, code: number, message: string, data?: unknown) =>
  reply.code(status).send({ jsonrpc: '2.0', id: null, error: { code, message, ...(data ? { data } : {}) } });

/**
 * POST/GET/DELETE /mcp over Streamable HTTP, for mailbox tokens (siftvane_inbox_…) and agent-pod tokens (siftvane_pod_…).
 * Each token gets its own scoped tool server; sessions are bound to the token that opened them.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  const sessions = new Map<string, { owner: string; transport: StreamableHTTPServerTransport; server: McpServer }>();

  const hijack = (reply: FastifyReply) => {
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value as string | string[] | number);
    }
    reply.hijack();
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = mcpCredential(request);
    const kind = token ? mcpTokenKind(token) : undefined;
    const podGrant = token && kind === 'pod' ? deps.inbox.handoffs.authenticate(token) : undefined;
    const grant = token && kind === 'inbox' ? deps.accounts.authenticateMcp(token) : undefined;
    if (!grant && !podGrant) return rpcError(reply, 401, -32001, 'Invalid or missing MCP token.');
    if (deps.inbox.halted()) return rpcError(reply, 423, -32023, 'KILL_SWITCH_ENGAGED', { code: 'KILL_SWITCH_ENGAGED' });
    const owner = podGrant ? 'pod:' + podGrant.tokenId : 'inbox:' + grant!.tokenId;
    const makeServer = () => podGrant ? createPodMcpServer(deps.inbox, podGrant, deps.stagingDir) : createInboxMcpServer({ ...deps, grant: grant! });

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.owner !== owner) return rpcError(reply, 404, -32001, 'MCP session not found for this token');
      hijack(reply);
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    const isInitialize = request.method === 'POST' && (request.body as { method?: string } | undefined)?.method === 'initialize';
    if (isInitialize && !(request.headers['x-siftvane-stateless'] ?? request.headers['x-clam-stateless'])) {
      let generated = '';
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => (generated = crypto.randomUUID()),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => { sessions.set(sid, { owner, transport, server }); },
        onsessionclosed: (sid) => { sessions.delete(sid); },
      });
      transport.onclose = () => { if (generated) sessions.delete(generated); };
      await server.connect(transport);
      hijack(reply);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    if (request.method === 'GET') return rpcError(reply, 400, -32000, 'GET /mcp requires an Mcp-Session-Id header.');

    // Stateless one-shot JSON-RPC (tools/list, tools/call from curl or simple clients).
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    hijack(reply);
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  app.get('/mcp', handle);
  app.post('/mcp', handle);
  app.delete('/mcp', handle);

  app.addHook('onClose', async () => {
    for (const session of sessions.values()) {
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
    }
    sessions.clear();
  });
}
