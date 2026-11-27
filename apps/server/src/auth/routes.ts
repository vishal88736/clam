import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { SiftvaneConfig } from '../config.js';
import { writeControlTrace } from '../inbox/controlTrace.js';
import type { InboxEngine } from '../inbox/engine.js';
import { cookie, flowCookie, GoogleAccounts, legacyFlowCookie, legacySessionCookie, mcpScopes, sessionCookie } from './google.js';

const id = z.string().uuid();
const scope = z.union([z.enum(mcpScopes), z.string().regex(/^otp:read:[a-z0-9](?:[a-z0-9.-]{0,245}[a-z0-9])?\.[a-z]{2,24}$/)]);
const errors: Record<string, number> = {
  GOOGLE_AUTH_NOT_CONFIGURED: 503, OPERATOR_SESSION_REQUIRED: 401, INBOX_NOT_AVAILABLE: 404,
  MCP_SCOPE_REQUIRED: 403,
  INVALID_GOOGLE_STATE: 400, GOOGLE_SCOPE_NOT_ALLOWED: 400, GOOGLE_SCOPE_BANNED: 400, GOOGLE_SCOPES_UNVERIFIED: 400,
  GOOGLE_ACCOUNT_MISMATCH: 409, GOOGLE_IDENTITY_INVALID: 400, GOOGLE_OFFLINE_CONSENT_REQUIRED: 409,
  GOOGLE_REAUTH_REQUIRED: 409, GOOGLE_TOKEN_EXCHANGE_FAILED: 502, GOOGLE_TOKENS_INVALID: 502,
};

export function registerGoogleAuthRoutes(app: FastifyInstance, accounts: GoogleAccounts, config: SiftvaneConfig, inbox: InboxEngine) {
  app.register(async (router) => {
    router.addHook('preHandler', async (request, reply) => {
      reply.headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      const origin = request.headers.origin;
      const expected = new URL(config.googleRedirectUri).origin;
      if (origin && ![config.webOrigin, expected].includes(origin)) {
        return reply.code(403).send({ error: 'CROSS_ORIGIN_REQUEST' });
      }
      if (request.method === 'POST' && !origin && request.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send({ error: 'CROSS_ORIGIN_REQUEST' });
      }
    });
    router.setErrorHandler((failure, _request, reply) => {
      const error = failure instanceof ZodError ? 'INVALID_AUTH_INPUT' : failure instanceof Error && failure.message in errors
        ? failure.message : 'GOOGLE_AUTH_UNAVAILABLE';
      return reply.code(error === 'INVALID_AUTH_INPUT' ? 400 : errors[error] ?? 502).send({ error });
    });
    const requireOperator = (request: FastifyRequest) => {
      const session = accounts.session(request.headers.cookie);
      if (!session) throw new Error('OPERATOR_SESSION_REQUIRED');
      return session;
    };

    router.get('/api/auth/session', async (request) => accounts.status(accounts.session(request.headers.cookie)));
    router.get('/api/auth/google/login', async (request, reply) => {
      const { link } = z.object({ link: z.literal('true').optional() }).strict().parse(request.query);
      const flow = accounts.begin('identity', accounts.browser(request.headers.cookie), link ? requireOperator(request) : undefined);
      return reply.header('Set-Cookie', flow.cookie).redirect(flow.url);
    });
    router.get('/api/auth/google/connect', async (request, reply) => {
      const query = z.object({ mode: z.enum(['readonly', 'readwrite', 'workspace', 'workspace_edit']), inboxId: id.optional() }).strict().parse(request.query);
      const flow = accounts.begin(query.mode, accounts.browser(request.headers.cookie), requireOperator(request), query.inboxId);
      return reply.header('Set-Cookie', flow.cookie).redirect(flow.url);
    });
    router.get('/api/auth/google/callback', async (request, reply) => {
      const query = z.object({ code: z.string().min(1).max(4096).optional(), state: z.string().min(1).max(128), error: z.string().optional() }).parse(request.query);
      if (!query.code || query.error) return reply.redirect(new URL('/settings?google=cancelled', config.webOrigin).toString());
      const result = await accounts.complete(query.code, query.state, request.headers.cookie);
      if (result.next) return reply.header('Set-Cookie', result.next.cookie).redirect(result.next.url);
      if (result.inboxId) inbox.store.policy(`live:${result.inboxId}`);
      reply.header('Set-Cookie', [cookie(flowCookie, '', 0, accounts.secure), cookie(legacyFlowCookie, '', 0, accounts.secure),
        ...(result.session ? [result.session, cookie(legacySessionCookie, '', 0, accounts.secure)] : [])]);
      return reply.redirect(new URL('/settings?google=connected', config.webOrigin).toString());
    });
    router.post('/api/auth/logout', async (request, reply) => {
      accounts.logout(accounts.session(request.headers.cookie));
      return reply.header('Set-Cookie', [sessionCookie, flowCookie, legacySessionCookie, legacyFlowCookie]
        .map((name) => cookie(name, '', 0, accounts.secure))).send({ ok: true });
    });
    router.post('/api/auth/inbox', async (request) => {
      const input = z.object({ inbox_id: z.union([id, z.literal('sandbox')]) }).strict().parse(request.body);
      accounts.select(requireOperator(request), input.inbox_id);
      return { active_inbox_id: input.inbox_id };
    });
    router.post('/api/auth/google/disconnect/:inboxId', async (request) => {
      const { inboxId } = z.object({ inboxId: id }).parse(request.params);
      const { revoke_mcp } = z.object({ revoke_mcp: z.boolean().default(true) }).strict().parse(request.body ?? {});
      const remoteRevoked = await accounts.disconnect(requireOperator(request), inboxId, revoke_mcp);
      inbox.setSchedule({ enabled: false, frequency: 'daily', intervalMinutes: 1440 }, `live:${inboxId}`);
      const auditId = await writeControlTrace(config.tracesDir, 'google.disconnect', inboxId, {
        status: 'COMPLETED', remote_revoked: remoteRevoked, mcp_tokens_revoked: revoke_mcp,
      });
      return { ok: true, remote_revoked: remoteRevoked, audit_id: auditId };
    });
    router.post('/api/auth/google/token/:inboxId', async (request) => {
      const { inboxId } = z.object({ inboxId: z.union([id, z.literal('sandbox')]) }).parse(request.params);
      const input = z.object({ scopes: z.array(scope).min(1).max(12) }).strict().parse(request.body);
      return accounts.mint(requireOperator(request), inboxId, input.scopes);
    });
  });
}
