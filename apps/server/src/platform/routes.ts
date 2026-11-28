import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { sandboxMcpOwner, type GoogleAccounts } from '../auth/google.js';
import type { SiftvaneConfig } from '../config.js';
import type { InboxEngine } from '../inbox/engine.js';
import type { SandboxWorkspaceAdapter } from '../workspace/adapters.js';
import { sandboxClock } from '../sandbox/seed.js';
import { recipeComputedSchema, recipeRuleSchema } from './recipes.js';
import type { MissionRunner } from './runner.js';
import { services, type PlatformService } from './service.js';

const agentId = z.object({ id: z.string().uuid() });

export function viewer(request: FastifyRequest, accounts: GoogleAccounts, config: SiftvaneConfig) {
  const session = accounts.session(request.headers.cookie);
  return {
    userId: session?.user_id ?? sandboxMcpOwner,
    inboxId: config.inboxLive && session && session.inbox_id !== 'sandbox' ? session.inbox_id : 'sandbox',
    signedIn: Boolean(session),
  };
}

/** Website system-of-record API for users, agents, agent switches, execution logs, and Workspace artifacts. */
export function registerPlatformRoutes(app: FastifyInstance, deps: {
  inbox: InboxEngine; platform: PlatformService; missions: MissionRunner; accounts: GoogleAccounts; config: SiftvaneConfig;
}) {
  const { inbox, platform, missions, accounts, config } = deps;
  app.register(async (router) => {
    router.addHook('preHandler', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && origin !== config.webOrigin && origin !== `http://127.0.0.1:${config.webPort}`) {
        return reply.code(403).send({ error: 'CROSS_ORIGIN_REQUEST' });
      }
      reply.header('Cache-Control', 'no-store');
    });
    router.setErrorHandler((error, _request, reply) => {
      const message = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PLATFORM_OPERATION_FAILED';
      const code = error instanceof ZodError ? 400 : message === 'INBOX_HALTED' ? 423 : /^AI_(?:MODEL_UNAVAILABLE|PLAN_UNUSABLE)$/.test(message) ? 503 :
        /NOT_AVAILABLE/.test(message) ? 404 :
        /ALREADY|INVALID|NOT_ALLOWED|NOT_READY|NOT_WAITING|NOT_ESCALATED|DUPLICATE|UNKNOWN_FIELD|SANDBOX_ONLY|AGENT_(?:RUN_STOPPING|STATUS_CHANGED)/.test(message) ? 409 : 500;
      reply.code(code).send({ error: error instanceof ZodError ? 'INVALID_INPUT' : message });
    });

    router.get('/api/inbox/platform/me', async (request) => {
      const who = viewer(request, accounts, config);
      return { ...platform.profile(who.userId, who.inboxId), signed_in: who.signedIn, halted: inbox.halted() };
    });
    router.get('/api/inbox/platform/agents', async (request) => {
      const who = viewer(request, accounts, config);
      return { agents: platform.agents(who.userId), active_agent_id: platform.activeAgentId(who.userId) };
    });
    router.post('/api/inbox/platform/agents', async (request) => {
      const who = viewer(request, accounts, config);
      const input = z.object({
        instruction: z.string().trim().min(4).max(4000), name: z.string().trim().max(80).optional(),
        services: z.array(z.enum(services)).max(6).optional(), schedule_mode: z.enum(['one_shot', 'continuous', 'daily', 'weekly']).optional(),
      }).strict().parse(request.body);
      return await missions.provision({ userId: who.userId, inboxId: who.inboxId, instruction: input.instruction, agentName: input.name,
        services: input.services, scheduleMode: input.schedule_mode, autoSwitch: true, sourceCli: 'web', switchedBy: 'web_ui' });
    });
    router.post('/api/inbox/platform/agents/:id/switch', async (request) => {
      const who = viewer(request, accounts, config);
      const { id } = agentId.parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).strict().parse(request.body ?? {});
      return platform.switchAgent(who.userId, id, 'web_ui', reason || 'Switched from the web console');
    });
    router.post('/api/inbox/platform/agents/:id/:action', async (request) => {
      const who = viewer(request, accounts, config);
      const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['pause', 'resume', 'cancel']) }).parse(request.params);
      const agent = platform.ownedAgent(who.userId, id);
      if (action === 'pause') {
        if (!['active', 'input_required'].includes(agent.status)) throw new Error('AGENT_NOT_RUNNING');
        return missions.stopAgent(agent, false);
      }
      if (action === 'cancel') return missions.stopAgent(agent, true);
      if (!['paused', 'halted', 'completed'].includes(agent.status)) throw new Error('AGENT_ALREADY_ACTIVE');
      if (agent.state.running_run_id) throw new Error('AGENT_RUN_STOPPING');
      inbox.guard();
      const updated = platform.updateAgentIfStatus(id, agent.status, (current) => {
        if (current.state.running_run_id) throw new Error('AGENT_RUN_STOPPING');
        const waiting = current.state.pending_approvals.length > 0;
        return { status: waiting ? 'input_required' : 'active', next_run_at: waiting ? null : new Date().toISOString(),
          state: current.status === 'completed' && current.workflow_plan.template !== 'vendor_rfq' ?
            { ...current.state, phase: 'start' } : current.state };
      });
      if (!updated) throw new Error('AGENT_STATUS_CHANGED');
      setImmediate(() => void missions.tick());
      return updated;
    });
    router.get('/api/inbox/platform/switches', async (request) => ({ switches: platform.switches(viewer(request, accounts, config).userId) }));
    router.get('/api/inbox/platform/logs', async (request) => {
      const query = z.object({ agent_id: z.string().uuid().optional(), service: z.enum([...services, 'policy', 'system']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional() }).strict().parse(request.query);
      return { logs: platform.logs(viewer(request, accounts, config).userId, { agentId: query.agent_id, service: query.service, limit: query.limit }) };
    });
    router.get('/api/inbox/platform/artifacts', async (request) => {
      const { agent_id } = z.object({ agent_id: z.string().uuid().optional() }).strict().parse(request.query);
      return { artifacts: platform.artifacts(viewer(request, accounts, config).userId, agent_id) };
    });
    /* ----------------------------- Saved recipes ("muscle memory") ----------------------------- */
    const recipes = missions.recipes;
    const recipeId = z.object({ id: z.string().uuid() });
    const rules = z.array(recipeRuleSchema).max(12);
    const computed = z.array(recipeComputedSchema).max(12);
    router.get('/api/inbox/platform/recipes', async (request) => {
      const who = viewer(request, accounts, config);
      return { recipes: recipes.list(who.userId), learnable: recipes.learnable(who.userId), model_mode: inbox.agent.mode };
    });
    router.post('/api/inbox/platform/recipes', async (request) => {
      const who = viewer(request, accounts, config);
      const input = z.object({ agent_id: z.string().uuid(), name: z.string().trim().max(80).optional() }).strict().parse(request.body);
      return { recipe: await recipes.learn(who.userId, input.agent_id, input.name) };
    });
    router.get('/api/inbox/platform/recipes/:id', async (request) => {
      const who = viewer(request, accounts, config);
      return recipes.detail(who.userId, recipeId.parse(request.params).id);
    });
    router.patch('/api/inbox/platform/recipes/:id', async (request) => {
      const who = viewer(request, accounts, config);
      const input = z.object({ name: z.string().trim().min(1).max(80).optional(), rules: rules.optional(), computed: computed.optional(),
        interval_seconds: z.number().int().min(60).max(604_800).optional() }).strict().parse(request.body);
      return { recipe: recipes.update(who.userId, recipeId.parse(request.params).id, input) };
    });
    router.post('/api/inbox/platform/recipes/:id/:action', async (request) => {
      const who = viewer(request, accounts, config);
      const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['backtest', 'enable', 'disable', 'run', 'archive']) }).parse(request.params);
      if (action === 'backtest') return { recipe: await recipes.backtest(who.userId, id) };
      if (action === 'enable' || action === 'disable') return { recipe: recipes.setEnabled(who.userId, id, action === 'enable') };
      if (action === 'archive') return recipes.archive(who.userId, id);
      return { result: await recipes.runNow(who.userId, id), ...recipes.detail(who.userId, id) };
    });
    router.post('/api/inbox/platform/recipes/:id/items/:message/:action', async (request) => {
      const who = viewer(request, accounts, config);
      const { id, message, action } = z.object({ id: z.string().uuid(), message: z.string().regex(/^[\w.:@-]{1,160}$/),
        action: z.enum(['approve', 'decline', 'escalate']) }).parse(request.params);
      if (action === 'escalate') return await recipes.escalate(who.userId, id, message);
      return await recipes.decideItem(who.userId, id, message, action === 'approve');
    });
    // $0 sandbox only: drop a test email into the sandbox inbox to see a recipe (and its rules) react to new mail.
    router.post('/api/inbox/platform/sandbox/messages', async (request) => {
      const who = viewer(request, accounts, config);
      if (who.inboxId !== 'sandbox') throw new Error('SANDBOX_ONLY');
      inbox.guard();
      const input = z.object({
        from: z.string().trim().email().max(120).transform((value) => value.toLowerCase()),
        subject: z.string().trim().min(1).max(150).regex(/^[^\r\n]+$/), text: z.string().trim().min(1).max(4000),
      }).strict().parse(request.body);
      const count = Number((inbox.store.sqlite.prepare("SELECT count(*) AS n FROM inbox_sandbox_messages WHERE id LIKE 'test-%'").get() as { n: number }).n);
      const id = `test-${count + 1}-${randomUUID().slice(0, 8)}`;
      const received = new Date(Date.parse(sandboxClock) + (count + 1) * 60_000).toISOString();
      const message = { id, threadId: id, from: input.from, subject: input.subject, text: input.text, receivedAt: received, labels: ['INBOX'], attachmentNames: [], verifiedSender: true };
      inbox.store.sqlite.prepare("INSERT INTO inbox_sandbox_messages VALUES (?, 'workspace', ?)").run(id, JSON.stringify(message));
      return { message_id: id, received_at: received };
    });

    router.get('/api/inbox/platform/artifacts/:id', async (request, reply) => {
      const who = viewer(request, accounts, config);
      const { id } = agentId.parse(request.params);
      const row = platform.registry.byId(id);
      if (!row || row.user_id !== who.userId) return reply.code(404).send({ error: 'ARTIFACT_NOT_AVAILABLE' });
      if (row.inbox_id !== 'sandbox') return { artifact: row, preview: null, open_url: row.url };
      const adapter = inbox.workspace('sandbox') as SandboxWorkspaceAdapter;
      return { artifact: row, preview: await adapter.preview?.(row.logical_key) ?? null, open_url: null };
    });
  });
}
