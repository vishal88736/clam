import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inboxCalendarSchema, inboxPolicySchema, inboxScheduleSchema, type HandoffInput, type InboxPolicy, type InboxStage } from '@siftvane/shared';
import { HandoffService, type HandoffResult } from '../handoffs/service.js';
import { isPodCaseThread, podCase } from '../handoffs/sample.js';
import type { ReaderMessage } from '../sandbox/seed.js';
import { sandboxClock } from '../sandbox/seed.js';
import type { ActionKind, Attention, Change, Claim, Decision, InboxTarget, MailSearch, McpCaller, Mode, RunRecord, SafeAction, Snapshot, Tier, TraceStep } from './contracts.js';
import { addUsage, emptyUsage, resolveAgentConfig, type AgentConfig, type ModelUsage } from './agentConfig.js';
import { buildPlan, playbooks } from './playbooks/index.js';
import { evaluateAction, evaluateSafeAction, safeAction } from './policy.js';
import { liveReader, sandboxReader } from './reader.js';
import { InboxStore } from './store.js';
import { expectedAfter, matches, SandboxTarget } from './targets.js';
import { canonicalJson, genesisHash, hashStep, sha256 } from './trace.js';
import { SandboxWorkspaceAdapter } from '../workspace/adapters.js';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { CompositeTarget } from '../workspace/target.js';
import type { WorkspaceAdapter } from '../workspace/types.js';

const errorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  return /^[A-Z][A-Z_0-9]{2,64}$/.test(message) ? message : 'UNEXPECTED_EXECUTION_ERROR';
};

interface EngineOptions {
  databasePath: string;
  lockfile?: string;
  tracesDir: string;
  externalHalt?: () => boolean;
  onTrip?: (reason: string, runId: string) => Promise<unknown>;
  onRun?: (runId: string, controller: AbortController) => () => void;
  live?: {
    target: (mode: Mode, guard: () => void, store: InboxStore) => InboxTarget;
    reader: (mode: Mode, search?: MailSearch, signal?: AbortSignal) => Promise<ReaderMessage[]>;
    ready: (mode: Mode) => boolean;
    modes: () => Mode[];
    mutationScope: (mode: Mode, kind: ActionKind) => void;
    redact: (mode: Mode, value: string) => string;
    workspace?: (mode: Mode, guard: () => void, registry: WorkspaceRegistry) => WorkspaceAdapter;
  };
  stagingDir?: string;
  agent?: AgentConfig;
  handoffKey?: Buffer;
  sandboxTarget?: (store: InboxStore, guard: () => void) => InboxTarget;
}

type Session = {
  run: RunRecord;
  policy: InboxPolicy;
  head: string;
  ordinal: number;
  controller: AbortController;
  checkControl?: () => void;
  last?: TraceStep;
  violations?: number;
};

export interface MissionOutcome {
  decision: Decision;
  tier: Tier;
  ruleId: string;
  reason: string;
  approvalId?: string;
  policyStep: TraceStep;
  checkStep?: TraceStep;
  verified: boolean;
  outcome?: string;
}

export interface MissionContext {
  readonly runId: string;
  readonly mode: Mode;
  readonly policy: InboxPolicy;
  readonly signal: AbortSignal;
  record(stage: 'PLAN' | 'CHECK' | 'POLICY', detail: Record<string, unknown>): TraceStep;
  recordModel(detail: Record<string, unknown>, usage: ModelUsage): TraceStep;
  execute(action: SafeAction): Promise<MissionOutcome>;
  read(kind: ActionKind, target: string): Promise<Snapshot>;
  queueBatch(actions: SafeAction[], reason: string): Promise<MissionOutcome>;
  checkout(): void;
  charge(): Promise<void>;
}

export class InboxEngine extends EventEmitter {
  readonly store: InboxStore;
  private agentConfig: AgentConfig;
  /** The model powering planning and reading; replaced when the user picks another AI provider. */
  get agent(): AgentConfig { return this.agentConfig; }
  useAgent(config: AgentConfig) { this.agentConfig = config; }
  readonly handoffs: HandoffService;
  private readonly leaseOwner = randomUUID();
  private readonly active = new Map<string, { done: Promise<RunRecord>; session: Session }>();
  private readonly sandboxTarget: InboxTarget;
  readonly registry: WorkspaceRegistry;
  private readonly sandboxWorkspace: SandboxWorkspaceAdapter;
  private scheduler: NodeJS.Timeout | undefined;
  private closing = false;
  private lastPolledHalt = false;

  constructor(private readonly config: EngineOptions) {
    super();
    this.agentConfig = config.agent ?? resolveAgentConfig({ SIFTVANE_AGENT_MODE: 'offline-smoke' });
    this.store = new InboxStore(config.databasePath);
    this.handoffs = new HandoffService(this.store, config.handoffKey);
    const sandboxBase = config.sandboxTarget?.(this.store, this.guard) ?? new SandboxTarget(this.store, this.guard, 'sandbox', this.handoffs);
    this.registry = new WorkspaceRegistry(this.store.sqlite);
    this.sandboxWorkspace = new SandboxWorkspaceAdapter(this.store, this.guard, config.stagingDir ?? path.join(path.dirname(this.store.filename), 'workspace-staging'));
    this.sandboxTarget = new CompositeTarget(sandboxBase, this.sandboxWorkspace, this.registry, 'sandbox');
  }

  /** True while any run (inbox, approval, rollback, or agent mission) holds the single-writer lease. */
  busy() {
    return this.active.size > 0;
  }

  workspace(mode: Mode): WorkspaceAdapter {
    if (mode === 'sandbox') return this.sandboxWorkspace;
    if (!this.config.live?.ready(mode) || !this.config.live.workspace) throw new Error('GOOGLE_REAUTH_REQUIRED');
    return this.config.live.workspace(mode, this.guard, this.registry);
  }

  stagingRoot() {
    return this.config.stagingDir ?? path.join(path.dirname(this.store.filename), 'workspace-staging');
  }

  /** Mail visible to agent missions: the sandbox inbox plus Workspace fixtures, or the live Gmail reader. */
  async readMessages(mode: Mode, search?: MailSearch, signal?: AbortSignal): Promise<ReaderMessage[]> {
    this.guard();
    signal?.throwIfAborted();
    if (mode === 'sandbox') {
      return this.store.sqlite.prepare("SELECT body FROM inbox_sandbox_messages WHERE scope IN ('inbox','workspace') ORDER BY rowid")
        .all().map((row) => JSON.parse(String(row.body)) as ReaderMessage);
    }
    if (!this.config.live?.ready(mode)) throw new Error('GOOGLE_REAUTH_REQUIRED');
    return this.config.live.reader(mode, search, signal);
  }

  redact(mode: Mode, value: string) {
    return mode === 'sandbox' || !this.config.live ? value : this.config.live.redact(mode, value);
  }

  activeMode(): Mode {
    return 'sandbox';
  }

  halted = () => this.store.halt() || Boolean(this.config.externalHalt?.() ||
    (this.config.lockfile && existsSync(this.config.lockfile)));

  guard = () => {
    if (this.halted()) throw new Error('INBOX_HALTED');
  };

  latch(active: boolean) {
    this.store.halt(active);
    if (active) {
      for (const { session } of this.active.values()) session.controller.abort(new Error('INBOX_HALTED'));
    }
    this.emit('state', { halted: this.halted() });
  }

  private target(mode: Mode): InboxTarget {
    if (mode === 'sandbox') return this.sandboxTarget;
    if (!this.config.live?.ready(mode)) throw new Error('GOOGLE_REAUTH_REQUIRED');
    const base = this.config.live.target(mode, this.guard, this.store);
    return this.config.live.workspace ? new CompositeTarget(base, this.workspace(mode), this.registry, mode.slice(5)) : base;
  }

  requireMutationScope(mode: Mode, kind: ActionKind) {
    if (mode !== 'sandbox') this.config.live?.mutationScope(mode, kind);
  }

  private requireSafePayload(mode: Mode, action: Pick<SafeAction, 'kind' | 'after'>) {
    if (mode === 'sandbox' || !this.config.live || !['send', 'draft', 'calendar'].includes(action.kind)) return;
    const input = canonicalJson(action.after);
    if (this.config.live.redact(mode, input) !== input) throw new Error('OUTBOUND_CONTENT_BLOCKED');
  }

