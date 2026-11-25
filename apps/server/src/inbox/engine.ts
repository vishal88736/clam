import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inboxCalendarSchema, inboxPolicySchema, inboxScheduleSchema, type InboxPolicy, type InboxStage } from '@clam/shared';
import type { ReaderMessage } from '../sandbox/seed.js';
import { sandboxClock } from '../sandbox/seed.js';
import type { ActionKind, Attention, Change, Claim, InboxTarget, Mode, RunRecord, SafeAction, Snapshot, Tier, TraceStep } from './contracts.js';
import { reviewConfidence } from './model.js';
import type { ClassifierRuntimeConfig } from '../policy/classifier.js';
import { buildPlan, playbooks } from './playbooks/index.js';
import { evaluateAction, evaluateSafeAction, safeAction } from './policy.js';
import { liveReader, sandboxReader } from './reader.js';
import { InboxStore } from './store.js';
import { expectedAfter, matches, SandboxTarget } from './targets.js';
import { canonicalJson, genesisHash, hashStep, sha256 } from './trace.js';

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
  live?: { target: (guard: () => void, store: InboxStore) => InboxTarget; reader: () => Promise<ReaderMessage[]>; ready: () => boolean };
  modelReview?: { config: () => Promise<ClassifierRuntimeConfig>; input: number; output: number };
  sandboxTarget?: (store: InboxStore, guard: () => void) => InboxTarget;
}

type Session = {
  run: RunRecord;
  policy: InboxPolicy;
  head: string;
  ordinal: number;
  controller: AbortController;
};

export class InboxEngine extends EventEmitter {
  readonly store: InboxStore;
  private readonly leaseOwner = randomUUID();
  private readonly active = new Map<string, { done: Promise<RunRecord>; session: Session }>();
  private readonly sandboxTarget: InboxTarget;
  private readonly liveTarget: InboxTarget | null;
  private scheduler: NodeJS.Timeout | undefined;
  private closing = false;
  private lastPolledHalt = false;

  constructor(private readonly config: EngineOptions) {
    super();
    this.store = new InboxStore(config.databasePath);
    this.sandboxTarget = config.sandboxTarget?.(this.store, this.guard) ?? new SandboxTarget(this.store, this.guard);
    this.liveTarget = config.live?.target(this.guard, this.store) ?? null;
  }

  activeMode(): Mode {
    return this.config.live?.ready() ? 'live' : 'sandbox';
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
    if (!this.liveTarget || !this.config.live?.ready()) throw new Error('LIVE_ADAPTER_UNAVAILABLE');
    return this.liveTarget;
  }

  private async trip(session: Session, reason: string): Promise<never> {
    session.run.killSwitchTripped = true;
    this.latch(true);
    await this.config.onTrip?.(reason, session.run.id);
    throw new Error(reason);
  }

  private emitStep(session: Session, stage: InboxStage, detail: Record<string, unknown>): TraceStep {
    const { run } = session;
    const data = {
      id: `${run.id}:${++session.ordinal}`, stage, run_id: run.id, timestamp: new Date().toISOString(),
      detail, prev_hash: session.head,
      budgets: { outbound: run.outbound, calendar: run.calendar, steps: run.steps, tokens: run.tokens, usd: run.usd },
    };
    const step = { ...data, step_hash: hashStep(data) };
    this.store.transaction(() => {
      this.store.addStep(step, session.ordinal);
      this.store.updateRun(run);
    });
    session.head = step.step_hash;
    this.emit('step', step);
    return step;
  }

