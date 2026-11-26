import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { sandboxMcpOwner, type GoogleAccounts } from '../auth/google.js';
import type { ClamConfig } from '../config.js';
import type { InboxEngine } from '../inbox/engine.js';
import type { SandboxWorkspaceAdapter } from '../workspace/adapters.js';
import type { MissionRunner } from './runner.js';
import { services, type PlatformService } from './service.js';

const agentId = z.object({ id: z.string().uuid() });

export function viewer(request: FastifyRequest, accounts: GoogleAccounts, config: ClamConfig) {
  const session = accounts.session(request.headers.cookie);
  return {
    userId: session?.user_id ?? sandboxMcpOwner,
    inboxId: config.inboxLive && session && session.inbox_id !== 'sandbox' ? session.inbox_id : 'sandbox',
    signedIn: Boolean(session),
  };
}

/** Website system-of-record API for users, agents, agent switches, execution logs, and Workspace artifacts. */
export function registerPlatformRoutes(app: FastifyInstance, deps: {
  inbox: InboxEngine; platform: PlatformService; missions: MissionRunner; accounts: GoogleAccounts; config: ClamConfig;
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
      const code = error instanceof ZodError ? 400 : message === 'INBOX_HALTED' ? 423 : /NOT_AVAILABLE/.test(message) ? 404 :
        /ALREADY|INVALID|NOT_ALLOWED/.test(message) ? 409 : 500;
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
        return platform.updateAgent(id, { status: 'paused', next_run_at: null });
      }
      if (action === 'cancel') return platform.updateAgent(id, { status: 'archived', next_run_at: null });
      if (!['paused', 'halted', 'completed'].includes(agent.status)) throw new Error('AGENT_ALREADY_ACTIVE');
      inbox.guard();
      const waiting = agent.state.pending_approvals.length > 0;
      const updated = platform.updateAgent(id, { status: waiting ? 'input_required' : 'active',
        next_run_at: waiting ? null : new Date().toISOString(),
        state: agent.status === 'completed' ? { ...agent.state, phase: agent.workflow_plan.template === 'vendor_rfq' ? agent.state.phase : 'start' } : agent.state });
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