  private async trip(session: Session, reason: string): Promise<never> {
    session.run.killSwitchTripped = true;
    this.latch(true);
    await this.config.onTrip?.(reason, session.run.id);
    throw new Error(reason);
  }

  private emitStep(session: Session, stage: InboxStage, detail: Record<string, unknown>, usage?: ModelUsage): TraceStep {
    const { run } = session;
    if (run.mcp_caller) detail = { ...detail, mcp_caller: run.mcp_caller };
    if (run.mode !== 'sandbox' && this.config.live) {
      const clean = (value: unknown): unknown => typeof value === 'string' ? this.config.live!.redact(run.mode, value) :
        Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ?
          Object.fromEntries(Object.entries(value).map(([key, field]) => [key, clean(field)])) : value;
      detail = clean(detail) as typeof detail;
    }
    const data = {
      id: `${run.id}:${++session.ordinal}`, stage, run_id: run.id, timestamp: new Date().toISOString(),
      detail, prev_hash: session.head, mode: run.agent_mode ?? 'offline-smoke' as const,
      model_usage: usage ?? { ...emptyUsage(this.agent),
        provider: run.model_usage?.provider ?? 'local', model: run.model_usage?.model ?? 'deterministic-parser' },
      budgets: {
        outbound: run.outbound, calendar: run.calendar, steps: run.steps,
        tokens: run.model_usage?.prompt_tokens === null || run.model_usage?.completion_tokens === null ? null : run.tokens,
        usd: run.model_usage?.estimated_usd === null ? null : run.usd,
      },
    };
    const step = { ...data, step_hash: hashStep(data) };
    this.store.transaction(() => {
      this.store.addStep(step, session.ordinal);
      this.store.updateRun(run);
    });
    session.head = step.step_hash;
    session.last = step;
    this.emit('step', step);
    return step;
  }

  private checkout(session: Session) {
    this.guard();
    session.controller.signal.throwIfAborted();
    session.checkControl?.();
  }

  private recordModel(session: Session, detail: Record<string, unknown>, usage: ModelUsage) {
    const { run } = session;
    run.model_usage = addUsage(run.model_usage!, usage);
    run.model_usage.model = usage.model;
    run.tokens = (run.model_usage.prompt_tokens ?? 0) + (run.model_usage.completion_tokens ?? 0);
    run.usd = run.model_usage.estimated_usd ?? 0;
    return this.emitStep(session, 'PLAN', detail, usage);
  }

  private async charge(session: Session) {
    this.checkout(session);
    if (++session.run.steps > session.policy.toolBudget) await this.trip(session, 'TOOL_STEP_LIMIT');
  }

  private recoverInterrupted() {
    for (const run of this.store.interruptedRuns()) {
      const trace = this.store.trace(run.id);
      run.status = 'FAILED';
      run.completedAt = new Date().toISOString();
      run.error = 'PROCESS_INTERRUPTED';
      const { policy } = this.store.policy(run.mode);
      const interrupted = {
        run, policy, head: trace.head_hash, ordinal: trace.step_count, controller: new AbortController(),
      };
      if (!trace.steps.length) this.emitStep(interrupted, 'TRIGGER', { trigger: run.trigger, mode: run.mode, recovered: true });
      this.emitStep(interrupted, 'REPORT', { status: run.status, error: run.error, recoverable_claims: true });
      void this.writeReceipt(run).catch(() => {
        this.emit('state', { id: run.id, error: 'TRACE_EXPORT_FAILED' });
      });
    }
  }

