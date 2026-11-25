import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { inboxPolicySchema } from '@clam/shared';
import { z, ZodError } from 'zod';
import type { ClamConfig } from '../config.js';
import type { KillSwitchService } from '../killswitch/service.js';
import type { TraceStep } from './contracts.js';
import type { InboxEngine } from './engine.js';

const equal = (left: string, right: string) =>
  timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());

export function registerInboxRoutes(app: FastifyInstance, inbox: InboxEngine, config: ClamConfig,
  kill: KillSwitchService, lockfile?: string) {
  app.register(async (router) => {
    router.addHook('preHandler', async (request, reply) => {
      const origin = request.headers.origin;
      const allowedOrigin = origin === config.webOrigin || origin === `http://127.0.0.1:${config.webPort}`;
      const provided = request.headers['x-clam-operator-token'];
      if ((origin && !allowedOrigin) || (config.inboxLive && (!config.operatorToken ||
          typeof provided !== 'string' || !equal(provided, config.operatorToken)))) {
        return reply.code(403).send({ error: 'OPERATOR_ACCESS_REQUIRED' });
      }
    });

    router.setErrorHandler((error, _request, reply) => {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      const code = message === 'INBOX_HALTED' ? 423 : error instanceof ZodError ? 400 :
        /NOT_AVAILABLE|NOT_PENDING|EXPIRED|RUN_ALREADY_ACTIVE|NO_ROLLBACK|Policy changed/.test(message) ? 409 : 500;
      reply.code(code).send({ error: error instanceof ZodError ? 'INVALID_INPUT' : message,
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

    router.get('/api/inbox/briefing', async () => inbox.briefing());
    router.get('/api/inbox/briefing/:id', async (request, reply) => {
      const result = inbox.briefing(runId(request));
      return result ?? reply.code(404).send({ error: 'RUN_NOT_FOUND' });
    });
    router.get('/api/inbox/runs', async () => ({
      runs: inbox.store.runs(inbox.activeMode()).map((run) => ({ ...run, changesCount: inbox.store.countChanges(run.id) })),
    }));
    router.post('/api/inbox/runs', async (request, reply) => {
      const { wait } = z.object({ wait: z.boolean().optional() }).strict().parse(request.body ?? {});
      const handle = inbox.start();
      return wait ? { run: await handle.done } : reply.code(202).send({ run: handle.run });
    });
    router.get('/api/inbox/runs/:id/trace', async (request, reply) => {
      const id = runId(request);
      if (!inbox.store.run(id)) return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
      reply.header('Content-Disposition', `inline; filename="${id}.json"`);
      return inbox.store.trace(id);
    });
    router.post('/api/inbox/runs/:id/rollback', async (request, reply) => {
      const { wait, actionIds } = z.object({
        wait: z.boolean().optional(), actionIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(6).optional(),
      }).strict().parse(request.body ?? {});
      const handle = inbox.rollback(runId(request), actionIds);
      return wait ? { run: await handle.done } : reply.code(202).send({ run: handle.run });
    });

    router.get('/api/inbox/approvals', async () => ({ approvals: inbox.store.approvals(inbox.activeMode()) }));
    router.post('/api/inbox/approvals/:id', async (request) => {
      const { id } = z.object({ id: z.string().regex(/^approval_[a-f0-9]{24}_v\d+$/) }).parse(request.params);
      const fields = z.object({
        approve: z.boolean(),
        calendarEdit: z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict().optional(),
        edit: z.object({ subject: z.string().trim().min(1).max(180), text: z.string().trim().min(1).max(2000) }).strict().optional(),
      }).strict().parse(request.body);
      const handle = inbox.resolveApproval(id, fields.approve, fields.edit, fields.calendarEdit);
      const run = handle ? await handle.done : null;
      return { approval: inbox.store.approval(id), run };
    });

    router.get('/api/inbox/calendar', async () => inbox.calendar());
    router.get('/api/inbox/calendar.ics', async (_request, reply) => reply
      .type('text/calendar; charset=utf-8').header('Content-Disposition', 'attachment; filename="clam-calendar.ics"')
      .send(await inbox.ics()));
    router.get('/api/inbox/bills', async () => ({ bills: inbox.briefing()!.digest.upcoming_bills_summary }));
    router.get('/api/inbox/bills.csv', async (_request, reply) => {
      const records = inbox.briefing()!.digest.upcoming_bills_summary;
      const csv = (value: unknown) => {
        let text = value === undefined || value === null ? '' : String(value);
        if (/^\s*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const columns = ['vendor', 'invoice', 'amount', 'currency', 'due', 'type', 'priceHike', 'duplicateOrSpoofed'];
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="clam-bills.csv"')
        .send([columns.join(','), ...records.map((record) => columns.map((column) => csv(record?.[column])).join(','))].join('\r\n') + '\r\n');
    });

    router.get('/api/inbox/policy', async () => ({ mode: inbox.activeMode(), ...inbox.store.policy(inbox.activeMode()) }));
    router.post('/api/inbox/policy/preview', async (request) => inbox.preview(request.body));
    router.put('/api/inbox/policy', async (request) => {
      const { version, policy } = z.object({ version: z.number().int().min(1), policy: inboxPolicySchema }).parse(request.body);
      return inbox.store.savePolicy(inbox.activeMode(), version, policy);
    });
    router.get('/api/inbox/schedule', async () => inbox.store.schedule());
    router.put('/api/inbox/schedule', async (request) => inbox.setSchedule(request.body));
    router.post('/api/inbox/kill-switch', haltControl);
    router.post('/api/kill-switch', haltControl);

    router.get('/api/inbox/events', async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', Connection: 'keep-alive',
      });
      const emit = (event: string, value: unknown, id?: string) => {
        if (reply.raw.destroyed) return;
        reply.raw.write((id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      };
      const step = (data: TraceStep) => emit('step', data, data.id);
      const state = (data: unknown) => emit('state', data);
      inbox.on('step', step);
      inbox.on('state', state);
      emit('connected', { halted: inbox.halted() });
      const last = request.headers['last-event-id'];
      if (typeof last === 'string') {
        const [id, ordinal] = last.split(':');
        if (z.string().uuid().safeParse(id).success && Number.isInteger(Number(ordinal))) {
          for (const item of inbox.store.trace(id).steps.slice(Number(ordinal))) step(item);
        }
      }
      const keepalive = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': pulse\n\n');
      }, 15000);
      reply.raw.on('close', () => {
        clearInterval(keepalive);
        inbox.off('step', step);
        inbox.off('state', state);
      });
    });
  });
}
