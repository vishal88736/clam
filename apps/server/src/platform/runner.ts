import { rm } from 'node:fs/promises';
import path from 'node:path';
import { scanOutboundSecrets, scanPromptInjection } from '@siftvane/shared';
import type { InboxCalendarEvent } from '@siftvane/shared';
import { safeAttachmentBytes, stageWorkspaceAttachment } from '../inbox/attachmentWorkspace.js';
import { readAttachments } from '../inbox/attachments.js';
import type { McpCaller, Mode, SafeAction } from '../inbox/contracts.js';
import type { InboxEngine, MissionContext, MissionOutcome } from '../inbox/engine.js';
import { address, domain, stripHtml } from '../inbox/reader.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { sandboxClock, type ReaderMessage } from '../sandbox/seed.js';
import { extractPhotoDetails, type PhotoDetails } from '../workspace/photos.js';
import { sanitizeCell } from '../workspace/sanitize.js';
import { compileIntent, deterministicChoice, interactivePlan, planFromChoice, planFromProgram, type CompiledIntent, type WorkflowPlan } from './planner.js';
import { llmPlan, type PlannerCall } from './llmPlanner.js';
import { ProgramExecutor } from './programExecutor.js';
import type { AgentRecord, AgentState, PlatformService, ScheduleMode, Service, SourceCli } from './service.js';
import { RecipeService } from './recipes.js';
import { namespace, verdictLabel, WorkspaceOps } from './workspaceOps.js';

const errorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,70}$/.test(message) ? message : 'AGENT_STEP_FAILED';
};
const field = (text: string, name: string) => new RegExp('^' + name + '\\s*:\\s*(.+)$', 'im').exec(text)?.[1]?.trim();
const money = (value: string | undefined) => {
  const match = /([0-9]{1,9}(?:\.[0-9]{1,2})?)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
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

interface Invoice {
  message: ReaderMessage;
  vendor: string;
  invoice: string;
  amount: number;
  currency: string;
  due: string;
  recurring: string | null;
}

interface Quote {
  vendor: string;
  email: string;
  unitPrice: number | null;
  leadDays: number | null;
  terms: string;
  notes: string;
  message: ReaderMessage | null;
  flags: string[];
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
  async plan(instruction: string, services: string[] | undefined, inboxId: string, calls: PlannerCall[] = []):
    Promise<{ compiled: CompiledIntent; fallback: string | null; repairs?: string[] }> {
    const options = { services, mode: inboxId === 'sandbox' ? 'sandbox' as const : 'live' as const };
    if (this.engine.agent.mode !== 'llm') return { compiled: compileIntent(instruction, options), fallback: null };
    let planned: Awaited<ReturnType<typeof llmPlan>>;
    try {
      planned = await llmPlan(this.engine.agent, instruction, options.mode, undefined, (call) => calls.push(call));
    } catch (error) {
      throw new Error(/^PLANNER_(?:OUTPUT|PROGRAM)_INVALID$/.test(errorCode(error)) ? 'AI_PLAN_UNUSABLE' : 'AI_MODEL_UNAVAILABLE');
    }
    // Small models often answer "one_shot" for "every time I get…"; an explicit recurrence in the user's words wins.
    const stated = deterministicChoice(instruction, options).schedule_mode;
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
    const approved = statuses.filter((status) => status === 'APPROVED').length;
    const log = (action: string, output: string, verified: boolean) => this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: null,
      service: agent.state.phase === 'awaiting_review' ? 'policy' : 'gmail', action, input: agent.state.pending_approvals.join(', '), output,
      verdict: 'GATE_TIER_2', ruleId: 'OPERATOR_DECISION', verified });
    if (agent.state.phase === 'awaiting_rfq_approval') {
      if (approved) {
        log('rfq_batch_approved', 'Operator approved the RFQ batch; resuming to collect vendor quotes.', true);
        this.platform.updateAgentIfStatus(agent.id, 'input_required', (current) => ({ status: 'active', next_run_at: new Date().toISOString(),
          state: { ...current.state, phase: 'awaiting_quotes', pending_approvals: [], phase_started_at: new Date().toISOString() } }));
      } else {
        log('rfq_batch_declined', statuses.includes('EXPIRED') ? 'The RFQ approval expired; no vendor was contacted.'
          : 'Operator declined the RFQ batch; no vendor was contacted.', true);
        this.platform.updateAgentIfStatus(agent.id, 'input_required', (current) =>
          ({ status: 'completed', next_run_at: null, state: { ...current.state, phase: 'rfq_declined', pending_approvals: [] } }));
      }
      return;
    }
    if (agent.state.phase === 'awaiting_booking_approval') {
      const sent = approved ? this.verifiedSends(agent.state.pending_approvals) : [];
      log(approved ? 'booking_confirmation_sent' : 'booking_declined', approved
        ? `Operator approved; purchase confirmation sent and verified (${sent.length} message).`
        : statuses.includes('EXPIRED') ? 'The booking approval expired; nothing was committed.' : 'Operator declined the booking; nothing was committed.', true);
      this.platform.updateAgentIfStatus(agent.id, 'input_required', (current) => ({
        status: approved && !sent.length ? 'paused' : 'completed', next_run_at: null, state: {
          ...current.state, phase: approved ? 'done' : 'booking_declined', pending_approvals: [],
          last_error: approved && !sent.length ? 'BOOKING_SEND_UNVERIFIED' : null,
        },
      }));
      return;
    }
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

  private verifiedSends(approvalIds: string[]) {
    return approvalIds.flatMap((id) => {
      const approval = this.engine.store.approval(id);
      const executions = (this.engine.store.sqlite.prepare("SELECT id FROM inbox_runs WHERE json_extract(body,'$.trigger')=?")
        .all('approval:' + id) as { id: string }[]).map((row) => row.id);
      return [...new Set([...(approval?.execution_run_ids ?? []), ...executions])].flatMap((runId) => this.engine.store.actions(runId))
        .filter((action) => action.kind === 'send' && action.status === 'VERIFIED');
    });
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
    let retryInMs: number | undefined;
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
      retryInMs = (result as { retryInMs?: number }).retryInMs;
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
      if (phase === 'awaiting_quotes') return { status: 'active', state,
        next_run_at: new Date(Date.now() + (retryInMs ?? (agent.inbox_id === 'sandbox' ? 0 : (agent.interval_seconds ?? 300) * 1000))).toISOString() };
      if (phase === 'done' || phase === 'no_usable_quotes') return { status: 'completed', next_run_at: null, state };
      return { ...this.afterRun(agent), state };
    });
    return run;
  }

  private execute(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    switch (agent.workflow_plan.template) {
      case 'invoice_ledger': return this.invoiceLedger(agent, context, ops);
      case 'vendor_rfq': return this.vendorRfq(agent, context, ops);
      case 'photo_receipts': return this.photoReceipts(agent, context, ops);
      case 'inbox_digest': return this.inboxDigest(agent, context, ops);
      case 'generic': return new ProgramExecutor(this.engine, this.platform, agent, context, ops).run();
      default: return Promise.resolve({ pending: [], phase: 'done', notes: [] });
    }
  }

  private logRead(agent: AgentRecord, context: MissionContext, service: Service, action: string, input: string, output: string, detail: Record<string, unknown> = {}) {
    const step = context.record('CHECK', { action, outcome: 'VERIFIED', rule_id: 'READ_ONLY_SCOPED', ...detail });
    this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service, action, input, output,
      verdict: 'ALLOW_TIER_0', ruleId: 'READ_ONLY_SCOPED', verified: true, traceStepHash: step.step_hash });
  }

  private logBlocked(agent: AgentRecord, context: MissionContext, service: Service | 'policy', action: string, input: string, ruleId: string) {
    const step = context.record('POLICY', { action, rule_id: ruleId, decision: 'BLOCKED', tier: 2 });
    this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service, action, input,
      output: 'Quarantined; content never reached a Workspace write.', verdict: 'BLOCKED', ruleId, verified: true, traceStepHash: step.step_hash });
  }

  private hostile(message: ReaderMessage) {
    const content = [message.subject, message.text, message.html ?? ''].join('\n');
    return scanPromptInjection(content).detected || Boolean(message.threatSignals?.length) ||
      Boolean(message.replyTo && address(message.replyTo) !== address(message.from));
  }

  private today(mode: Mode) {
    return (mode === 'sandbox' ? sandboxClock : new Date().toISOString()).slice(0, 10);
  }

  /** Returns extracted photos, or the Google Photos Picker link the operator must open first (live Picker mode). */
  private async photoRows(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps): Promise<PhotoDetails[] | { pickerUri: string }> {
    const adapter = this.engine.workspace(context.mode);
    let items;
    try {
      items = await adapter.searchPhotos({ category: 'RECEIPTS', limit: 10 });
    } catch (error) {
      if (errorCode(error) !== 'PHOTOS_PICKER_SELECTION_REQUIRED' || !adapter.startPhotoPicker) throw error;
      const session = await adapter.startPhotoPicker();
      const step = context.record('POLICY', { action: 'search_recent_photos', rule_id: 'PHOTOS_PICKER_SELECTION_REQUIRED', decision: 'APPROVAL_REQUIRED', tier: 2 });
      this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service: 'photos', action: 'request_photo_selection',
        input: 'Google Photos Picker session ' + session.session_id, output: 'Open the picker link and choose the receipts Siftvane may read: ' + session.picker_uri,
        verdict: 'GATE_TIER_2', ruleId: 'PHOTOS_PICKER_SELECTION_REQUIRED', verified: true, traceStepHash: step.step_hash });
      return { pickerUri: session.picker_uri };
    }
    this.logRead(agent, context, 'photos', 'search_recent_photos', 'category=RECEIPTS limit=10', `${items.length} receipt photos found`, { count: items.length });
    const details: PhotoDetails[] = [];
    for (const item of items) {
      context.checkout();
      const extracted = await extractPhotoDetails(adapter, item.id);
      if (extracted.quarantined) {
        this.logBlocked(agent, context, 'photos', 'extract_photo_details', item.filename, 'HOSTILE_IMAGE_TEXT_QUARANTINED');
        continue;
      }
      const { merchant, amount, currency, date, due } = extracted.fields;
      this.logRead(agent, context, 'photos', 'extract_photo_details', `${item.filename} (${extracted.bytes} bytes, ${extracted.extraction})`,
        `${merchant ?? 'Unknown merchant'} · ${amount ?? '?'} ${currency ?? ''} · ${date ?? ''}${due ? ' · pay by ' + due : ''}`,
        { media_item_id: item.id, content_sha256: extracted.content_sha256 });
      details.push(extracted);
    }
    void ops;
    return details;
  }

  /* ---------------------------------- Recurring bills & daily invoices ---------------------------------- */
  private async invoiceLedger(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    const plan = agent.workflow_plan;
    const messages = await this.engine.readMessages(context.mode, undefined, context.signal);
    const invoices: Invoice[] = [];
    let quarantined = 0;
    for (const message of messages) {
      if (message.contextOnly || message.sent) continue;
      const text = stripHtml(message.text);
      if (!/\b(?:invoice|bill|receipt|subscription)\b/i.test(message.subject) && !field(text, 'Invoice')) continue;
      if (this.hostile(message)) {
        quarantined++;
        this.logBlocked(agent, context, 'gmail', 'scan_invoices', `${message.from} · ${message.id}`, 'HOSTILE_INPUT_QUARANTINED');
        continue;
      }
      const invoice = field(text, 'Invoice');
      const amount = money(field(text, 'Amount'));
      if (!invoice || amount === null) continue;
      invoices.push({ message, invoice, amount, vendor: field(text, 'Vendor') ?? domain(message.from) ?? 'Unknown',
        currency: /\b([A-Z]{3})\b/.exec(field(text, 'Amount') ?? '')?.[1] ?? 'USD', due: field(text, 'Due') ?? '',
        recurring: field(text, 'Recurring') ?? (/subscription|renews automatically/i.test(message.subject + ' ' + text) ? 'monthly' : null) });
    }
    // Duplicate / spoof guard: the earliest invoice from a verified sender is canonical.
    invoices.sort((left, right) => Date.parse(left.message.receivedAt) - Date.parse(right.message.receivedAt));
    const canonical = new Map<string, Invoice>();
    const flagged: Array<Invoice & { reason: string }> = [];
    for (const entry of invoices) {
      const first = canonical.get(entry.invoice);
      if (entry.message.verifiedSender === false) flagged.push({ ...entry, reason: 'Sender identity could not be verified' });
      else if (!first) canonical.set(entry.invoice, entry);
      else if (first.amount !== entry.amount || domain(first.message.from) !== domain(entry.message.from)) {
        flagged.push({ ...entry, reason: `Duplicate of ${first.invoice} with ${first.amount !== entry.amount ? `amount ${first.amount} → ${entry.amount}` : 'a different sender'}` });
      }
    }
    const clean = [...canonical.values()];
    this.logRead(agent, context, 'gmail', 'scan_invoices', `${messages.length} messages`,
      `${clean.length} invoices, ${clean.filter((item) => item.recurring).length} recurring, ${flagged.length} flagged, ${quarantined} quarantined`,
      { invoices: clean.length, flagged: flagged.length });

    const photoResult = plan.params.include_photos ? await this.photoRows(agent, context, ops) : [];
    // The ledger never blocks on photos: without a picker selection it proceeds with email invoices only.
    const photos = Array.isArray(photoResult) ? photoResult : [];
    const month = this.today(context.mode).slice(0, 7);
    const folderPath = [...plan.params.folder_path ?? ['Siftvane', 'Invoices'], month];
    const folder = await ops.ensureFolderPath(folderPath);

    const links = new Map<string, string>();
    for (const entry of clean) {
      for (const [index, part] of (entry.message.attachments ?? []).slice(0, 3).entries()) {
        context.checkout();
        if (part.mime !== 'application/pdf') continue;
        try {
          safeAttachmentBytes(part);
          const extracted = await readAttachments([part]);
          if (scanPromptInjection(extracted).detected || scanOutboundSecrets(extracted)) {
            this.logBlocked(agent, context, 'drive', 'save_attachment', part.name, 'ATTACHMENT_QUARANTINED');
            continue;
          }
          const staged = await stageWorkspaceAttachment(this.engine.stagingRoot(), entry.message.id, part, this.engine.guard);
          try {
            const saved = await ops.saveFile(folderPath, part.name, part.mime, { staged_path: staged.path }, entry.message.id);
            const row = saved.artifactId ? this.platform.registry.byId(saved.artifactId) : undefined;
            if (saved.verified) links.set(entry.invoice, row?.url ?? `sandbox://drive/${row?.external_id ?? index}`);
          } finally {
            await rm(path.dirname(staged.path), { recursive: true, force: true });
          }
        } catch (error) {
          this.logBlocked(agent, context, 'drive', 'save_attachment', part.name, errorCode(error));
        }
      }
    }

    const sheetTitle = plan.params.sheet_title ?? 'Siftvane Invoice Ledger';
    const parent = ops.folderKey(folderPath.slice(0, -1));
    await ops.ensureSpreadsheet(sheetTitle, parent, [
      { name: 'Daily Invoices', headers: ['Date', 'Vendor', 'Invoice #', 'Amount', 'Due Date', 'Status', 'Drive Link'] },
      { name: 'Recurring Bills', headers: ['Vendor', 'Invoice #', 'Amount', 'Frequency', 'Next Due', 'Status'] },
    ]);
    const daily = [
      ...clean.map((entry) => [entry.message.receivedAt.slice(0, 10), entry.vendor, entry.invoice, entry.amount, entry.due,
        entry.recurring ? 'Recurring' : 'Logged', links.get(entry.invoice) ?? 'Inline (no PDF)']),
      ...photos.filter((item) => item.fields.amount !== undefined).map((item) => [item.fields.date ?? '', item.fields.merchant ?? 'Receipt photo',
        item.fields.reference ?? 'PHOTO-' + item.media_item_id.slice(-10), item.fields.amount!, item.fields.due ?? '', 'Receipt photo', 'photos://' + item.media_item_id]),
    ];
    const appended = await ops.appendRows(sheetTitle, 'Daily Invoices', daily, 'Invoice #');
    await ops.appendRows(sheetTitle, 'Recurring Bills', clean.filter((entry) => entry.recurring)
      .map((entry) => [entry.vendor, entry.invoice, entry.amount, entry.recurring!, entry.due, 'Active']), 'Invoice #');

    const total = clean.reduce((sum, entry) => sum + entry.amount, 0);
    const sheetUrl = this.platform.registry.get(agent.inbox_id, ops.sheetKey(sheetTitle))?.url;
    await ops.upsertDoc(plan.params.doc_title ?? 'Siftvane Invoice Summary', parent, `Daily invoice digest - ${this.today(context.mode)}`, [
      `Invoices logged: ${clean.length} (total ${total.toFixed(2)} USD); ${appended.appended} new ledger rows, ${appended.skipped} duplicates skipped.`,
      ...clean.map((entry) => `• ${entry.vendor} · ${entry.invoice} · ${entry.amount.toFixed(2)} ${entry.currency} · due ${entry.due || 'n/a'}${entry.recurring ? ' · recurring ' + entry.recurring : ''}`),
      ...(photos.length ? [`Receipt photos: ${photos.length}`, ...photos.map((item) => `• ${item.fields.merchant ?? 'Receipt'} · ${item.fields.amount ?? '?'} ${item.fields.currency ?? ''}`)] : []),
      `Flagged for review: ${flagged.length}`,
      ...flagged.map((entry) => `• ${entry.vendor} · ${entry.invoice} · ${entry.amount.toFixed(2)} · ${entry.reason}`),
      `Ledger: ${sheetUrl ?? sheetTitle + ' (sandbox)'}`,
    ].join('\n'), 'replace_section');

    const pending: string[] = [];
    for (const entry of flagged) {
      const after = { vendor: entry.vendor, invoice: entry.invoice, amount: entry.amount, due: entry.due, sender: address(entry.message.from), reason: entry.reason };
      const outcome = await context.execute({
        kind: 'review', playbook: 'bills_trials_spoof_guard', target: `invoice:${entry.invoice}:${entry.message.id}`, sourceId: entry.message.id,
        threadId: entry.message.threadId, version: sha256(canonicalJson(after)), after, requestedTier: 2, reason: 'DUPLICATE_OR_SPOOFED_INVOICE', confidence: 1,
      });
      if (outcome.approvalId) pending.push(outcome.approvalId);
      this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service: 'policy', action: 'flag_duplicate_invoice',
        input: `${entry.vendor} ${entry.invoice} ${entry.amount}`, output: `${entry.reason} → Approval Inbox ${outcome.approvalId ?? ''}`,
        verdict: verdictLabel(outcome), ruleId: outcome.ruleId, verified: true, traceStepHash: outcome.policyStep.step_hash });
    }
    void folder;
    return { pending, phase: pending.length ? 'awaiting_review' : 'start', notes: [...ops.flags] };
  }

  /* ---------------------------------- Vendor RFQ → comparison → booking ---------------------------------- */
  private rfqAction(agent: AgentRecord, vendor: string, item: string, reason?: string, booking?: { unit: number; quantity?: number; terms: string }): SafeAction {
    const after = booking ? {
      subject: `Purchase confirmation - ${item}`.slice(0, 180),
      text: `Hello,\n\nWe would like to proceed with your quote for ${item} at ${booking.unit.toFixed(2)} USD per unit` +
        `${booking.quantity ? ` (${(booking.unit * booking.quantity).toFixed(2)} USD total)` : ''} on ${booking.terms} terms. Please confirm the order and expected ship date.\n\nThank you.`,
    } : {
      subject: `Request for quote - ${item}`.slice(0, 180),
      text: `Hello,\n\nWe are requesting a quote for ${item}. Please reply with your unit price in USD, lead time in days, and payment terms.\n\nThank you.`,
    };
    const version = sha256(canonicalJson({ ...after, to: vendor, agent: agent.id }));
    return {
      kind: 'send', playbook: booking ? 'vendor_booking' : 'vendor_rfq', target: 'send-' + version.slice(0, 24), sourceId: 'agent:' + agent.id + (booking ? ':booking' : ':rfq'),
      effectiveContact: vendor, version, after, requestedTier: booking ? 2 : 1, reason, confidence: 1,
    };
  }

  private async vendorRfq(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    const { vendors = [], item = 'requested items', quantity } = agent.workflow_plan.params;
    if (agent.state.phase === 'start') {
      if (!vendors.length) throw new Error('NO_VENDORS_SPECIFIED');
      const actions = vendors.map((vendor) => this.rfqAction(agent, vendor, item));
      const outcome = await context.queueBatch(actions, `Send a request for quote for ${item} to ${vendors.length} vendors (X-Agent-Automated disclosure attached).`);
      this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service: 'gmail', action: 'queue_rfq_batch',
        input: `${vendors.length} vendors: ${vendors.join(', ')}`, output: outcome.approvalId ? `Queued in Approval Inbox (${outcome.approvalId})`
          : outcome.decision === 'BLOCKED' ? `Blocked by ${outcome.ruleId}` : 'Sent to allowlisted vendors and verified',
        verdict: verdictLabel(outcome), ruleId: outcome.ruleId, verified: outcome.decision !== 'BLOCKED', traceStepHash: outcome.policyStep.step_hash });
      if (outcome.decision === 'BLOCKED') throw new Error(outcome.ruleId);
      return outcome.approvalId ? { pending: [outcome.approvalId], phase: 'awaiting_rfq_approval', notes: [] } : { pending: [], phase: 'awaiting_quotes', notes: [] };
    }

    // awaiting_quotes: only vendors whose RFQ was actually sent and verified count as contacted.
    const actions = vendors.map((vendor) => this.rfqAction(agent, vendor, item));
    const sent = vendors.filter((_vendor, index) => this.engine.store.sqlite.prepare(
      "SELECT 1 FROM inbox_actions WHERE kind='send' AND target=? AND status='VERIFIED'").get(actions[index].target));
    if (context.mode === 'sandbox' && sent.length) {
      // $0 sandbox mail delivery: vendors reply only to RFQs that really left Siftvane.
      const delivered = this.engine.store.sqlite.prepare(`UPDATE inbox_sandbox_messages SET scope='workspace'
        WHERE scope='vendor_pending' AND lower(json_extract(body,'$.from')) IN (${sent.map(() => '?').join(',')})`).run(...sent).changes;
      if (Number(delivered)) this.logRead(agent, context, 'gmail', 'sandbox_vendor_replies', `${sent.length} RFQs verified as sent`, `${delivered} vendor replies delivered to the sandbox inbox`);
    }
    const messages = await this.engine.readMessages(context.mode, undefined, context.signal);
    const quotes: Quote[] = [];
    for (const vendor of vendors) {
      context.checkout();
      const reply = [...messages].reverse().find((message) => address(message.from) === vendor && !message.sent && /\bquote\b/i.test(message.subject + ' ' + message.text));
      if (!sent.includes(vendor) || !reply) {
        quotes.push({ vendor: domain(vendor) ?? vendor, email: vendor, unitPrice: null, leadDays: null, terms: '', notes: sent.includes(vendor) ? 'No reply yet' : 'RFQ not sent', message: null, flags: [] });
        continue;
      }
      if (this.hostile(reply)) {
        this.logBlocked(agent, context, 'gmail', 'collect_vendor_quotes', `${vendor} · ${reply.id}`, 'HOSTILE_INPUT_QUARANTINED');
        continue;
      }
      let text = stripHtml(reply.text);
      const pdfs = (reply.attachments ?? []).filter((part) => part.mime === 'application/pdf').slice(0, 2);
      if (pdfs.length) {
        try {
          pdfs.forEach((part) => safeAttachmentBytes(part));
          const extracted = await readAttachments(pdfs);
          if (scanPromptInjection(extracted).detected || scanOutboundSecrets(extracted)) {
            this.logBlocked(agent, context, 'gmail', 'parse_quote_pdf', `${vendor} attachment`, 'ATTACHMENT_QUARANTINED');
          } else text += '\n' + extracted;
        } catch (error) {
          this.logBlocked(agent, context, 'gmail', 'parse_quote_pdf', `${vendor} attachment`, errorCode(error));
        }
      }
      const notes = sanitizeCell(field(text, 'Notes') ?? '');
      quotes.push({
        vendor: domain(vendor)?.split('.')[0].replace(/^\w/, (char) => char.toUpperCase()) ?? vendor, email: vendor,
        unitPrice: money(field(text, 'Unit price')), leadDays: money(field(text, 'Lead time')), terms: field(text, 'Terms') ?? '',
        notes: String(notes.value), message: reply, flags: notes.flags,
      });
      this.logRead(agent, context, 'gmail', 'collect_vendor_quotes', `${vendor} · ${reply.id}${pdfs.length ? ' + PDF' : ''}`,
        `unit ${money(field(text, 'Unit price')) ?? '?'} USD · lead ${money(field(text, 'Lead time')) ?? '?'} days · ${field(text, 'Terms') ?? 'terms n/a'}${notes.flags.length ? ' · notes sanitized (' + notes.flags.join(', ') + ')' : ''}`);
    }
    const priced = quotes.filter((quote) => quote.unitPrice !== null);
    // Wait for every contacted vendor until the quote window closes (default 24h live, immediate in the $0 sandbox).
    const windowMs = (agent.workflow_plan.params.quote_wait_hours ?? (context.mode === 'sandbox' ? 0 : 24)) * 3_600_000;
    const started = Date.parse(agent.state.phase_started_at ?? agent.updated_at);
    const missing = sent.filter((vendor) => !priced.some((quote) => quote.email === vendor));
    const remaining = started + windowMs - Date.now();
    if (missing.length && remaining > 0) {
      const note = `Waiting for ${missing.length} of ${sent.length} vendor replies` + (remaining > 0 ? ` until ${new Date(started + windowMs).toISOString()}` : '');
      return { pending: [], phase: 'awaiting_quotes', notes: [note],
        retryInMs: Math.max(1000, Math.min((agent.interval_seconds ?? 300) * 1000, remaining)) };
    }
    if (!priced.length) {
      const note = 'The quote window closed without a usable price.';
      this.logRead(agent, context, 'gmail', 'quote_window_closed', `${sent.length} verified requests`, note);
      return { pending: [], phase: 'no_usable_quotes', notes: [note] };
    }

    const sheetTitle = agent.workflow_plan.params.sheet_title ?? `Vendor Quotes - ${item}`;
    const headers = ['Vendor', 'Vendor Email', 'Unit Price (USD)', 'Quantity', 'Total (USD)', 'Lead Time (days)', 'Terms', 'Notes', 'Status'];
    await ops.ensureSpreadsheet(sheetTitle, null, [{ name: 'Comparison', headers }]);
    const rows = quotes.map((quote) => [quote.vendor, quote.email, quote.unitPrice ?? '', quantity ?? '',
      quote.unitPrice !== null && quantity ? Number((quote.unitPrice * quantity).toFixed(2)) : '', quote.leadDays ?? '', quote.terms, quote.notes,
      quote.unitPrice === null ? 'No quote' : 'Quoted']);
    const appended = await ops.appendRows(sheetTitle, 'Comparison', rows, 'Vendor Email');
    const winner = [...priced].sort((left, right) => left.unitPrice! - right.unitPrice! || (left.leadDays ?? 999) - (right.leadDays ?? 999))[0];
    const current = await ops.read(ops.sheetKey(sheetTitle)) as { tabs: { name: string; rows: unknown[][] }[] } | null;
    const rowIndex = (current?.tabs.find((tab) => tab.name === 'Comparison')?.rows.findIndex((row) => row[1] === winner.email) ?? -1) + 2;
    if (rowIndex >= 2) await ops.updateCells(sheetTitle, 'Comparison', `I${rowIndex}`, [['Lowest price - recommended']]);

    const docTitle = agent.workflow_plan.params.doc_title ?? `Vendor Quote Comparison - ${item}`;
    await ops.upsertDoc(docTitle, null, 'Quotes received', quotes.map((quote) => quote.unitPrice === null
      ? `• ${quote.vendor} (${quote.email}): ${quote.notes}`
      : `• ${quote.vendor}: ${quote.unitPrice.toFixed(2)} USD/unit${quantity ? `, ${(quote.unitPrice * quantity).toFixed(2)} USD total` : ''}, ${quote.leadDays ?? '?'} days lead time, ${quote.terms || 'terms n/a'}` +
        (quote.flags.length ? ` (notes sanitized: ${quote.flags.join(', ')})` : '')).join('\n'), 'replace_section');
    await ops.upsertDoc(docTitle, null, 'Recommendation', `Lowest cost: ${winner.vendor} at ${winner.unitPrice!.toFixed(2)} USD/unit with ${winner.leadDays ?? '?'} days lead time on ${winner.terms || 'standard'} terms.\n` +
      `Comparison sheet: ${this.platform.registry.get(agent.inbox_id, ops.sheetKey(sheetTitle))?.url ?? sheetTitle + ' (sandbox)'}\n` +
      'The booking confirmation is waiting in the Approval Inbox. Nothing is committed until the operator approves it.', 'replace_section');
    void appended;

    if (!agent.workflow_plan.steps.some((step) => step.id === 'booking')) return { pending: [], phase: 'done', notes: [...ops.flags] };
    const booking = this.rfqAction(agent, winner.email, item, 'FINANCIAL_COMMITMENT_APPROVAL', { unit: winner.unitPrice!, quantity, terms: winner.terms || 'standard' });
    const outcome = await context.execute(booking);
    this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service: 'gmail', action: 'queue_booking_confirmation',
      input: `${winner.email} · ${winner.unitPrice} USD/unit`, output: outcome.approvalId ? `Waiting for operator approval (${outcome.approvalId})` : `Blocked by ${outcome.ruleId}`,
      verdict: verdictLabel(outcome), ruleId: outcome.ruleId, verified: outcome.decision !== 'BLOCKED', traceStepHash: outcome.policyStep.step_hash });
    return outcome.approvalId ? { pending: [outcome.approvalId], phase: 'awaiting_booking_approval', notes: [...ops.flags] } : { pending: [], phase: 'done', notes: [...ops.flags] };
  }

  /* ---------------------------------- Photos receipts → Sheet + Calendar ---------------------------------- */
  private async photoReceipts(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    const result = await this.photoRows(agent, context, ops);
    if (!Array.isArray(result)) return { pending: [], phase: 'awaiting_photo_selection', notes: [result.pickerUri] };
    const details = result;
    const sheetTitle = agent.workflow_plan.params.sheet_title ?? 'Siftvane Receipts';
    await ops.ensureSpreadsheet(sheetTitle, null, [{ name: 'Receipts', headers: ['Date', 'Merchant', 'Reference', 'Amount', 'Currency', 'Pay By', 'Source Photo'] }]);
    await ops.appendRows(sheetTitle, 'Receipts', details.map((item) => [item.fields.date ?? '', item.fields.merchant ?? 'Unknown', item.fields.reference ?? '',
      item.fields.amount ?? '', item.fields.currency ?? '', item.fields.due ?? '', item.media_item_id]), 'Source Photo');
    if (agent.workflow_plan.params.calendar_reminders) {
      for (const item of details.filter((entry) => entry.fields.due)) {
        const suffix = sha256(item.media_item_id).slice(0, 16);
        const id = 'siftvane-reminder-' + suffix;
        if (await context.read('calendar', id) || await context.read('calendar', 'clam-reminder-' + suffix)) {
          this.logRead(agent, context, 'calendar', 'add_payment_reminder', item.filename, 'Reminder already scheduled');
          continue;
        }
        const title = String(sanitizeCell(`Pay ${item.fields.merchant ?? 'bill'}${item.fields.reference ? ' ' + item.fields.reference : ''} (${item.fields.amount ?? '?'} ${item.fields.currency ?? ''})`).value).slice(0, 140);
        const event: InboxCalendarEvent = { id, title, start: `${item.fields.due}T09:00:00.000Z`, end: `${item.fields.due}T09:15:00.000Z`,
          kind: 'reminder', guests: [], flexible: false };
        const outcome = await context.execute({ kind: 'calendar', playbook: 'photo_payment_reminder', target: id, sourceId: 'photo:' + item.media_item_id,
          version: sha256(canonicalJson(event)), after: event as unknown as Record<string, unknown>, expectedBefore: null, requestedTier: 0, confidence: 1 });
        this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: context.runId, service: 'calendar', action: 'add_payment_reminder',
          input: `${item.filename} due ${item.fields.due}`, output: outcome.verified ? `Reminder "${title}" verified on ${item.fields.due}` : `${outcome.outcome || outcome.decision}`,
          verdict: verdictLabel(outcome), ruleId: outcome.ruleId, verified: outcome.verified, traceStepHash: (outcome.checkStep ?? outcome.policyStep).step_hash });
      }
    }
    return { pending: [], phase: 'start', notes: [...ops.flags] };
  }

  /* ---------------------------------- Any other request: safe digest ---------------------------------- */
  private async inboxDigest(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    const { keywords = [], doc_title, sheet_title, folder_path } = agent.workflow_plan.params;
    const messages = (await this.engine.readMessages(context.mode, undefined, context.signal)).filter((message) => !message.contextOnly && !message.sent);
    const safe = messages.filter((message) => !this.hostile(message));
    const matching = keywords.length ? safe.filter((message) => keywords.some((word) => (message.subject + ' ' + message.text).toLowerCase().includes(word))) : [];
    const selected = (matching.length ? matching : safe).slice(0, 25);
    this.logRead(agent, context, 'gmail', 'scan_inbox', `${messages.length} messages${keywords.length ? ' · keywords ' + keywords.join(', ') : ''}`,
      `${selected.length} relevant, ${messages.length - safe.length} quarantined`);
    const folder = folder_path ? (await ops.ensureFolderPath(folder_path)).key : null;
    if (sheet_title) {
      await ops.ensureSpreadsheet(sheet_title, folder, [{ name: 'Messages', headers: ['Date', 'From', 'Subject', 'Message ID'] }]);
      await ops.appendRows(sheet_title, 'Messages', selected.map((message) => [message.receivedAt.slice(0, 10), address(message.from),
        this.engine.redact(context.mode, message.subject), message.id]), 'Message ID');
    }
    await ops.upsertDoc(doc_title ?? 'Siftvane Digest', folder, `Digest - ${this.today(context.mode)}`, [
      `Request: ${agent.goal_prompt.slice(0, 300)}`, `Messages reviewed: ${messages.length}; included: ${selected.length}.`,
      ...selected.map((message) => `• ${message.receivedAt.slice(0, 10)} · ${address(message.from)} · ${this.engine.redact(context.mode, message.subject)}`),
    ].join('\n'), 'replace_section');
    return { pending: [], phase: 'start', notes: [...ops.flags] };
  }
}

export type { WorkflowPlan };
export { namespace };
