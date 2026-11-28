import type { McpCaller, Mode } from '../inbox/contracts.js';
import type { InboxEngine, MissionContext, MissionOutcome } from '../inbox/engine.js';
import { interactivePlan, planFromProgram, statedSchedule, type CompiledIntent, type WorkflowPlan } from './planner.js';
import { llmPlan, type PlannerCall } from './llmPlanner.js';
import { ProgramExecutor } from './programExecutor.js';
import type { AgentRecord, AgentState, PlatformService, ScheduleMode, Service, SourceCli } from './service.js';
import { RecipeService } from './recipes.js';
import { namespace, WorkspaceOps } from './workspaceOps.js';

const errorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,70}$/.test(message) ? message : 'AGENT_STEP_FAILED';
};

export function modeFor(inboxId: string): Mode {
  return inboxId === 'sandbox' ? 'sandbox' : `live:${inboxId}`;
}

export function detectSourceCli(clientName: string | undefined, explicit?: string): SourceCli {
  if (explicit && ['codex-cli', 'claude-code', 'cursor', 'cline', 'web'].includes(explicit)) return explicit as SourceCli;
  const name = (clientName ?? '').toLowerCase();
  if (/codex/.test(name)) return 'codex-cli';
  if (/claude/.test(name)) return 'claude-code';
  if (/cursor/.test(name)) return 'cursor';
  if (/cline/.test(name)) return 'cline';
  return 'other_mcp';
}

/**
 * Executes persistent agents: compiles requests into plans, runs each plan phase as an engine mission, pauses
 * on Tier 2 approvals, resumes automatically when the operator decides, and journals every step.
 */
export class MissionRunner {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private readonly pickerPolls = new Map<string, number>();
  private closed = false;
  /** Saved recipes ("muscle memory"): learned from agent runs, replayed with no model call. */
  readonly recipes: RecipeService;