  private checkout(session: Session) {
    this.guard();
    session.controller.signal.throwIfAborted();
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

  private launch(trigger: string, mode: Mode, work: (session: Session) => Promise<void>) {
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
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      if (!this.store.acquireLease(this.leaseOwner)) controller.abort(new Error('RUN_LEASE_LOST'));
    }, 3000);
    heartbeat.unref();
    const session = { run, policy, controller, ordinal: 0, head: genesisHash };
    const unregister = this.config.onRun?.(run.id, controller);
    const done = Promise.resolve().then(async () => {
      try {
        this.emitStep(session, 'TRIGGER', { trigger, mode, policy_version: version });
        await work(session);
        run.status = 'COMPLETED';
      } catch (error) {
        run.error = errorCode(error);
        run.status = this.halted() || controller.signal.aborted ? 'HALTED' : 'FAILED';
        run.killSwitchTripped ||= run.status === 'HALTED';
      }
      run.completedAt = new Date().toISOString();
      try {
        this.emitStep(session, 'REPORT', {
          status: run.status, error: run.error, emails: run.emails, conflicts: run.conflicts,
          threats: run.threats, rollback_available: this.hasRollback(run.id),
        });
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

  start(trigger = 'manual', scope: 'inbox' | 'trap' = 'inbox', mode = this.activeMode()) {
    return this.launch(trigger, mode, (session) => this.execute(session, scope));
  }

  private async readPlan(mode: Mode, scope: 'inbox' | 'trap', policy: InboxPolicy, signal?: AbortSignal) {
    this.guard();
    const now = mode === 'sandbox' ? new Date(sandboxClock) : new Date();
    const reader = mode === 'sandbox' ? sandboxReader(this.store.filename) : liveReader(this.config.live!.reader);
    const read = await reader.read(now, scope, policy);
    this.guard();
    const review = mode === 'live' && this.config.modelReview ? await reviewConfidence(
      read.intents, await this.config.modelReview.config(), this.config.modelReview, signal,
    ) : { intents: read.intents, tokens: 0, usd: 0, modelReview: 'deterministic' };
    this.guard();
    const target = this.target(mode);
    const plan = buildPlan({
      intents: review.intents, calendar: await target.calendar(), mailStates: read.mailStates, now, policy,
      bills: target.all('bill'),
    });
    return { ...plan, ...read, ...review };
  }

  private async execute(session: Session, scope: 'inbox' | 'trap') {
    await this.charge(session);
    const { run, policy } = session;
    const plan = await this.readPlan(run.mode, scope, policy, session.controller.signal);
    run.emails = plan.emailCount;
    run.conflicts = plan.conflicts.length;
    run.tokens = plan.tokens;
    run.usd = plan.usd;
    const threats = plan.intents.filter((intent) => intent.kind === 'hostile_suspected');
    run.threats = threats.length;
    for (const change of plan.conflicts) this.store.addChange(run.id, change);

    this.emitStep(session, 'PLAN', {
      sources: plan.intents.map((intent) => ({
        msg_id: intent.messageId, kind: intent.kind, confidence: intent.confidence,
        evidence: run.mode === 'sandbox' && intent.kind !== 'hostile_suspected' ? intent.evidence : null,
        evidence_hash: sha256(intent.evidence), rule_ids: intent.ruleIds,
      })),
      actions: plan.actions.length, conflicts: plan.conflicts.length, model_review: plan.modelReview,
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
      const verdict = evaluateAction(proposal, policy);
      this.emitStep(session, 'POLICY', {
        action: proposal.kind, target: proposal.target, playbook_id: proposal.playbook, source_msg_id: proposal.intent.messageId,
        rule_id: verdict.ruleId, reason: verdict.reason, decision: verdict.decision, tier: verdict.tier, planned: proposal.after,
      });
      if (verdict.decision === 'BLOCKED') {
        if (++violations >= 2) await this.trip(session, 'POLICY_VIOLATION_BURST');
        continue;
      }
      if (verdict.decision === 'APPROVAL_REQUIRED') {
        const action = { ...safeAction(proposal) };
        const approval: Attention = {
          approval_id: `approval_${id.slice(0, 24)}_v${run.policyVersion}`, run_id: run.id, mode: run.mode,
          priority: proposal.externalGuests || /SPOOF|VIP|CONFLICT/.test(verdict.ruleId) ? 'high' : 'medium',
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
        this.store.updateAction({ ...entry, status: 'VERIFIED', traceId: check.id });
        this.store.addChange(entry.runId, toChange(entry));
      }
    }
  }

  private async apply(session: Session, action: SafeAction, tier: Tier, ruleId: string) {
    await this.charge(session);
    const { run } = session;
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
      before, after: expected, tier, ruleId, plan: (action.kind === 'send' || action.kind === 'draft') && run.mode === 'live'
        ? { ...action, after: expected } : action, status: 'CLAIMED', providerId: null, traceId: null,
    };
    try {
      if (!this.store.claim(entry).created) return;
    } catch (error) {
      if (errorCode(error) === 'INBOX_BUDGET_EXCEEDED') await this.trip(session, 'INBOX_BUDGET_EXCEEDED');
      throw error;
    }
    if (action.kind === 'send') run.outbound++;
    if (action.kind === 'calendar') run.calendar++;
    this.emitStep(session, 'ACT', {
      action_id: entry.id, action: entry.kind, target: entry.target, rule_id: ruleId,
      source_msg_id: action.sourceId, before, expected, rollback_handler: entry.kind === 'send' ? 'manual_correction' : 'restore_before',
    });
    try {
      await this.charge(session);
      entry.providerId = await target.dispatch(action, tier, before, key, session.controller.signal);
      this.checkout(session);
      entry.status = 'APPLIED';
      this.store.updateAction(entry);
      await this.charge(session);
      const result = await target.read(action, entry.providerId);
      this.checkout(session);
      if (!matches(result, expected)) throw new Error('POST_CONDITION_FAILED');
      entry.status = 'VERIFIED';
      entry.traceId = this.emitStep(session, 'CHECK', { action_id: entry.id, outcome: 'VERIFIED', actual: result }).id;
      this.store.updateAction(entry);
      this.store.addChange(run.id, toChange(entry));
    } catch (error) {
      if (this.halted() || session.controller.signal.aborted) throw error;
      entry.status = 'REVIEW_REQUIRED';
      this.store.updateAction(entry);
      this.emitStep(session, 'CHECK', { action_id: entry.id, outcome: 'REVIEW_REQUIRED', reason: errorCode(error) });
      throw error;
    }
  }

  resolveApproval(id: string, approved: boolean, edit?: { subject: string; text: string }, calendarEdit?: { start: string; end: string }) {
    const row = this.store.approval(id);
    if (!row || row.status !== 'PENDING') throw new Error('APPROVAL_NOT_PENDING');
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.store.updateApproval({ ...row, status: 'EXPIRED' });
      throw new Error('APPROVAL_EXPIRED');
    }
    if (!approved || row.proposed_action.kind === 'review') {
      this.store.updateApproval({ ...row, status: approved ? 'APPROVED' : 'REJECTED' });
      this.emit('state', { approval: id });
      return null;
    }
    const action = { ...row.proposed_action };
    if (edit && (action.kind === 'send' || action.kind === 'draft')) action.after = { ...action.after, ...edit };
    if (calendarEdit && action.kind === 'calendar' && action.after) {
      if (Date.parse(calendarEdit.start) >= Date.parse(calendarEdit.end)) throw new Error('INVALID_CALENDAR_TIME_RANGE');
      const start = new Date(calendarEdit.start).toISOString();
      const end = new Date(calendarEdit.end).toISOString();
      action.after = inboxCalendarSchema.parse({ ...action.after, start, end });
      action.version = sha256(canonicalJson(action.after));
    }
    const verdict = evaluateSafeAction(action, this.store.policy(row.mode).policy);
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
      (action.status === 'VERIFIED' || action.status === 'ROLLBACK_PENDING') &&
      (!actionIds || actionIds.includes(action.id))).reverse();
    if (!entries.length) throw new Error('NO_ROLLBACK_ACTIONS');
    return this.launch('rollback:' + runId, original.mode, async (session) => {
      const target = this.target(original.mode);
      this.emitStep(session, 'PLAN', { original_run: runId, actions: entries.map((entry) => entry.id) });
      let incomplete = false;
      for (const claim of entries) {
        await this.charge(session);
        if (claim.kind === 'send') {
          this.emitStep(session, 'CHECK', { action_id: claim.id, outcome: 'SENT_MAIL_CANNOT_BE_RECALLED' });
          continue;
        }
        this.emitStep(session, 'POLICY', { action_id: claim.id, rule_id: 'OPERATOR_APPROVED_ROLLBACK' });
        const current = await target.read(claim, claim.providerId);
        try {
          this.checkout(session);
          if (!matches(current, claim.before)) {
            if (!matches(current, claim.after)) throw new Error('TARGET_CHANGED_SINCE_RUN');
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
    return this.store.actions(runId).some((entry) => entry.kind !== 'send' && ['VERIFIED', 'ROLLBACK_PENDING'].includes(entry.status));
  }

  private async writeReceipt(run: RunRecord) {
    const trace = this.store.trace(run.id);
    const markdown = [
      `# Clam run ${run.id}`, '',
      `- Trigger: ${run.trigger}`, `- Status: ${run.status}`,
      `- Messages scanned: ${run.emails}`, `- Conflicts: ${run.conflicts}`,
      `- Threats: ${run.threats}`, `- Trace head: ${trace.head_hash}`, '',
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

  setSchedule(value: unknown) {
    const schedule = inboxScheduleSchema.parse(value);
    const nextAt = schedule.enabled ? schedule.nextAt ?? new Date(Date.now() + scheduleDelay(schedule)).toISOString() : undefined;
    const saved = { ...schedule, nextAt };
    this.store.setState('schedule', saved);
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
      const schedule = this.store.schedule();
      if (!schedule.enabled || !schedule.nextAt || Date.parse(schedule.nextAt) > Date.now() || this.halted() || this.active.size) return;
      const claimed = this.store.transaction(() => {
        if (this.store.schedule().nextAt !== schedule.nextAt) return false;
        this.store.setState('schedule', { ...schedule, nextAt: new Date(Date.now() + scheduleDelay(schedule)).toISOString() });
        return true;
      });
      if (claimed) {
        try { this.start('scheduled'); }
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

  async preview(candidate: unknown) {
    const draft = inboxPolicySchema.parse(candidate);
    const { version, policy } = this.store.policy(this.activeMode());
    const [current, updated] = await Promise.all([this.readPlan('sandbox', 'inbox', policy), this.readPlan('sandbox', 'inbox', draft)]);
    const decisions = (plan: typeof current, config: InboxPolicy) => new Map(plan.actions.map((action) => [
      [action.intent.messageId, action.playbook, action.kind, action.target].join('/'),
      { source_msg_id: action.intent.messageId, action: action.kind, target: action.target, ...evaluateAction(action, config) },
    ]));
    const before = decisions(current, policy);
    const after = decisions(updated, draft);
    return {
      current_version: version, draft_version: version + 1, messages_scanned: current.emailCount,
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
    const runs = this.store.runs(mode);
    const run = id ? selected : runs.find((item) => !/^(?:rollback|approval):/.test(item.trigger)) ?? null;
    if (id && !run) return null;
    const records = run ? this.store.actions(run.id) : [];
    const trace = run ? this.store.trace(run.id) : null;
    return {
      mode, halted: this.halted(), last_success: runs.find((item) => item.status === 'COMPLETED') ?? null,
      schedule: this.store.schedule(), run_meta: run ? {
        ...run, run_id: run.id, started_at: run.startedAt, completed_at: run.completedAt,
        kill_switch_tripped: run.killSwitchTripped, rollback_available: this.hasRollback(run.id),
        metrics: { emails: run.emails, conflicts: run.conflicts, threats: run.threats, steps: run.steps, calendar: run.calendar, outbound: run.outbound, tokens: run.tokens, usd: run.usd },
      } : null,
      changed: run ? this.store.changes<Change>(run.id) : [],
      handled_autonomously: records.filter((action) => action.tier < 2 && action.status === 'VERIFIED').map((action) => ({
        playbook_id: action.plan.playbook, action: action.kind, tier: action.tier, entity: action.target,
        policy_rule_id: action.ruleId, verified: true, rollback_id: action.kind === 'send' ? null : action.id, trace_step_id: action.traceId,
      })),
      needs_attention: (id ? pending.filter((item) => item.run_id === id) : pending).filter((item) => item.status === 'PENDING'),
      blocked_and_quarantined: trace?.steps.find((step) => step.stage === 'PLAN')?.detail.blocked_and_quarantined ?? [],
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
    const runs = this.store.runs(mode);
    const pending = this.store.approvals(mode).filter((item) => item.status === 'PENDING' && item.proposed_action.kind === 'calendar');
    const events = mode === 'sandbox' ? this.store.entities('sandbox', 'calendar') : this.halted() ? [] : await this.target(mode).calendar();
    return {
      events, pending,
      changes: runs.flatMap((run) => this.store.actions(run.id).filter((item) => item.kind === 'calendar').map((item) => ({
        id: item.id, run_id: run.id, before: item.before, after: item.after, status: item.status, tier: item.tier,
      }))),
    };
  }

  async ics() {
    const data = await this.calendar();
    const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/[\r\n]+/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const date = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Clam//Inbox Briefing//EN',
      ...data.events.flatMap((row) => {
        const event = inboxCalendarSchema.parse(row);
        return ['BEGIN:VEVENT', `UID:${escape(event.id)}@clam.local`, `DTSTAMP:${date(new Date().toISOString())}`,
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