  private launch(trigger: string, mode: Mode, work: (session: Session) => Promise<void>, caller?: McpCaller, checkControl?: () => void) {
    this.guard();
    if (this.closing || this.active.size) throw new Error('RUN_ALREADY_ACTIVE');
    if (!this.store.acquireLease(this.leaseOwner)) throw new Error('RUN_ALREADY_ACTIVE');
    const { version, policy } = this.store.policy(mode);
    let run: RunRecord;
    try {
      this.recoverInterrupted();
      run = this.store.start(trigger, mode, version, policy);
    } catch (error) {
      this.store.releaseLease(this.leaseOwner);
      throw error;
    }
    run.agent_mode = this.agent.mode;
    run.model_usage = emptyUsage(this.agent);
    if (caller) run.mcp_caller = caller;
    this.store.updateRun(run);
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      if (!this.store.acquireLease(this.leaseOwner)) controller.abort(new Error('RUN_LEASE_LOST'));
      try { checkControl?.(); } catch (error) { controller.abort(error); }
    }, 3000);
    heartbeat.unref();
    const session = { run, policy, controller, ordinal: 0, head: genesisHash, checkControl };
    const unregister = this.config.onRun?.(run.id, controller);
    const done = Promise.resolve().then(async () => {
      try {
        this.emitStep(session, 'TRIGGER', { trigger, mailbox_mode: mode, agent_mode: this.agent.mode, policy_version: version });
        await work(session);
        run.status = 'COMPLETED';
      } catch (error) {
        run.error = errorCode(error);
        const operatorStopped = run.error === 'AGENT_RUN_PAUSED' || run.error === 'AGENT_RUN_CANCELLED';
        run.status = this.halted() || (controller.signal.aborted && !operatorStopped) ? 'HALTED' : 'FAILED';
        run.killSwitchTripped ||= run.status === 'HALTED';
      }
      run.completedAt = new Date().toISOString();
      try {
        const verified = this.store.actions(run.id).filter((action) =>
          action.status === 'VERIFIED' && action.tier < 2 && action.plan.playbook !== 'hostile_input_quarantine');
        run.autonomy = {
          autonomous_verified: verified.length,
          gated_for_approval: this.store.approvals(run.mode, run.id).length,
          blocked_quarantined: Math.max(run.threats, run.autonomy?.blocked_quarantined ?? 0),
        };
        this.emitStep(session, 'REPORT', {
          autonomy: run.autonomy,
          status: run.status, error: run.error, emails: run.emails, conflicts: run.conflicts,
          threats: run.threats, rollback_available: this.hasRollback(run.id),
        }, run.model_usage);
        await this.writeReceipt(run);
      } catch {
        run.status = 'FAILED';
        run.error = 'TRACE_EXPORT_FAILED';
        this.store.updateRun(run);
      } finally {
        clearInterval(heartbeat);
        this.store.releaseLease(this.leaseOwner);
        this.active.delete(run.id);
        unregister?.();
        this.emit('state', { id: run.id, status: run.status });
      }
      return run;
    });
    this.active.set(run.id, { session, done });
    return { run, done };
  }

  stopMission(runId: string, reason: 'AGENT_RUN_PAUSED' | 'AGENT_RUN_CANCELLED') {
    this.active.get(runId)?.session.controller.abort(new Error(reason));
  }

  start(trigger = 'manual', scope: 'inbox' | 'trap' = 'inbox', mode = this.activeMode()) {
    return this.launch(trigger, mode, (session) => this.execute(session, scope));
  }

  private async readPlan(mode: Mode, scope: 'inbox' | 'trap', policy: InboxPolicy, session?: Session) {
    this.guard();
    const now = mode === 'sandbox' ? new Date(sandboxClock) : new Date();
    const reader = mode === 'sandbox' ? sandboxReader(this.store.filename) : liveReader(() => this.config.live!.reader(mode, undefined, session?.controller.signal));
    const read = await reader.read(now, scope, policy, session ? {
      agent: this.agent, signal: session.controller.signal,
      onUsage: (usage, error) => this.recordModel(session, { event: 'MODEL_ANALYSIS', status: error ?? 'VALIDATED' }, usage),
    } : undefined);
    this.guard();
    const target = this.target(mode);
    const plan = buildPlan({
      intents: read.intents, calendar: await target.calendar(), mailStates: read.mailStates, now, policy,
      bills: target.all('bill'), agentMode: session ? this.agent.mode : 'offline-smoke',
      threadSources: read.threadSources,
    });
    return { ...plan, ...read };
  }

  private async execute(session: Session, scope: 'inbox' | 'trap') {
    await this.charge(session);
    const { run, policy } = session;
    const plan = await this.readPlan(run.mode, scope, policy, session);
    run.emails = plan.emailCount;
    run.conflicts = plan.conflicts.length;
    const threats = plan.intents.filter((intent) => intent.kind === 'hostile_suspected');
    run.threats = threats.length;
    const blockedIds = new Set(threats.map((threat) => threat.messageId));
    for (const change of plan.conflicts) this.store.addChange(run.id, change);

    this.emitStep(session, 'PLAN', {
      sources: plan.intents.map((intent) => ({
        msg_id: intent.messageId, thread_id: intent.threadId, sender: intent.sender, received_at: intent.receivedAt,
        kind: intent.kind, confidence: intent.confidence,
        priority: intent.priority ?? 'normal', context_ids: intent.contextIds ?? [], agent_guidance: intent.guidance ?? null,
        evidence: run.mode === 'sandbox' && intent.kind !== 'hostile_suspected' ? intent.evidence : null,
        evidence_hash: sha256(intent.evidence), rule_ids: intent.ruleIds,
      })),
      actions: plan.actions.length, conflicts: plan.conflicts.length,
      blocked_and_quarantined: threats.map((intent) => ({
        msg_id: intent.messageId, sender: intent.sender, threat_type: intent.ruleIds.join(', '),
        policy_rule_id: intent.ruleIds[0], snippet_redacted: '[redacted]',
      })),
    });

    if (threats.filter((intent) => !intent.ruleIds.every((id) => id.startsWith('INPUT_'))).length >= 2) {
      this.emitStep(session, 'POLICY', { rule_id: 'ACTIVE_ATTACK_HALT', detected: threats.length, decision: 'BLOCKED' });
      await this.trip(session, 'ACTIVE_ATTACK_HALT');
    }

    if (scope !== 'trap') await this.reconcile(session);
    const repeats = new Map<string, number>();
    let violations = 0;
    for (const proposal of plan.actions) {
      this.checkout(session);
      const id = actionId(safeAction(proposal), run.mode);
      const verdict = scope === 'trap' && !(proposal.playbook === 'hostile_input_quarantine' &&
        proposal.kind === 'mail' && proposal.target === proposal.intent.messageId) ? {
        decision: 'BLOCKED' as const, tier: 2 as const, ruleId: 'TRAP_ISOLATION',
        reason: 'Trap Pack execution permits quarantine only.',
      } : evaluateAction(proposal, policy);
      if (verdict.decision !== 'BLOCKED') {
        try {
          this.requireMutationScope(run.mode, proposal.kind);
          this.requireSafePayload(run.mode, proposal);
        } catch (failure) {
          const reason = errorCode(failure);
          if (!['SCOPE_UPGRADE_REQUIRED','OUTBOUND_CONTENT_BLOCKED'].includes(reason)) throw failure;
          this.emitStep(session, 'POLICY', { action: proposal.kind, source_msg_id: proposal.intent.messageId, thread_id: proposal.intent.threadId,
            rule_id: reason, decision: 'BLOCKED' });
          continue;
        }
      }
      this.emitStep(session, 'POLICY', {
        action: proposal.kind, target: proposal.target, playbook_id: proposal.playbook, source_msg_id: proposal.intent.messageId,
        thread_id: proposal.intent.threadId, confidence: proposal.intent.confidence,
        rule_id: verdict.ruleId, reason: verdict.reason, decision: verdict.decision, tier: verdict.tier,
        planned: run.mode !== 'sandbox' && ['send','draft'].includes(proposal.kind) ? null : proposal.after,
      });
      if (verdict.decision === 'BLOCKED') {
        blockedIds.add(proposal.intent.messageId);
        run.autonomy = { autonomous_verified: 0, gated_for_approval: 0, blocked_quarantined: blockedIds.size };
        if (++violations >= 2) await this.trip(session, 'POLICY_VIOLATION_BURST');
        continue;
      }
      if (verdict.decision === 'APPROVAL_REQUIRED') {
        const action = { ...safeAction(proposal) };
        const approval: Attention = {
          approval_id: `approval_${id.slice(0, 24)}_v${run.policyVersion}`, run_id: run.id, mode: run.mode,
          priority: proposal.externalGuests || ['urgent', 'high'].includes(proposal.intent.priority ?? '') || /SPOOF|VIP|CONFLICT/.test(verdict.ruleId) ? 'high' : 'medium',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(), triggered_rule_id: verdict.ruleId,
          reason: verdict.reason, proposed_action: action, editable_payload: ['send', 'draft', 'calendar'].includes(action.kind) ? action.after : null,
          status: 'PENDING',
        };
        this.store.addApproval(approval);
        continue;
      }
      const repeated = (repeats.get(id) ?? 0) + 1;
      repeats.set(id, repeated);
      if (repeated >= 3) await this.trip(session, 'IDENTICAL_TOOL_LOOP');
      await this.apply(session, safeAction(proposal), verdict.tier, verdict.ruleId);
    }
  }

  private async reconcile(session: Session) {
    const target = this.target(session.run.mode);
    for (const entry of this.store.unreconciled(session.run.mode)) {
      await this.charge(session);
      const current = await target.read(entry, entry.providerId ?? entry.id);
      this.checkout(session);
      const verified = matches(current, entry.after);
      const check = this.emitStep(session, 'CHECK', {
        action_id: entry.id, outcome: verified ? 'RECONCILED' : 'MANUAL_RECONCILIATION_REQUIRED',
      });
      if (verified) {
        this.store.updateAction({ ...entry, status: 'VERIFIED', traceId: check.id, creationPending: false });
        if (entry.kind === 'handoff') this.handoffs.saveTrace(entry.target, check.id);
        this.store.addChange(entry.runId, toChange(entry));
      }
    }
  }

  async recordMcpRead(mode: Mode, caller: McpCaller, detail: Record<string, unknown> = {}, failure?: string) {
    this.guard();
    const { version, policy } = this.store.policy(mode);
    const run = this.store.start('mcp.' + caller.tool, mode, version, policy);
    run.agent_mode = this.agent.mode;
    run.model_usage = emptyUsage(this.agent);
    run.mcp_caller = caller;
    const session = { run, policy, controller: new AbortController(), ordinal: 0, head: genesisHash };
    this.emitStep(session, 'TRIGGER', { trigger: run.trigger, mailbox_mode: mode });
    this.emitStep(session, 'POLICY', { rule_id: failure ?? 'MCP_SCOPED_READ', decision: failure ? 'BLOCKED' : 'ALLOWED' });
    if (!failure) this.emitStep(session, 'CHECK', { ...detail, action: caller.tool, outcome: 'VERIFIED' });
    run.status = failure ? 'FAILED' : 'COMPLETED';
    run.error = failure ?? null;
    run.completedAt = new Date().toISOString();
    this.emitStep(session, 'REPORT', { status: run.status, error: run.error }, run.model_usage);
    await this.writeReceipt(run);
    this.emit('state', { id: run.id, status: run.status });
  }

  recordScopedEvent<T>(mode: Mode, trigger: string, work: (record: (detail: Record<string, unknown>, stage?: 'PLAN' | 'CHECK') => string) => T, caller?: McpCaller) {
    let result: T | undefined;
    const handle = this.launch(trigger, mode, async (session) => {
      await this.charge(session);
      if (caller) this.emitStep(session, 'POLICY', { rule_id: 'MCP_SCOPED_OPERATION', decision: 'ALLOWED' });
      result = work((detail, stage = 'CHECK') => this.emitStep(session, stage, detail).id);
    }, caller);
    return handle.done.then((run) => {
      if (run.status !== 'COMPLETED') throw new Error(run.error ?? 'INBOX_OPERATION_FAILED');
      return result as T;
    });
  }

  /**
   * Runs an agent mission under the same lease, kill switch, budgets, hash-chained trace, Tier 0/1/2 gate,
   * claim ledger, and read-back verification as inbox runs. Each `execute` call is one policy-checked action.
   */
  mission(trigger: string, mode: Mode, work: (context: MissionContext) => Promise<void>, caller?: McpCaller, checkControl?: () => void) {
    return this.launch(trigger, mode, async (session) => {
      await this.charge(session);
      const context: MissionContext = {
        runId: session.run.id, mode, policy: session.policy, signal: session.controller.signal,
        record: (stage, detail) => this.emitStep(session, stage, detail),
        recordModel: (detail, usage) => this.recordModel(session, detail, usage),
        checkout: () => this.checkout(session),
        charge: () => this.charge(session),
        execute: (action) => this.missionAction(session, action),
        read: async (kind, target) => { this.checkout(session); return this.target(mode).read({ kind, target }); },
        queueBatch: (actions, reason) => this.missionBatch(session, actions, reason),
      };
      await work(context);
      this.checkout(session);
    }, caller, checkControl);
  }

  private async missionAction(session: Session, action: SafeAction): Promise<MissionOutcome> {
    this.checkout(session);
    const { run } = session;
    const base = { action: action.kind, target: action.target, playbook_id: action.playbook, source_msg_id: action.sourceId,
      thread_id: action.threadId };
    try {
      this.requireMutationScope(run.mode, action.kind);
      this.requireSafePayload(run.mode, action);
    } catch (failure) {
      const reason = errorCode(failure);
      if (!['SCOPE_UPGRADE_REQUIRED', 'OUTBOUND_CONTENT_BLOCKED'].includes(reason)) throw failure;
      const policyStep = this.emitStep(session, 'POLICY', { ...base, rule_id: reason, decision: 'BLOCKED', tier: 2 });
      return { decision: 'BLOCKED', tier: 2, ruleId: reason, reason, policyStep, verified: false };
    }
    const verdict = evaluateSafeAction(action, session.policy);
    const policyStep = this.emitStep(session, 'POLICY', { ...base, rule_id: verdict.ruleId, reason: verdict.reason,
      decision: verdict.decision, tier: verdict.tier });
    if (verdict.decision === 'BLOCKED') {
      if ((session.violations = (session.violations ?? 0) + 1) >= 3) await this.trip(session, 'POLICY_VIOLATION_BURST');
      return { ...verdict, policyStep, verified: false };
    }
    if (verdict.decision === 'APPROVAL_REQUIRED') {
      let approvalId = `approval_${actionId(action, run.mode).slice(0, 24)}_v${run.policyVersion}`;
      const existing = this.store.approval(approvalId);
      if (existing && existing.status !== 'PENDING') approvalId = `approval_${sha256(approvalId + run.id).slice(0, 24)}_v${run.policyVersion}`;
      if (!this.store.approval(approvalId)) {
        this.store.addApproval({
          approval_id: approvalId, run_id: run.id, mode: run.mode,
          priority: action.requestedTier === 2 || verdict.ruleId === 'VIP_RECIPIENT' ? 'high' : 'medium',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(), triggered_rule_id: verdict.ruleId, reason: verdict.reason,
          proposed_action: action, editable_payload: ['send', 'draft', 'calendar'].includes(action.kind) ? action.after : null, status: 'PENDING',
        });
      }
      return { ...verdict, policyStep, approvalId, verified: false };
    }
    await this.apply(session, action, verdict.tier, verdict.ruleId);
    const checkStep = session.last?.stage === 'CHECK' && session.last !== policyStep ? session.last : undefined;
    const outcome = String(checkStep?.detail.outcome ?? '');
    return { ...verdict, policyStep, checkStep, outcome,
      verified: ['VERIFIED', 'ALREADY_CURRENT', 'DEDUPLICATED', 'RECONCILED'].includes(outcome) };
  }

  private async missionBatch(session: Session, actions: SafeAction[], reason: string): Promise<MissionOutcome> {
    this.checkout(session);
    const { run } = session;
    for (const action of actions) {
      this.requireMutationScope(run.mode, action.kind);
      this.requireSafePayload(run.mode, action);
    }
    const verdicts = actions.map((action) => evaluateSafeAction(action, session.policy));
    const blocked = verdicts.find((verdict) => verdict.decision === 'BLOCKED');
    if (blocked) {
      const policyStep = this.emitStep(session, 'POLICY', { decision: 'BLOCKED', rule_id: blocked.ruleId, tier: 2, batch_size: actions.length });
      return { ...blocked, policyStep, verified: false };
    }
    if (actions.length <= session.policy.outboundBudget && verdicts.every((verdict) => verdict.decision === 'AUTONOMOUS')) {
      let last: MissionOutcome | undefined;
      for (const action of actions) {
        last = await this.missionAction(session, action);
        if (!last.verified) break;
      }
      return last ?? { decision: 'AUTONOMOUS', tier: 0, ruleId: 'NO_ACTIONS', reason: 'No actions to execute',
        policyStep: this.emitStep(session, 'POLICY', { outcome: 'NO_ACTIONS' }), verified: true };
    }
    const ruleId = 'AGENT_OUTBOUND_BATCH_APPROVAL';
    const version = sha256(canonicalJson(actions.map((action) => actionId(action, run.mode))));
    let id = `approval_${version.slice(0, 24)}_v${run.policyVersion}`;
    if (this.store.approval(id) && this.store.approval(id)?.status !== 'PENDING') {
      id = `approval_${sha256(version + run.id).slice(0, 24)}_v${run.policyVersion}`;
    }
    const policyStep = this.emitStep(session, 'POLICY', { decision: 'APPROVAL_REQUIRED', rule_id: ruleId, tier: 2,
      batch_size: actions.length, approval_id: id });
    this.store.addApproval({
      approval_id: id, run_id: run.id, mode: run.mode, priority: 'high', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      triggered_rule_id: ruleId, reason,
      proposed_action: { kind: 'review', playbook: actions[0]?.playbook ?? 'agent_outbound_batch', sourceId: version, target: version, version,
        after: { messages: actions.length }, requestedTier: 2, confidence: 1 },
      editable_payload: null, batch_actions: actions, status: 'PENDING',
    });
    return { decision: 'APPROVAL_REQUIRED', tier: 2, ruleId, reason, approvalId: id, policyStep, verified: false };
  }

  handoff(caller: string, input: HandoffInput, attribution?: McpCaller) {
    let result: HandoffResult | undefined;
    const handle = this.launch('handoff', 'sandbox', async (session) => {
      await this.charge(session);
      let prepared: ReturnType<HandoffService['prepare']>;
      try {
        prepared = this.handoffs.prepare(caller, input);
      } catch (failure) {
        const step = this.emitStep(session, 'POLICY', { rule_id: errorCode(failure), decision: 'BLOCKED', tier: 2, thread_id: input.thread_id ?? null });
        this.handoffs.reject(caller, input, step.id);
        throw failure;
      }
      const { message, halted, reason } = prepared;
      const action: SafeAction = {
        kind: 'handoff', target: message.id, playbook: 'agent_handoff', sourceId: isPodCaseThread(message.thread_id) && message.hop_count === 1
          ? podCase.messageId : message.thread_id,
        threadId: message.thread_id, version: message.id, after: message, confidence: 1, requestedTier: 1,
      };
      const member = this.handoffs.member(caller)!;
      if (!halted) this.emitStep(session, 'PLAN', { thread_id: message.thread_id, inbound: {
        sender: member.email, received_at: message.created_at, trust_level: 'verified_agent_handoff',
        threat_signals: [], hop_count: message.hop_count, max_hops: message.max_hops,
      } });
      if (halted) {
        const ruleId = 'AGENT_LOOP_PREVENTED';
        const pending = this.store.approvals('sandbox').find((approval) => approval.status === 'PENDING' &&
          approval.triggered_rule_id === ruleId && approval.proposed_action.threadId === message.thread_id);
        const approvalId = pending?.approval_id ??
          `approval_${sha256(message.pod_id + ':' + message.thread_id + ':' + session.run.id).slice(0, 24)}_v${session.run.policyVersion}`;
        this.emitStep(session, 'POLICY', { thread_id: message.thread_id, rule_id: ruleId, tier: 2, decision: 'BLOCKED', confidence: 1,
          taint: 'PRESERVED', secret_scan: 'PASS' });
        const stopped = this.emitStep(session, 'CHECK', { thread_id: message.thread_id, action: 'handoff_to_agent_inbox', outcome: 'LOOP_HALTED',
          rule_id: ruleId, approval_id: approvalId });
        this.store.transaction(() => {
          this.handoffs.write(message, 'LOOP_HALTED', stopped.id);
          this.store.addApproval({
            approval_id: approvalId, run_id: session.run.id, mode: 'sandbox', priority: 'high',
            expires_at: new Date(Date.now() + 86_400_000).toISOString(), triggered_rule_id: ruleId,
            reason: reason + '. Resetting the thread permits a new handoff attempt.',
            proposed_action: { ...action, kind: 'review', target: message.thread_id, after: { pod_id: message.pod_id, thread_id: message.thread_id } },
            editable_payload: null, status: 'PENDING',
          });
        });
        this.emit('warning', { run_id: session.run.id, rule_id: ruleId, thread_id: message.thread_id, trace_step_id: stopped.id });
        result = { status: 'LOOP_HALTED', rule_id: ruleId, thread_id: message.thread_id, approval_id: approvalId, trace_step_id: stopped.id };
        return;
      }
      const verdict = evaluateSafeAction(action, session.policy);
      this.emitStep(session, 'POLICY', { thread_id: message.thread_id, rule_id: verdict.ruleId, decision: verdict.decision,
        tier: verdict.tier, confidence: action.confidence, taint: 'PRESERVED', secret_scan: 'PASS' });
      if (verdict.decision !== 'AUTONOMOUS') throw new Error(verdict.ruleId);
      await this.apply(session, action, verdict.tier, verdict.ruleId);
      const delivered = this.handoffs.delivery(message.id);
      if (!delivered?.trace_step_id) throw new Error('HANDOFF_POST_CONDITION_FAILED');
      result = { status: 'DELIVERED', thread_id: message.thread_id, handoff_id: message.id, headers: message.headers,
        trace_step_id: delivered.trace_step_id };
    }, attribution);
    return handle.done.then((run) => {
      if (run.status !== 'COMPLETED') throw new Error(run.error ?? 'INBOX_OPERATION_FAILED');
      if (!result) throw new Error('HANDOFF_POST_CONDITION_FAILED');
      return { ...result, run_id: run.id };
    });
  }

  submitActions(mode: Mode, actions: SafeAction[], batch = false, caller?: McpCaller) {
    for (const action of actions) {
      this.requireMutationScope(mode, action.kind);
      this.requireSafePayload(mode, action);
    }
    const outcomes: { decision: string; policy_rule_id: string; approval_id?: string }[] = [];
    const handle = this.launch('mcp', mode, async (session) => {
      this.emitStep(session, 'PLAN', { source: 'mcp', count: actions.length, batch });
      if (batch) {
        const verdicts = actions.map((action) => evaluateSafeAction(action, session.policy));
        const blocked = verdicts.find((verdict) => verdict.decision === 'BLOCKED');
        if (blocked) {
          this.emitStep(session, 'POLICY', { decision: 'BLOCKED', rule_id: blocked.ruleId, tier: 2, batch_size: actions.length });
          outcomes.push({ decision: 'BLOCKED', policy_rule_id: blocked.ruleId });
          return;
        }
        if (actions.length > 3 || verdicts.some((verdict) => verdict.decision === 'APPROVAL_REQUIRED')) {
          const ruleId = 'MCP_BATCH_APPROVAL';
          const version = sha256(canonicalJson(actions.map((action) => actionId(action, mode))));
          let id = `approval_${version.slice(0, 24)}_v${session.run.policyVersion}`;
          if (this.store.approval(id)?.status === 'FAILED') {
            id = `approval_${sha256(version + session.run.id).slice(0, 24)}_v${session.run.policyVersion}`;
          }
          this.emitStep(session, 'POLICY', { decision: 'APPROVAL_REQUIRED', rule_id: ruleId, tier: 2, batch_size: actions.length, approval_id: id });
          this.store.addApproval({
            approval_id: id, run_id: session.run.id, mode, priority: 'high', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            triggered_rule_id: ruleId, reason: `Review all ${actions.length} recipients and messages before dispatch.`,
            proposed_action: { kind: 'review', playbook: 'mcp_batch_send', sourceId: version, target: version, version,
              after: { messages: actions.length }, requestedTier: 2, confidence: 1 },
            editable_payload: null, batch_actions: actions, status: 'PENDING',
          });
          outcomes.push({ decision: 'APPROVAL_REQUIRED', policy_rule_id: ruleId, approval_id: id });
          return;
        }
      }
      for (const action of actions) {
        this.checkout(session);
        const verdict = evaluateSafeAction(action, session.policy);
        this.emitStep(session, 'POLICY', { action: action.kind, rule_id: verdict.ruleId, decision: verdict.decision, tier: verdict.tier,
          source_msg_id: action.sourceId, thread_id: action.threadId, confidence: action.confidence });
        const outcome = { decision: verdict.decision, policy_rule_id: verdict.ruleId };
        if (verdict.decision === 'APPROVAL_REQUIRED') {
          const id = `approval_${actionId(action, mode).slice(0, 24)}_v${session.run.policyVersion}`;
          this.store.addApproval({
            approval_id: id, run_id: session.run.id, mode, priority: 'high', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            triggered_rule_id: verdict.ruleId, reason: verdict.reason, proposed_action: action, editable_payload: action.after, status: 'PENDING',
          });
          outcomes.push({ ...outcome, approval_id: id });
        } else {
          outcomes.push(outcome);
          if (verdict.decision === 'AUTONOMOUS') await this.apply(session, action, verdict.tier, verdict.ruleId);
        }
      }
    }, caller);
    return handle.done.then((run) => ({ run_id: run.id, status: run.status, error: run.error, outcomes }));
  }

  private resolveBatch(row: Attention, actions: SafeAction[]) {
    const policy = this.store.policy(row.mode).policy;
    const size = Math.min(policy.outboundBudget, Math.floor(policy.toolBudget / 3));
    if (size < 1) throw new Error('INBOX_BUDGET_EXCEEDED');
    const ids: string[] = [];
    const execute = (chunk: SafeAction[], begin: boolean) => this.launch('approval:' + row.approval_id, row.mode, async (session) => {
      if (begin) {
        // Validate the whole approved group against the current policy before the first provider call.
        for (const action of actions) {
          this.requireMutationScope(row.mode, action.kind);
          this.requireSafePayload(row.mode, action);
          const verdict = evaluateSafeAction(action, session.policy);
          if (verdict.decision === 'BLOCKED') throw new Error(verdict.ruleId);
        }
      }
      ids.push(session.run.id);
      this.store.transaction(() => {
        const current = this.store.approval(row.approval_id);
        if (current?.status !== (begin ? 'PENDING' : 'EXECUTING')) throw new Error('APPROVAL_NOT_PENDING');
        this.store.updateApproval({ ...row, status: 'EXECUTING', execution_run_ids: [...ids] });
      });
      this.emitStep(session, 'POLICY', { rule_id: row.triggered_rule_id, operator_approved: true, tier: 2,
        approval_id: row.approval_id, batch_size: actions.length, chunk_size: chunk.length });
      for (const action of chunk) {
        const verdict = evaluateSafeAction(action, session.policy);
        if (verdict.decision === 'BLOCKED') throw new Error(verdict.ruleId);
        await this.apply(session, action, 2, row.triggered_rule_id);
      }
    });
    const handle = execute(actions.slice(0, size), true);
    return { run: handle.run, done: handle.done.then(async (initial) => {
      let result = initial;
      try {
        for (let offset = size; offset < actions.length && result.status === 'COMPLETED'; offset += size) {
          result = await execute(actions.slice(offset, offset + size), false).done;
        }
      } catch (error) {
        this.store.updateApproval({ ...row, status: 'FAILED', execution_run_ids: ids });
        this.emit('state', { approval: row.approval_id });
        throw error;
      }
      this.store.updateApproval({ ...row, status: result.status === 'COMPLETED' ? 'APPROVED' : 'FAILED', execution_run_ids: ids });
      this.emit('state', { approval: row.approval_id });
      return result;
    }) };
  }

  private async apply(session: Session, action: SafeAction, tier: Tier, ruleId: string) {
    await this.charge(session);
    const { run } = session;
    this.requireMutationScope(run.mode, action.kind);
    const target = this.target(run.mode);
    const id = actionId(action, run.mode);
    const expected = expectedAfter(action, tier);
    const existing = this.store.action(id);
    if (existing && existing.status !== 'ROLLED_BACK') {
      if (existing.status === 'VERIFIED') {
        this.emitStep(session, 'CHECK', { action_id: id, outcome: 'DEDUPLICATED' });
      } else {
        const current = await target.read(action, existing.providerId ?? id);
        this.checkout(session);
        if (matches(current, existing.after)) {
          existing.status = 'VERIFIED';
          existing.creationPending = false;
          existing.traceId = this.emitStep(session, 'CHECK', { action_id: id, outcome: 'RECONCILED', actual: current }).id;
          this.store.updateAction(existing);
        } else {
          this.emitStep(session, 'CHECK', { action_id: id, outcome: 'MANUAL_RECONCILIATION_REQUIRED' });
          if (tier === 2) throw new Error('MANUAL_RECONCILIATION_REQUIRED');
        }
      }
      return;
    }
    const before = await target.read(action);
    this.checkout(session);
    if (action.expectedBefore !== undefined && !matches(before, action.expectedBefore)) {
      this.emitStep(session, 'CHECK', { action: action.kind, target: action.target, outcome: 'TARGET_CHANGED_SINCE_PLAN' });
      if (tier === 2) throw new Error('TARGET_CHANGED_SINCE_PLAN');
      return;
    }
    if (matches(before, expected)) {
      this.emitStep(session, 'CHECK', { action: action.kind, target: action.target, outcome: 'ALREADY_CURRENT' });
      return;
    }
    const key = existing ? sha256(id + '\0' + run.id) : id;
    const entry: Claim = {
      id: key, runId: run.id, mode: run.mode, kind: action.kind, target: action.target,
      before, after: expected, tier, ruleId, plan: action.kind === 'handoff' || (action.kind === 'send' || action.kind === 'draft') && run.mode !== 'sandbox'
        ? { ...action, after: expected } : action, status: 'CLAIMED', providerId: null, traceId: null,
    };
    try {
      if (!this.store.claim(entry).created) return;
    } catch (error) {
      if (errorCode(error) === 'INBOX_BUDGET_EXCEEDED') await this.trip(session, 'INBOX_BUDGET_EXCEEDED');
      throw error;
    }
    if (action.kind === 'send' || action.kind === 'handoff') run.outbound++;
    if (action.kind === 'calendar') run.calendar++;
    this.emitStep(session, 'ACT', {
      action_id: entry.id, action: entry.kind, target: entry.target, rule_id: ruleId,
      source_msg_id: action.sourceId, thread_id: action.threadId, before, expected,
      rollback_handler: ['send','handoff'].includes(entry.kind) ? 'manual_correction' : 'restore_before',
    });
    try {
      await this.charge(session);
      entry.providerId = await target.dispatch(action, tier, before, key, session.controller.signal, (providerId) => {
        // Preserve the identity as soon as creation is acknowledged, before moving or populating the file.
        entry.providerId = providerId;
        entry.creationPending = true;
        this.store.updateAction(entry);
      });
      entry.status = 'APPLIED';
      this.store.updateAction(entry);
      this.checkout(session);
      await this.charge(session);
      const result = await target.read(action, entry.providerId);
      this.checkout(session);
      if (!matches(result, expected)) throw new Error('POST_CONDITION_FAILED');
      entry.status = 'VERIFIED';
      entry.creationPending = false;
      entry.traceId = this.emitStep(session, 'CHECK', { action_id: entry.id, outcome: 'VERIFIED', actual: result, thread_id: action.threadId,
        action: action.kind, playbook_ids: [action.playbook, ...action.relatedPlaybooks ?? []] }).id;
      this.store.updateAction(entry);
      if (action.kind === 'handoff') this.handoffs.saveTrace(action.target, entry.traceId);
      this.store.addChange(run.id, toChange(entry));
    } catch (error) {
      if (this.halted() || session.controller.signal.aborted) throw error;
      entry.status = 'REVIEW_REQUIRED';
      this.store.updateAction(entry);
      this.emitStep(session, 'CHECK', { action_id: entry.id, outcome: 'REVIEW_REQUIRED', reason: errorCode(error) });
      throw error;
    }
  }

  resolveApproval(id: string, approved: boolean, edit?: { subject: string; text: string }, calendarEdit?: { start: string; end: string },
    batchEdits?: { subject: string; text: string }[]) {
    const row = this.store.approval(id);
    if (!row || row.status !== 'PENDING') throw new Error('APPROVAL_NOT_PENDING');
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.store.updateApproval({ ...row, status: 'EXPIRED' });
      throw new Error('APPROVAL_EXPIRED');
    }
    if (batchEdits && (!approved || batchEdits.length !== row.batch_actions?.length)) throw new Error('INVALID_BATCH_EDIT');
    if (approved && row.batch_actions?.length) {
      const actions = batchEdits ? row.batch_actions.map((action, index) => ({ ...action, after: { ...action.after, ...batchEdits[index] } })) : row.batch_actions;
      return this.resolveBatch({ ...row, batch_actions: actions }, actions);
    }
    if (approved && row.triggered_rule_id === 'AGENT_LOOP_PREVENTED') {
      return this.launch('approval:' + id, row.mode, async (session) => {
        const action = row.proposed_action;
        const step = this.emitStep(session, 'POLICY', { rule_id: 'OPERATOR_HANDOFF_RESET', operator_approved: true,
          thread_id: action.threadId, tier: 2 });
        this.store.transaction(() => {
          if (this.store.approval(id)?.status !== 'PENDING' ||
            !this.handoffs.reset(id, String(action.after?.pod_id), action.target, step.id)) throw new Error('APPROVAL_NOT_PENDING');
          this.store.updateApproval({ ...row, status: 'APPROVED' });
        });
      });
    }
    if (!approved || row.proposed_action.kind === 'review') {
      this.store.updateApproval({ ...row, status: approved ? 'APPROVED' : 'REJECTED' });
      this.emit('state', { approval: id });
      return null;
    }
    const action = { ...row.proposed_action };
    this.requireMutationScope(row.mode, action.kind);
    if (edit && (action.kind === 'send' || action.kind === 'draft')) action.after = { ...action.after, ...edit };
    if (calendarEdit && action.kind === 'calendar' && action.after) {
      if (Date.parse(calendarEdit.start) >= Date.parse(calendarEdit.end)) throw new Error('INVALID_CALENDAR_TIME_RANGE');
      const start = new Date(calendarEdit.start).toISOString();
      const end = new Date(calendarEdit.end).toISOString();
      action.after = inboxCalendarSchema.parse({ ...action.after, start, end });
      action.version = sha256(canonicalJson(action.after));
    }
    const verdict = evaluateSafeAction(action, this.store.policy(row.mode).policy);
    this.requireSafePayload(row.mode, action);
    if (verdict.decision === 'BLOCKED') throw new Error(verdict.ruleId);
    const handle = this.launch('approval:' + id, row.mode, async (session) => {
      this.store.transaction(() => {
        if (this.store.approval(id)?.status !== 'PENDING') throw new Error('APPROVAL_NOT_PENDING');
        this.store.updateApproval({ ...row, status: 'EXECUTING' });
      });
      this.emitStep(session, 'PLAN', { approval_id: id, action: action.kind, target: action.target });
      this.emitStep(session, 'POLICY', { rule_id: row.triggered_rule_id, operator_approved: true, tier: 2 });
      try {
        if (action.kind === 'calendar' && action.after) {
          const event = inboxCalendarSchema.parse(action.after);
          const events = await this.target(row.mode).calendar();
          if (events.some((other) => other.id !== event.id && Date.parse(other.start) < Date.parse(event.end) &&
            Date.parse(event.start) < Date.parse(other.end))) throw new Error('CALENDAR_COLLISION');
        }
        await this.apply(session, action, 2, row.triggered_rule_id);
        this.store.updateApproval({ ...row, status: 'APPROVED' });
      } catch (error) {
        this.store.updateApproval({ ...row, status: 'FAILED' });
        throw error;
      }
    });
    return handle;
  }

  rollback(runId: string, actionIds?: string[]) {
    const original = this.store.run(runId);
    if (!original || original.status === 'RUNNING') throw new Error('RUN_NOT_AVAILABLE');
    const entries = this.store.actions(runId).filter((action) =>
      this.isRollbackCandidate(action) &&
      (!actionIds || actionIds.includes(action.id))).reverse();
    if (!entries.length) throw new Error('NO_ROLLBACK_ACTIONS');
    return this.launch('rollback:' + runId, original.mode, async (session) => {
      const target = this.target(original.mode);
      this.emitStep(session, 'PLAN', { original_run: runId, actions: entries.map((entry) => entry.id) });
      let incomplete = false;
      for (const claim of entries) {
        await this.charge(session);
        if (claim.kind === 'send' || claim.kind === 'handoff') {
          this.emitStep(session, 'CHECK', { action_id: claim.id, outcome: claim.kind === 'handoff'
            ? 'DELIVERED_HANDOFF_CANNOT_BE_RECALLED' : 'SENT_MAIL_CANNOT_BE_RECALLED' });
          continue;
        }
        this.emitStep(session, 'POLICY', { action_id: claim.id, rule_id: 'OPERATOR_APPROVED_ROLLBACK' });
        try {
          const current = await target.read(claim, claim.providerId);
          this.checkout(session);
          if (!matches(current, claim.before)) {
            if (!matches(current, claim.after) && !this.matchesUnfinishedCreation(claim, current)) throw new Error('TARGET_CHANGED_SINCE_RUN');
            this.emitStep(session, 'ACT', { action_id: claim.id, restore: claim.before });
            await target.restore(claim, session.controller.signal);
            this.checkout(session);
          }
          const restored = await target.read(claim, claim.providerId);
          if (!matches(restored, claim.before)) throw new Error('ROLLBACK_POST_CONDITION_FAILED');
          this.checkout(session);
          this.store.updateAction({ ...claim, status: 'ROLLED_BACK' });
          this.emitStep(session, 'CHECK', { action_id: claim.id, outcome: 'RESTORED', actual: restored });
          this.store.addChange(session.run.id, toChange({ ...claim, after: claim.before, before: claim.after }));
        } catch (error) {
          if (this.halted()) throw error;
          this.store.updateAction({ ...claim, status: 'ROLLBACK_PENDING' });
          this.emitStep(session, 'CHECK', { action_id: claim.id, outcome: 'ROLLBACK_PENDING', reason: errorCode(error) });
          incomplete = true;
        }
      }
      if (incomplete) throw new Error('ROLLBACK_INCOMPLETE');
    });
  }

  hasRollback(runId: string) {
    return this.store.actions(runId).some((entry) => !['send', 'handoff'].includes(entry.kind) && this.isRollbackCandidate(entry));
  }

  private isRollbackCandidate(claim: Claim) {
    if (claim.status === 'VERIFIED' || claim.status === 'ROLLBACK_PENDING') return true;
    if (this.hasUnfinishedCreation(claim)) return true;
    if (claim.kind !== 'workspace' || claim.before === null || !['CLAIMED', 'APPLIED', 'REVIEW_REQUIRED'].includes(claim.status)) return false;
    const artifact = this.registry.get(claim.mode === 'sandbox' ? claim.mode : claim.mode.slice(5), claim.target);
    return Boolean(artifact?.external_id && !artifact.removed_at && artifact.user_id === claim.plan.workspaceOwner?.userId &&
      (!claim.providerId || claim.providerId === artifact.external_id));
  }

  private hasUnfinishedCreation(claim: Claim) {
    if (claim.kind !== 'workspace' || claim.before !== null || !claim.providerId || !claim.creationPending ||
        !['CLAIMED', 'APPLIED', 'REVIEW_REQUIRED', 'ROLLBACK_PENDING'].includes(claim.status)) return false;
    if (claim.after?.type !== 'google_doc' && claim.after?.type !== 'google_sheet') return false;
    const artifact = this.registry.get(claim.mode === 'sandbox' ? claim.mode : claim.mode.slice(5), claim.target);
    return artifact?.external_id === claim.providerId && artifact.last_updated_by_run_id === claim.runId && !artifact.removed_at;
  }

  private matchesUnfinishedCreation(claim: Claim, current: Snapshot) {
    const expected = claim.after;
    if (!this.hasUnfinishedCreation(claim) || !current || !expected ||
        current.type !== expected.type || current.title !== expected.title ||
        (current.folder !== null && current.folder !== expected.folder)) return false;
    if (current.type === 'google_doc') return Array.isArray(current.sections) && current.sections.length === 0;
    if (!Array.isArray(current.tabs) || !Array.isArray(expected.tabs)) return false;
    const names = expected.tabs.map((tab) => tab.name);
    return current.tabs.length === names.length && current.tabs.every((tab, index) =>
      tab.name === names[index] && tab.headers.length === 0 && tab.rows.length === 0);
  }

  private async writeReceipt(run: RunRecord) {
    const trace = this.store.trace(run.id);
    const markdown = [
      `# Siftvane run ${run.id}`, '',
      `- Trigger: ${run.trigger}`, `- Status: ${run.status}`,
      `- Agent mode: ${run.agent_mode ?? 'offline-smoke'}`,
      `- Model: ${run.model_usage?.provider ?? 'local'}/${run.model_usage?.model ?? 'deterministic-parser'}`,
      `- Prompt/completion tokens: ${run.model_usage?.prompt_tokens ?? 'unavailable'} / ${run.model_usage?.completion_tokens ?? 'unavailable'}`,
      `- Estimated model cost (USD): ${run.model_usage?.estimated_usd ?? 'unavailable'}`,
      `- Messages scanned: ${run.emails}`, `- Conflicts: ${run.conflicts}`,
      `- Threats: ${run.threats}`,
      `- Autonomous & Verified (Tier 0/1): ${run.autonomy?.autonomous_verified ?? 0}`,
      `- Gated for Approval (Tier 2): ${run.autonomy?.gated_for_approval ?? 0}`,
      `- Blocked / Quarantined: ${run.autonomy?.blocked_quarantined ?? 0}`, `- Trace head: ${trace.head_hash}`, '',
      '| Stage | Step | Outcome |', '| --- | --- | --- |',
      ...trace.steps.map((step) => `| ${step.stage} | ${step.id} | ${step.detail.outcome ?? step.detail.decision ?? step.detail.status ?? ''} |`),
    ].join('\n');
    await mkdir(this.config.tracesDir, { recursive: true });
    for (const [ext, content] of [['json', JSON.stringify(trace, null, 2)], ['md', markdown]]) {
      const filename = path.join(this.config.tracesDir, run.id + '.' + ext);
      await writeFile(filename + '.tmp', content + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(filename + '.tmp', filename);
    }
  }

  setSchedule(value: unknown, mode = this.activeMode()) {
    const schedule = inboxScheduleSchema.parse(value);
    const nextAt = schedule.enabled ? schedule.nextAt ?? new Date(Date.now() + scheduleDelay(schedule)).toISOString() : undefined;
    const saved = { ...schedule, nextAt };
    this.store.saveSchedule(mode, saved);
    this.emit('state', { schedule: saved });
    return saved;
  }

  startScheduler() {
    if (this.store.acquireLease(this.leaseOwner)) {
      try { this.recoverInterrupted(); }
      finally { this.store.releaseLease(this.leaseOwner); }
    }
    this.scheduler = setInterval(() => {
      const halted = this.halted();
      if (halted !== this.lastPolledHalt) {
        this.lastPolledHalt = halted;
        if (halted) this.latch(true);
        else this.emit('state', { halted });
      }
      if (!this.active.size && this.store.interruptedRuns().length && this.store.acquireLease(this.leaseOwner)) {
        try { this.recoverInterrupted(); }
        finally { this.store.releaseLease(this.leaseOwner); }
      }
      if (this.halted() || this.active.size) return;
      const due = (['sandbox', ...(this.config.live?.modes() ?? [])] as Mode[]).map((mode) => ({
        mode, schedule: this.store.schedule(mode),
      })).filter(({ schedule }) => schedule.enabled && schedule.nextAt && Date.parse(schedule.nextAt) <= Date.now())
        .sort((a, b) => Date.parse(a.schedule.nextAt!) - Date.parse(b.schedule.nextAt!))[0];
      if (!due) return;
      const { mode, schedule } = due;
      const claimed = this.store.transaction(() => {
        if (this.store.schedule(mode).nextAt !== schedule.nextAt) return false;
        this.store.saveSchedule(mode, { ...schedule, nextAt: new Date(Date.now() + scheduleDelay(schedule)).toISOString() });
        return true;
      });
      if (claimed) {
        try { this.start('scheduled', 'inbox', mode); }
        catch (error) { this.emit('state', { schedule_error: errorCode(error) }); }
      }
    }, 1000);
    this.scheduler.unref();
  }

  async close() {
    this.closing = true;
    clearInterval(this.scheduler);
    for (const { session } of this.active.values()) session.controller.abort(new Error('SHUTDOWN'));
    await Promise.allSettled([...this.active.values()].map(({ done }) => done));
    this.store.close();
  }

  async preview(candidate: unknown, mode = this.activeMode()) {
    const draft = inboxPolicySchema.parse(candidate);
    const { version, policy } = this.store.policy(mode);
    const [current, updated] = await Promise.all([this.readPlan('sandbox', 'inbox', policy), this.readPlan('sandbox', 'inbox', draft)]);
    // Compare the disposition of a hostile source separately from permission to write its quarantine label.
    const hostileSources = new Set([...current.intents, ...updated.intents]
      .filter((intent) => intent.kind === 'hostile_suspected').map((intent) => intent.messageId));
    const decisions = (plan: typeof current, config: InboxPolicy) => {
      const rows = new Map(plan.actions.map((action) => [
        [action.intent.messageId, action.playbook, action.kind, action.target].join('/'),
        { source_msg_id: action.intent.messageId, action: String(action.kind), target: action.target, ...evaluateAction(action, config) },
      ]));
      for (const intent of plan.intents) {
        if (!hostileSources.has(intent.messageId)) continue;
        const blocked = intent.kind === 'hostile_suspected';
        rows.set(intent.messageId + '/ingress', {
          source_msg_id: intent.messageId, action: 'ingress', target: intent.messageId,
          decision: blocked ? 'BLOCKED' : 'AUTONOMOUS', tier: blocked ? 2 : 0,
          ruleId: blocked ? intent.ruleIds[0] ?? 'HOSTILE_INPUT' : 'INGRESS_ACCEPTED',
          reason: blocked ? 'The source is isolated before action planning.' : 'The source may enter policy evaluation.',
        });
      }
      return rows;
    };
    const before = decisions(current, policy);
    const after = decisions(updated, draft);
    return {
      mode: 'offline-smoke', current_version: version, draft_version: version + 1, messages_scanned: current.emailCount,
      rows: [...new Set([...before.keys(), ...after.keys()])].map((id) => ({
        id, before: before.get(id) ?? null, after: after.get(id) ?? null,
        changed: canonicalJson(before.get(id)) !== canonicalJson(after.get(id)),
      })),
    };
  }

  briefing(id?: string, mode = this.activeMode()) {
    const selected = id ? this.store.run(id) : null;
    if (selected) mode = selected.mode;
    const pending = this.store.approvals(mode);
    const billFlags = pending.filter((item) => item.proposed_action.playbook === 'bills_trials_spoof_guard');
    const runs = this.store.runs(mode, false);
    const run = id ? selected : runs.find((item) => !/^(?:rollback|approval):/.test(item.trigger) &&
      (item.trigger !== 'mcp' || this.store.countChanges(item.id) > 0)) ?? null;
    if (id && !run) return null;
    const records = run ? this.store.actions(run.id) : [];
    const trace = run ? this.store.trace(run.id) : null;
    return {
      mode: mode === 'sandbox' ? 'sandbox' : 'live', agent_mode: this.agent.mode, agent_model: this.agent.model,
      halted: this.halted(), last_success: runs.find((item) => item.status === 'COMPLETED') ?? null,
      schedule: this.store.schedule(mode), run_meta: run ? {
        ...run, run_id: run.id, started_at: run.startedAt, completed_at: run.completedAt,
        kill_switch_tripped: run.killSwitchTripped, rollback_available: this.hasRollback(run.id),
        metrics: { emails: run.emails, conflicts: run.conflicts, threats: run.threats, steps: run.steps, calendar: run.calendar, outbound: run.outbound, tokens: run.tokens, usd: run.usd },
      } : null,
      autonomy: run?.autonomy ?? { autonomous_verified: 0, gated_for_approval: 0, blocked_quarantined: 0 },
      changed: run ? this.store.changes<Change>(run.id) : [],
      handled_autonomously: records.filter((action) => action.tier < 2 && action.status === 'VERIFIED').map((action) => ({
        playbook_id: action.plan.playbook, related_playbooks: action.plan.relatedPlaybooks ?? [], action: action.kind, tier: action.tier, entity: action.target,
        policy_rule_id: action.ruleId, verified: true, rollback_id: ['send','handoff'].includes(action.kind) ? null : action.id, trace_step_id: action.traceId,
      })),
      needs_attention: (id ? pending.filter((item) => item.run_id === id) : pending).filter((item) => item.status === 'PENDING'),
      blocked_and_quarantined: trace?.steps.find((step) => Array.isArray(step.detail.blocked_and_quarantined))?.detail.blocked_and_quarantined ?? [],
      digest: {
        upcoming_bills_summary: this.store.entities(mode, 'bill').filter((entry) => entry?.type !== 'history').map<Record<string, unknown>>((entry) => ({
          ...entry, duplicateOrSpoofed: billFlags.some((item) => item.triggered_rule_id === 'DUPLICATE_OR_SPOOFED_INVOICE' &&
            item.proposed_action.after?.invoice === entry?.invoice),
        })),
        bill_flags: billFlags,
        active_deliveries: this.store.entities(mode, 'delivery'),
        waiting_on_commitments: this.store.entities(mode, 'commitment').filter((entry) => !entry?.replied),
        newsletter_rollup: this.store.entities(mode, 'newsletter'),
      },
      playbooks,
    };
  }

  async calendar(mode = this.activeMode()) {
    const runs = this.store.runs(mode, false);
    const pending = this.store.approvals(mode).filter((item) => item.status === 'PENDING' && item.proposed_action.kind === 'calendar');
    const events = mode === 'sandbox' ? this.store.entities('sandbox', 'calendar') : this.halted() ? [] : await this.target(mode).calendar();
    return {
      events, pending,
      changes: runs.flatMap((run) => this.store.actions(run.id).filter((item) => item.kind === 'calendar').map((item) => ({
        id: item.id, run_id: run.id, before: item.before, after: item.after, status: item.status, tier: item.tier,
      }))),
    };
  }

  async ics(mode = this.activeMode()) {
    const data = await this.calendar(mode);
    const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/[\r\n]+/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const date = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Siftvane//Inbox Briefing//EN',
      ...data.events.flatMap((row) => {
        const event = inboxCalendarSchema.parse(row);
        return ['BEGIN:VEVENT', `UID:${escape(event.id)}@siftvane.local`, `DTSTAMP:${date(new Date().toISOString())}`,
          `DTSTART:${date(event.start)}`, `DTEND:${date(event.end)}`, `SUMMARY:${escape(event.title)}`, 'END:VEVENT'];
      }), 'END:VCALENDAR', ''].join('\r\n');
  }
}

const actionId = (action: SafeAction, mode: Mode) => sha256([
  mode, action.sourceId, action.playbook, action.kind, action.target, action.version,
].join('\0'));

const scheduleDelay = (schedule: { frequency: string; intervalMinutes: number }) =>
  (schedule.frequency === 'daily' ? 1440 : schedule.frequency === 'weekly' ? 10080 : schedule.intervalMinutes) * 60_000;

function toChange(action: Claim): Change {
  const before = action.before ?? {};
  const after = action.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) =>
    !['etag', 'accountFingerprint', 'bodyHash', 'subjectHash'].includes(key));
  const diff = Object.fromEntries(keys.filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
    .map((key) => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
  return { type: action.kind as ActionKind, entity: action.target, diff, source_msg_ids: [action.plan.sourceId], conflict_flag: false, next_action: null };
}
