import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { inboxPolicySchema } from '@siftvane/shared';
import { z, ZodError } from 'zod';
import type { SiftvaneConfig } from '../config.js';
import { mcpScopes, sandboxMcpOwner, type GoogleAccounts } from '../auth/google.js';
import type { KillSwitchService } from '../killswitch/service.js';
import type { Mode, TraceStep } from './contracts.js';
import type { InboxEngine } from './engine.js';
import { capabilityCounts, threadReplay } from './replay.js';
import { podScopes } from '../handoffs/service.js';
import { podCase } from '../handoffs/sample.js';
import { completeHandoff, extractPodAttachment } from '../handoffs/workflow.js';
import type { PlatformEvent, PlatformService } from '../platform/service.js';

const equal = (left: string, right: string) =>
  timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());

export function registerInboxRoutes(app: FastifyInstance, inbox: InboxEngine, config: SiftvaneConfig,
  kill: KillSwitchService, accounts: GoogleAccounts, lockfile?: string, platform?: PlatformService) {
  app.register(async (router) => {
    const hasOperatorToken = (request: FastifyRequest) => {
      const provided = request.headers['x-siftvane-operator-token'] ?? request.headers['x-clam-operator-token'];
      return Boolean(config.operatorToken && typeof provided === 'string' && equal(provided, config.operatorToken));
    };
    const selectedMode = (request: FastifyRequest): Mode => {
      if (!config.inboxLive) return 'sandbox';
      const session = accounts.session(request.headers.cookie);
      const explicit = request.headers['x-siftvane-inbox-id'] ?? request.headers['x-clam-inbox-id'];
      if (explicit && typeof explicit === 'string' && hasOperatorToken(request)) {
        if (explicit === 'sandbox') return 'sandbox';
        if (!z.string().uuid().safeParse(explicit).success || !accounts.connection(explicit)) throw new Error('INBOX_NOT_AVAILABLE');
        return `live:${explicit}`;
      }
      return session && session.inbox_id !== 'sandbox' ? `live:${session.inbox_id}` : 'sandbox';
    };
    router.addHook('preHandler', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && origin !== config.webOrigin && origin !== `http://127.0.0.1:${config.webPort}`) {
        return reply.code(403).send({ error: 'CROSS_ORIGIN_REQUEST' });
      }
      const privileged = request.url.split('?')[0].endsWith('/kill-switch');
      if (config.inboxLive && privileged && !accounts.session(request.headers.cookie) && !hasOperatorToken(request)) {
        return reply.code(403).send({ error: 'OPERATOR_ACCESS_REQUIRED' });
      }
    });

    router.setErrorHandler((error, _request, reply) => {
      const value = error instanceof Error ? error.message : '';
      const message = /^[A-Z][A-Z0-9_]+$/.test(value) || value.startsWith('Policy changed') ? value : 'INBOX_OPERATION_FAILED';
      const code = message === 'INBOX_HALTED' ? 423 : ['OPERATOR_ACCESS_REQUIRED', 'SCOPE_UPGRADE_REQUIRED', 'MCP_SCOPE_REQUIRED', 'RECIPIENT_BLOCKLISTED'].includes(message) ? 403 : error instanceof ZodError || message === 'INVALID_BATCH_EDIT' ? 400 :
        /NOT_AVAILABLE|NOT_PENDING|EXPIRED|REAUTH_REQUIRED|RUN_ALREADY_ACTIVE|NO_ROLLBACK|Policy changed/.test(message) ? 409 : 500;
      reply.code(code).send({ error: error instanceof ZodError ? 'INVALID_INPUT' : message,
        ...(message === 'SCOPE_UPGRADE_REQUIRED' ? { action: 'Upgrade to Read + Actions in Connections.' } : {}),
        ...(error instanceof ZodError ? { issues: error.flatten() } : {}) });
    });

    const runId = (request: FastifyRequest) =>
      z.object({ id: z.string().uuid() }).parse(request.params).id;
    const haltControl = async (request: FastifyRequest) => {
      const data = z.object({ active: z.boolean(), reason: z.string().trim().min(1).max(300) }).strict().parse(request.body);
      if (data.active) {
        inbox.latch(true);
        if (lockfile) {
          await mkdir(path.dirname(lockfile), { recursive: true });
          await writeFile(lockfile, data.reason + '\n', { mode: 0o600 });
        }
        await kill.engage({ reason: data.reason, engagedBy: 'inbox_operator', triggerMode: 'manual_api' });
      } else {
        await kill.resume({ reason: data.reason, resumedBy: 'inbox_operator' });
      }
      return { halted: inbox.halted() };
    };

    const authorizePodOperator = (request: FastifyRequest) => {
      if (config.inboxLive && !accounts.session(request.headers.cookie) && !hasOperatorToken(request)) throw new Error('OPERATOR_ACCESS_REQUIRED');
    };
    const scopedInbox = z.union([z.literal('sandbox'), z.string().uuid()]);
    const roleScope = z.union([z.enum(mcpScopes), z.string().regex(/^otp:read:[a-z0-9](?:[a-z0-9.-]{0,245}[a-z0-9])?\.[a-z]{2,24}$/)]);
    const tokenOwner = (request: FastifyRequest, inboxId: string) => {
      authorizePodOperator(request);
      const session = accounts.session(request.headers.cookie);
      if (inboxId === 'sandbox') return session?.user_id ?? sandboxMcpOwner;
      if (!session || !accounts.isOwned(inboxId, session.user_id)) throw new Error('OPERATOR_ACCESS_REQUIRED');
      return session.user_id;
    };
    router.get('/api/inbox/mcp-tokens', async (request) => {
      const { inbox_id } = z.object({ inbox_id: scopedInbox }).strict().parse(request.query);
      return { tokens: accounts.listInboxTokens(tokenOwner(request, inbox_id), inbox_id) };
    });
    router.post('/api/inbox/mcp-tokens', async (request, reply) => {
      const { inbox_id, scopes } = z.object({ inbox_id: scopedInbox, scopes: z.array(roleScope).min(1).max(12) }).strict().parse(request.body);
      tokenOwner(request, inbox_id);
      const session = accounts.session(request.headers.cookie);
      reply.header('Cache-Control', 'no-store');
      return !session ? accounts.mintSandbox(scopes) : accounts.mint(session, inbox_id, scopes);
    });
    router.post('/api/inbox/mcp-tokens/:id/revoke', async (request, reply) => {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).parse(request.params);
      const { inbox_id } = z.object({ inbox_id: scopedInbox }).strict().parse(request.body);
      const revoked = accounts.revokeInboxToken(tokenOwner(request, inbox_id), inbox_id, id);
      return revoked ? { revoked } : reply.code(404).send({ error: 'MCP_TOKEN_NOT_AVAILABLE' });
    });
    router.get('/api/inbox/agent-inboxes', async () => ({ inboxes: inbox.handoffs.members() }));
    router.get('/api/inbox/capabilities', async (request) => capabilityCounts(inbox.store, selectedMode(request)));
    router.get('/api/inbox/threads', async (request, reply) => {
      const { run_id } = z.object({ run_id: z.string().uuid().optional() }).strict().parse(request.query);
      const mode = selectedMode(request);
      if (run_id && inbox.store.run(run_id)?.mode !== mode) return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
      return { threads: threadReplay(inbox.store, mode, run_id) };
    });
    router.post('/api/inbox/agent-inboxes/:id/token', async (request, reply) => {
      authorizePodOperator(request);
      const { id } = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).parse(request.params);
      const { scopes } = z.object({ scopes: z.array(z.enum(podScopes)).min(1).max(3) }).strict().parse(request.body);
      reply.header('Cache-Control', 'no-store');
      return inbox.handoffs.mint(id, scopes);
    });
    router.post('/api/inbox/agent-inboxes/demo', async (request) => {
      authorizePodOperator(request);
      inbox.guard();
      const thread = podCase.threadId + '-' + randomUUID().slice(0, 8);
      const attachment = await extractPodAttachment(inbox, 'triage', podCase.messageId, thread);
      const first = await inbox.handoff('triage', {
        from_inbox_id: 'triage', to_inbox_id: 'executor', thread_id: thread,
        task_summary: 'Reconcile the duplicate shipping charge on invoice NS-482',
        structured_payload: { source_message: podCase.messageId, extracted_csv: attachment.text },
        attachment_ids: [attachment.attachment_id],
      });
      if (first.status !== 'DELIVERED') throw new Error('HANDOFF_POST_CONDITION_FAILED');
      const evidence = await extractPodAttachment(inbox, 'executor', podCase.messageId, thread);
      const invoice = /^NS-482,Duplicate shipping charge,USD,18\.00$/m.test(evidence.text);
      if (!invoice) throw new Error('HANDOFF_ARTIFACT_UNVERIFIED');
      const second = await inbox.handoff('executor', {
        from_inbox_id: 'executor', to_inbox_id: 'triage', thread_id: thread,
        task_summary: 'Return the verified reply draft for the credit memo',
        structured_payload: { draft: 'We confirmed the duplicate shipping charge on NS-482. Please apply the USD 18.00 credit.', evidence: evidence.attachment_id },
      });
      if (second.status !== 'DELIVERED') throw new Error('HANDOFF_POST_CONDITION_FAILED');
      await completeHandoff(inbox, 'executor', String(first.handoff_id));
      return { thread_id: thread, hops: [first, second] };
    });

    router.get('/api/inbox/connection', async (request) => {
      const status = accounts.status(accounts.session(request.headers.cookie));
      const account = status.inboxes.find((row) => row.id === status.active_inbox_id);
      return { ...status, connected: Boolean(account), email: account?.email ?? null, agent_mode: inbox.agent.mode };
    });

    router.get('/api/inbox/briefing', async (request) => inbox.briefing(undefined, selectedMode(request)));
    router.get('/api/inbox/briefing/:id', async (request, reply) => {
      const id = runId(request);
      const result = inbox.store.run(id)?.mode === selectedMode(request) ? inbox.briefing(id) : null;
      return result ?? reply.code(404).send({ error: 'RUN_NOT_FOUND' });
    });
    router.get('/api/inbox/runs', async (request) => ({
      runs: inbox.store.runs(selectedMode(request)).map((run) => ({ ...run, changesCount: inbox.store.countChanges(run.id) })),
    }));
    router.get('/api/inbox/runs/:id/trace', async (request, reply) => {
      const id = runId(request);
      if (inbox.store.run(id)?.mode !== selectedMode(request)) return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
      reply.header('Content-Disposition', `inline; filename="${id}.json"`);
      return inbox.store.trace(id);
    });
    router.post('/api/inbox/runs/:id/rollback', async (request, reply) => {
      const { wait, actionIds } = z.object({
        wait: z.boolean().optional(), actionIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(6).optional(),
      }).strict().parse(request.body ?? {});
      const id = runId(request);
      if (inbox.store.run(id)?.mode !== selectedMode(request)) return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
      const handle = inbox.rollback(id, actionIds);
      return wait ? { run: await handle.done } : reply.code(202).send({ run: handle.run });
    });

    router.get('/api/inbox/approvals', async (request) => {
      const { priority } = z.object({ priority: z.enum(['high', 'medium', 'low']).optional() }).parse(request.query);
      return { approvals: inbox.store.approvals(selectedMode(request)).filter((item) => !priority || item.priority === priority) };
    });
    router.post('/api/inbox/approvals/:id', async (request) => {
      const { id } = z.object({ id: z.string().regex(/^approval_[a-f0-9]{24}_v\d+$/) }).parse(request.params);
      const mailEdit = z.object({ subject: z.string().trim().min(1).max(180).regex(/^[^\r\n\0]+$/), text: z.string().trim().min(1).max(2000) }).strict();
      const fields = z.object({
        approve: z.boolean(),
        calendarEdit: z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict().optional(),
        edit: mailEdit.optional(),
        batchEdits: z.array(mailEdit).min(1).max(10).optional(),
      }).strict().parse(request.body);
      const item = inbox.store.approval(id);
      if (item?.mode !== selectedMode(request)) throw new Error('APPROVAL_NOT_AVAILABLE');
      if (item.triggered_rule_id === 'AGENT_LOOP_PREVENTED') authorizePodOperator(request);
      const handle = inbox.resolveApproval(id, fields.approve, fields.edit, fields.calendarEdit, fields.batchEdits);
      const run = handle ? await handle.done : null;
      return { approval: inbox.store.approval(id), run };
    });

    router.get('/api/inbox/policy', async (request) => ({ mode: selectedMode(request), ...inbox.store.policy(selectedMode(request)) }));
    router.put('/api/inbox/policy', async (request) => {
      const { version, policy } = z.object({ version: z.number().int().min(1), policy: inboxPolicySchema }).parse(request.body);
      return inbox.store.savePolicy(selectedMode(request), version, policy);
    });
    router.post('/api/inbox/kill-switch', haltControl);
    router.post('/api/kill-switch', haltControl);

    router.get('/api/inbox/events', async (request, reply) => {
      const mode = selectedMode(request);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', Connection: 'keep-alive',
      });
      const emit = (event: string, value: unknown, id?: string) => {
        if (reply.raw.destroyed) return;
        reply.raw.write((id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      };
      const stillAuthorized = () => {
        if (mode === 'sandbox' || hasOperatorToken(request)) return true;
        return accounts.session(request.headers.cookie)?.inbox_id === mode.slice(5);
      };
      const step = (data: TraceStep) => {
        if (!stillAuthorized()) return reply.raw.end();
        if (inbox.store.run(data.run_id)?.mode === mode) emit('step', data, data.id);
      };
      const state = () => {
        if (!stillAuthorized()) return reply.raw.end();
        emit('state', { halted: inbox.halted() });
      };
      const warning = (event: { run_id: string; rule_id: string }) => {
        if (!stillAuthorized()) return reply.raw.end();
        if (inbox.store.run(event.run_id)?.mode === mode) emit('warning', event);
      };
      const viewerId = accounts.session(request.headers.cookie)?.user_id ?? sandboxMcpOwner;
      const platformEvent = (event: PlatformEvent) => {
        if (!stillAuthorized()) return reply.raw.end();
        if (event.user_id === viewerId) emit('platform', { type: event.type, data: event.data });
      };
      platform?.on('event', platformEvent);
      inbox.on('warning', warning);
      inbox.on('step', step);
      inbox.on('state', state);
      emit('connected', { halted: inbox.halted(), mode: inbox.agent.mode, provider: inbox.agent.provider, model: inbox.agent.model });
      const last = request.headers['last-event-id'];
      if (typeof last === 'string') {
        const [id, ordinal] = last.split(':');
        if (z.string().uuid().safeParse(id).success && Number.isInteger(Number(ordinal)) && inbox.store.run(id)?.mode === mode) {
          for (const item of inbox.store.trace(id).steps.slice(Number(ordinal))) step(item);
        }
      }
      const keepalive = setInterval(() => {
        if (!stillAuthorized()) return reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.write(': pulse\n\n');
      }, 15000);
      reply.raw.on('close', () => {
        clearInterval(keepalive);
        inbox.off('step', step);
        inbox.off('warning', warning);
        inbox.off('state', state);
        platform?.off('event', platformEvent);
      });
    });
  });
}