  constructor(private readonly engine: InboxEngine, private readonly platform: PlatformService,
    private readonly options: { webOrigin: string; tickMs?: number }) {
    this.recipes = new RecipeService(engine, platform, this);
    engine.on('state', (state: { halted?: boolean }) => {
      if (state?.halted === true) this.platform.haltAll('KILL_SWITCH_ENGAGED');
    });
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 400);
    this.timer.unref();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.queue.catch(() => undefined);
  }

  /** Serializes platform missions and waits for the engine's single-writer lease to be free. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const deadline = Date.now() + 30_000;
      while (this.engine.busy()) {
        if (Date.now() > deadline) throw new Error('RUN_ALREADY_ACTIVE');
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      this.platform.recoverAgentRuns();
      if (this.engine.halted()) return;
      for (const agent of this.platform.waitingAgents()) {
        if (agent.state.phase === 'awaiting_photo_selection') await this.checkPicker(agent);
        else this.checkApprovals(agent);
      }
      this.recipes.checkApprovals();
      if (this.engine.busy()) return;
      const [due] = this.platform.dueAgents();
      if (due) await this.exclusive(() => this.runAgent(due.id));
      else await this.recipes.runDue();
    } catch {
      // A failed tick is retried on the next interval; failures are journaled per agent.
    } finally {
      this.ticking = false;
    }
  }

  /**
   * With a model configured, the model composes every agent's program itself; there are no fixed workflows on this path.
   * If the model is unreachable or cannot produce a usable plan, provisioning fails with a clear error instead of
   * quietly building a different, hard-coded agent. Without a model (offline mode) the keyword compiler is used.
   */
  async plan(instruction: string, _services: string[] | undefined, inboxId: string, calls: PlannerCall[] = []):
    Promise<{ compiled: CompiledIntent; fallback: string | null; repairs?: string[] }> {
    // The AI is the planner: there are no built-in workflows to fall back on.
    if (this.engine.agent.mode !== 'llm') throw new Error('AI_PROVIDER_REQUIRED');
    let planned: Awaited<ReturnType<typeof llmPlan>>;
    try {
      planned = await llmPlan(this.engine.agent, instruction, inboxId === 'sandbox' ? 'sandbox' : 'live', undefined, (call) => calls.push(call));
    } catch (error) {
      throw new Error(/^PLANNER_(?:OUTPUT|PROGRAM)_INVALID$/.test(errorCode(error)) ? 'AI_PLAN_UNUSABLE' : 'AI_MODEL_UNAVAILABLE');
    }
    const stated = statedSchedule(instruction);
    const scheduleMode = planned.scheduleMode === 'one_shot' && stated !== 'one_shot' ? stated : planned.scheduleMode;
    return { compiled: planFromProgram({ program: planned.program, name: planned.name, scheduleMode, reasoning: planned.reasoning },
      instruction, 'llm-planner'), fallback: null, repairs: planned.issues };
  }

  async provision(input: {
    userId: string; inboxId: string; instruction: string; agentName?: string; services?: string[]; scheduleMode?: ScheduleMode;
    intervalSeconds?: number; autoSwitch: boolean; sourceCli: SourceCli; switchedBy: 'cli_auto' | 'web_ui';
    authorize?: (compiled: CompiledIntent, services: Service[]) => void;
  }) {
    this.engine.guard();
    const calls: PlannerCall[] = [];
    const { compiled, fallback, repairs } = await this.plan(input.instruction, input.services, input.inboxId, calls);
    this.engine.guard();
    const services = [...new Set([...compiled.services, ...(input.services ?? []).filter((value): value is Service =>
      ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'].includes(value))])];
    const scheduleMode = input.scheduleMode ?? compiled.scheduleMode;
    input.authorize?.(compiled, services);
    const agent = this.platform.createAgent({
      userId: input.userId, inboxId: input.inboxId, name: input.agentName?.trim() || compiled.name, goal: input.instruction,
      sourceCli: input.sourceCli, services, plan: compiled.plan, scheduleMode,
      intervalSeconds: input.intervalSeconds ?? (scheduleMode === 'continuous' ? 300 : scheduleMode === 'daily' ? 86_400 : scheduleMode === 'weekly' ? 604_800 : null),
      state: calls.length ? { planning_calls: calls } : undefined,
    });
    this.platform.log({ userId: input.userId, agentId: agent.id, runId: null, service: 'system', action: 'compile_plan',
      input: input.instruction, output: `${compiled.plan.planner}: ${compiled.plan.template} · ${compiled.plan.steps.length} steps · ${services.join(', ')}` +
        (fallback ? ` (LLM planner unavailable: ${fallback})` : '') + (compiled.plan.params.reasoning ? ` — ${compiled.plan.params.reasoning}` : ''),
      verdict: 'ALLOW_TIER_0', ruleId: fallback ? 'PLAN_FALLBACK_DETERMINISTIC' : 'PLAN_VALIDATED', verified: true });
    if (repairs?.length) {
      this.platform.log({ userId: input.userId, agentId: agent.id, runId: null, service: 'policy', action: 'plan_steps_rejected',
        input: `${repairs.length} model step(s) failed validation or grounding`, output: repairs.join(' | '),
        verdict: 'BLOCKED', ruleId: 'PLAN_STEP_REJECTED', verified: true });
    }
    const switched = input.autoSwitch ? this.platform.switchAgent(input.userId, agent.id, input.switchedBy,
      input.switchedBy === 'cli_auto' ? `Auto-switched after ${input.sourceCli} provisioned "${agent.name}"` : `Created "${agent.name}" from the web console`) : null;
    setImmediate(() => void this.tick());
    return {
      agent_id: agent.id, name: agent.name, status: agent.status, switched: Boolean(switched),
      plan_summary: {
        template: compiled.plan.template, planner: compiled.plan.planner, services, schedule_mode: scheduleMode,
        reasoning: compiled.plan.params.reasoning ?? null,
        steps: compiled.plan.steps.map((step) => `${step.service}.${step.action}${step.tier_hint === 2 ? ' [Tier 2 approval]' : ''}: ${step.label}`),
      },
      dashboard_url: this.options.webOrigin.replace(/\/$/, '') + '/#agents',
    };
  }

  interactiveAgent(userId: string, inboxId: string, sourceCli: SourceCli) {
    const existing = this.platform.agents(userId).find((agent) => agent.state.interactive && agent.inbox_id === inboxId && agent.source_cli === sourceCli);
    if (existing) return existing;
    return this.platform.createAgent({ userId, inboxId, name: `Interactive ${sourceCli} session`, goal: 'Direct Workspace tool calls from a connected CLI agent.',
      sourceCli, services: ['drive', 'docs', 'sheets', 'photos'], plan: interactivePlan(), scheduleMode: 'one_shot', intervalSeconds: null,
      state: { interactive: true, phase: 'interactive' }, startNow: false });
  }

  /** Runs one direct MCP Workspace operation as a traced, policy-gated mission attributed to the caller. */
  direct<T>(agent: AgentRecord, caller: McpCaller, work: (ops: WorkspaceOps, context: MissionContext) => Promise<T>) {
    return this.exclusive(async () => {
      let result: T | undefined;
      const mode = modeFor(agent.inbox_id);
      const handle = this.engine.mission('mcp.' + caller.tool, mode, async (context) => {
        const ops = new WorkspaceOps(context, this.engine.workspace(mode), this.platform,
          { userId: agent.user_id, agentId: agent.id, inboxId: agent.inbox_id }, this.engine.stagingRoot());
        result = await work(ops, context);
      }, caller);
      const run = await handle.done;
      if (run.status !== 'COMPLETED') throw new Error(run.error ?? 'INBOX_OPERATION_FAILED');
      this.platform.updateAgent(agent.id, { run_count: agent.run_count + 1, last_run_at: new Date().toISOString() });
      return { result: result as T, run_id: run.id };
    });
  }

  stopAgent(agent: AgentRecord, cancel: boolean) {
    const updated = this.platform.updateAgentIfStatus(agent.id, agent.status, () => ({
      status: cancel ? 'archived' : 'paused', next_run_at: null,
    }));
    if (!updated) throw new Error('AGENT_STATUS_CHANGED');
    if (updated.state.running_run_id) {
      this.engine.stopMission(updated.state.running_run_id, cancel ? 'AGENT_RUN_CANCELLED' : 'AGENT_RUN_PAUSED');
    }
    if (cancel) {
      const mode = modeFor(updated.inbox_id);
      const activeRunApprovals = updated.state.running_run_id ? this.engine.store.approvals(mode, updated.state.running_run_id)
        .map((approval) => approval.approval_id) : [];
      for (const id of new Set([...updated.state.pending_approvals, ...activeRunApprovals])) {
        const approval = this.engine.store.approval(id);
        if (approval?.status === 'PENDING') this.engine.store.updateApproval({ ...approval, status: 'REJECTED' });
      }
    }
    return updated;
  }

  private checkApprovals(agent: AgentRecord) {
    const statuses = agent.state.pending_approvals.map((id) => {
      const approval = this.engine.store.approval(id);
      // An approval that lapsed without a decision counts as declined, so the agent never hangs in "Needs Approval".
      if (approval?.status === 'PENDING' && Date.parse(approval.expires_at) <= Date.now()) {
        this.engine.store.updateApproval({ ...approval, status: 'EXPIRED' });
        return 'EXPIRED';
      }
      return approval?.status ?? 'FAILED';
    });
    if (statuses.some((status) => status === 'PENDING' || status === 'EXECUTING')) return;
    const log = (action: string, output: string, verified: boolean) => this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: null,
      service: agent.state.phase === 'awaiting_review' ? 'policy' : 'gmail', action, input: agent.state.pending_approvals.join(', '), output,
      verdict: 'GATE_TIER_2', ruleId: 'OPERATOR_DECISION', verified });
    log('review_resolved', `${statuses.filter((status) => status !== 'EXPIRED').length} flagged item(s) resolved by the operator` +
      (statuses.includes('EXPIRED') ? `, ${statuses.filter((status) => status === 'EXPIRED').length} expired` : '') + '.', true);
    this.platform.updateAgentIfStatus(agent.id, 'input_required', (current) => ({
      ...(current.state.last_error ? { status: 'paused', next_run_at: null } : this.afterRun(current)),
      state: { ...current.state, phase: 'start', pending_approvals: [] },
    }));
  }

  /** Resumes a photo agent once the user has picked receipts in Google Photos (polled at most every 5 s). */
  private async checkPicker(agent: AgentRecord) {
    if (Date.now() - (this.pickerPolls.get(agent.id) ?? 0) < 5000) return;
    this.pickerPolls.set(agent.id, Date.now());
    const adapter = this.engine.workspace(modeFor(agent.inbox_id));
    if (!await adapter.photoPickerReady?.().catch(() => false)) return;
    this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: null, service: 'photos', action: 'photo_selection_received',
      input: 'Google Photos Picker', output: 'The operator selected photos; resuming the agent.', verdict: 'GATE_TIER_2', ruleId: 'OPERATOR_PHOTO_SELECTION', verified: true });
    this.platform.updateAgentIfStatus(agent.id, 'input_required', (current) => ({ status: 'active', next_run_at: new Date().toISOString(),
      state: { ...current.state, phase: 'start', picker_uri: null } }));
  }

  private afterRun(agent: AgentRecord): Pick<AgentRecord, 'status' | 'next_run_at'> {
    if (agent.schedule_mode === 'one_shot') return { status: 'completed', next_run_at: null };
    const seconds = agent.interval_seconds ?? (agent.schedule_mode === 'daily' ? 86_400 : agent.schedule_mode === 'weekly' ? 604_800 : 300);
    return { status: 'active', next_run_at: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  async runAgent(id: string) {
    const candidate = this.platform.agent(id);
    if (!candidate || candidate.status !== 'active' || !candidate.next_run_at || candidate.next_run_at > new Date().toISOString()) return null;
    const mode = modeFor(candidate.inbox_id);
    let claimed = false;
    let pending: string[] = [];
    let phase = candidate.state.phase;
    let notes: string[] = [];
    let observed: AgentState['observed'];
    const failures = new Set<string>();
    const track = async (action: Promise<MissionOutcome>) => {
      const outcome = await action;
      if (outcome.approvalId) pending.push(outcome.approvalId);
      if (!outcome.verified && outcome.decision !== 'APPROVAL_REQUIRED') {
        failures.add(outcome.decision === 'BLOCKED' ? outcome.ruleId : outcome.outcome || 'ACTION_UNVERIFIED');
      }
      return outcome;
    };
    const checkControl = () => {
      if (!claimed) return;
      const current = this.platform.agent(id);
      if (!current || current.status === 'archived') throw new Error('AGENT_RUN_CANCELLED');
      if (current.status !== 'active') throw new Error('AGENT_RUN_PAUSED');
    };
    const handle = this.engine.mission('agent:' + id, mode, async (context) => {
      // The engine holds the shared lease before the agent's due state is changed.
      const agent = this.platform.claimDueAgent(id, context.runId);
      if (!agent) return;
      claimed = true;
      phase = agent.state.phase;
      for (const call of agent.state.planning_calls ?? []) {
        context.recordModel({ event: 'AGENT_MODEL_CALL', phase: call.phase, status: call.status }, call.usage);
      }
      context.record('PLAN', { agent_id: agent.id, agent_name: agent.name, template: agent.workflow_plan.template, phase,
        planner: agent.workflow_plan.planner, steps: agent.workflow_plan.steps.map((step) => step.id) });
      const tracked: MissionContext = { ...context, execute: (action) => track(context.execute(action)),
        queueBatch: (actions, reason) => track(context.queueBatch(actions, reason)) };
      const ops = new WorkspaceOps(tracked, this.engine.workspace(mode), this.platform,
        { userId: agent.user_id, agentId: agent.id, inboxId: agent.inbox_id }, this.engine.stagingRoot());
      const result = await this.execute(agent, tracked, ops);
      pending = [...new Set([...pending, ...result.pending])];
      phase = result.phase;
      notes = result.notes;
      observed = (result as { observed?: AgentState['observed'] }).observed;
      if (failures.size) {
        notes = [...notes, ...failures];
        context.record('CHECK', { outcome: 'REQUESTED_ACTION_UNVERIFIED', errors: [...failures] });
        throw new Error(failures.values().next().value);
      }
    }, undefined, checkControl);
    const run = await handle.done;
    if (!claimed) return null;
    const failure = run.error ?? failures.values().next().value ?? null;
    if (failure) {
      this.platform.log({ userId: candidate.user_id, agentId: id, runId: run.id, service: 'system',
        action: 'mission_failed', input: phase, output: failure,
        verdict: 'BLOCKED', ruleId: failure, verified: false });
    }
    const activeApprovals = [...new Set(pending)].filter((approvalId) => this.engine.store.approval(approvalId));
    this.platform.finishAgentRun(id, run.id, (agent) => {
      const state = { ...agent.state, phase, pending_approvals: activeApprovals, last_error: failure, notes: [...new Set([...notes, ...failures])],
        ...(observed ? { observed } : {}),
        ...(phase !== agent.state.phase ? { phase_started_at: new Date().toISOString() } : {}) };
      if (run.status === 'HALTED' || this.engine.halted()) return { status: 'halted', next_run_at: null, state };
      // A watcher (continuous/daily/weekly) keeps watching while its review items wait: each new email gets its own
      // approval (drafts are deduplicated per message), and every still-open approval stays listed on the agent.
      if ((phase === 'start' || phase === 'awaiting_review') && agent.schedule_mode !== 'one_shot' && run.status === 'COMPLETED' && !failure) {
        const open = [...new Set([...agent.state.pending_approvals, ...activeApprovals])]
          .filter((approvalId) => this.engine.store.approval(approvalId)?.status === 'PENDING');
        return { ...this.afterRun(agent), state: { ...state, phase: 'start', pending_approvals: open } };
      }
      if (activeApprovals.length) return { status: 'input_required', next_run_at: null,
        state: { ...state, phase: phase === 'start' ? 'awaiting_review' : phase } };
      if (run.status !== 'COMPLETED' || failure) return { status: 'paused', next_run_at: null, state };
      if (phase === 'awaiting_photo_selection') return { status: 'input_required', next_run_at: null,
        state: { ...state, picker_uri: notes.find((note) => note.startsWith('https://')) ?? null } };
            return { ...this.afterRun(agent), state };
    });
    return run;
  }

  private execute(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    if (agent.workflow_plan.template !== 'generic') throw new Error('AGENT_PLAN_RETIRED');
    return new ProgramExecutor(this.engine, this.platform, agent, context, ops).run();
  }
}

export type { WorkflowPlan };
export { namespace };
