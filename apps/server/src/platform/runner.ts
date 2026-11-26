import { rm } from 'node:fs/promises';
import path from 'node:path';
import { scanOutboundSecrets, scanPromptInjection } from '@clam/shared';
import type { InboxCalendarEvent } from '@clam/shared';
import { safeAttachmentBytes, stageWorkspaceAttachment } from '../inbox/attachmentWorkspace.js';
import { readAttachments } from '../inbox/attachments.js';
import type { McpCaller, Mode, SafeAction } from '../inbox/contracts.js';
import type { InboxEngine, MissionContext } from '../inbox/engine.js';
import { address, domain, stripHtml } from '../inbox/reader.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { sandboxClock, type ReaderMessage } from '../sandbox/seed.js';
import { extractPhotoDetails, type PhotoDetails } from '../workspace/photos.js';
import { sanitizeCell } from '../workspace/sanitize.js';
import { compileIntent, interactivePlan, type WorkflowPlan } from './planner.js';
import type { AgentRecord, PlatformService, ScheduleMode, Service, SourceCli } from './service.js';
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
  private closed = false;

  constructor(private readonly engine: InboxEngine, private readonly platform: PlatformService,
    private readonly options: { webOrigin: string; tickMs?: number }) {
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
      if (this.engine.halted()) return;
      for (const agent of this.platform.waitingAgents()) this.checkApprovals(agent);
      if (this.engine.busy()) return;
      const [due] = this.platform.dueAgents();
      if (due) await this.exclusive(() => this.runAgent(due.id));
    } catch {
      // A failed tick is retried on the next interval; failures are journaled per agent.
    } finally {
      this.ticking = false;
    }
  }

  provision(input: {
    userId: string; inboxId: string; instruction: string; agentName?: string; services?: string[]; scheduleMode?: ScheduleMode;
    intervalSeconds?: number; autoSwitch: boolean; sourceCli: SourceCli; switchedBy: 'cli_auto' | 'web_ui';
  }) {
    this.engine.guard();
    const compiled = compileIntent(input.instruction, { services: input.services, mode: input.inboxId === 'sandbox' ? 'sandbox' : 'live' });
    const services = [...new Set([...compiled.services, ...(input.services ?? []).filter((value): value is Service =>
      ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'].includes(value))])];
    const scheduleMode = input.scheduleMode ?? compiled.scheduleMode;
    const agent = this.platform.createAgent({
      userId: input.userId, inboxId: input.inboxId, name: input.agentName?.trim() || compiled.name, goal: input.instruction,
      sourceCli: input.sourceCli, services, plan: compiled.plan, scheduleMode,
      intervalSeconds: input.intervalSeconds ?? (scheduleMode === 'continuous' ? 300 : scheduleMode === 'daily' ? 86_400 : scheduleMode === 'weekly' ? 604_800 : null),
    });
    this.platform.log({ userId: input.userId, agentId: agent.id, runId: null, service: 'system', action: 'compile_plan',
      input: input.instruction, output: `${compiled.plan.planner}: ${compiled.plan.template} · ${compiled.plan.steps.length} steps · ${services.join(', ')}`,
      verdict: 'ALLOW_TIER_0', ruleId: 'PLAN_VALIDATED', verified: true });
    const switched = input.autoSwitch ? this.platform.switchAgent(input.userId, agent.id, input.switchedBy,
      input.switchedBy === 'cli_auto' ? `Auto-switched after ${input.sourceCli} provisioned "${agent.name}"` : `Created "${agent.name}" from the web console`) : null;
    setImmediate(() => void this.tick());
    return {
      agent_id: agent.id, name: agent.name, status: agent.status, switched: Boolean(switched),
      plan_summary: {
        template: compiled.plan.template, planner: compiled.plan.planner, services, schedule_mode: scheduleMode,
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

  private checkApprovals(agent: AgentRecord) {
    const statuses = agent.state.pending_approvals.map((id) => this.engine.store.approval(id)?.status ?? 'FAILED');
    if (statuses.some((status) => status === 'PENDING' || status === 'EXECUTING')) return;
    const approved = statuses.filter((status) => status === 'APPROVED').length;
    const log = (action: string, output: string, verified: boolean) => this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: null,
      service: agent.state.phase === 'awaiting_review' ? 'policy' : 'gmail', action, input: agent.state.pending_approvals.join(', '), output,
      verdict: 'GATE_TIER_2', ruleId: 'OPERATOR_DECISION', verified });
    if (agent.state.phase === 'awaiting_rfq_approval') {
      if (approved) {
        log('rfq_batch_approved', 'Operator approved the RFQ batch; resuming to collect vendor quotes.', true);
        this.platform.updateAgent(agent.id, { status: 'active', next_run_at: new Date().toISOString(),
          state: { ...agent.state, phase: 'awaiting_quotes', pending_approvals: [], phase_started_at: new Date().toISOString() } });
      } else {
        log('rfq_batch_declined', 'Operator declined the RFQ batch; no vendor was contacted.', true);
        this.platform.updateAgent(agent.id, { status: 'completed', next_run_at: null, state: { ...agent.state, phase: 'done', pending_approvals: [] } });
      }
      return;
    }
    if (agent.state.phase === 'awaiting_booking_approval') {
      const sent = approved ? this.verifiedSends(agent.state.pending_approvals) : [];
      log(approved ? 'booking_confirmation_sent' : 'booking_declined', approved
        ? `Operator approved; purchase confirmation sent and verified (${sent.length} message).` : 'Operator declined the booking; nothing was committed.', true);
      this.platform.updateAgent(agent.id, { status: 'completed', next_run_at: null, state: { ...agent.state, phase: 'done', pending_approvals: [] } });
      return;
    }
    log('review_resolved', `Operator resolved ${statuses.length} flagged item(s).`, true);
    this.platform.updateAgent(agent.id, { ...this.afterRun(agent), state: { ...agent.state, phase: 'start', pending_approvals: [] } });
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
    const agent = this.platform.agent(id);
    if (!agent || agent.status !== 'active') return null;
    const mode = modeFor(agent.inbox_id);
    // Claim the agent before starting so a second tick cannot launch it twice.
    this.platform.updateAgent(id, { next_run_at: null, last_run_at: new Date().toISOString(), run_count: agent.run_count + 1 });
    let pending: string[] = [];
    let phase = agent.state.phase;
    let notes: string[] = [];
    const handle = this.engine.mission('agent:' + agent.id, mode, async (context) => {
      context.record('PLAN', { agent_id: agent.id, agent_name: agent.name, template: agent.workflow_plan.template, phase,
        planner: agent.workflow_plan.planner, steps: agent.workflow_plan.steps.map((step) => step.id) });
      const ops = new WorkspaceOps(context, this.engine.workspace(mode), this.platform,
        { userId: agent.user_id, agentId: agent.id, inboxId: agent.inbox_id }, this.engine.stagingRoot());
      const result = await this.execute(agent, context, ops);
      pending = result.pending;
      phase = result.phase;
      notes = result.notes;
    });
    const run = await handle.done;
    const latest = this.platform.agent(id)!;
    if (run.status === 'HALTED' || this.engine.halted()) {
      if (!['halted'].includes(latest.status)) this.platform.updateAgent(id, { status: 'halted', next_run_at: null,
        state: { ...latest.state, last_error: run.error, last_run_id: run.id } });
      return run;
    }
    if (run.status !== 'COMPLETED') {
      this.platform.log({ userId: agent.user_id, agentId: agent.id, runId: run.id, service: 'system', action: 'mission_failed',
        input: phase, output: run.error ?? 'Mission failed', verdict: 'BLOCKED', ruleId: run.error ?? 'MISSION_FAILED', verified: false });
      this.platform.updateAgent(id, { status: 'paused', next_run_at: null, state: { ...latest.state, last_error: run.error, last_run_id: run.id } });
      return run;
    }
    const state = { ...latest.state, phase, pending_approvals: pending, last_error: null, last_run_id: run.id, notes,
      ...(phase !== latest.state.phase ? { phase_started_at: new Date().toISOString() } : {}) };
    if (pending.length) this.platform.updateAgent(id, { status: 'input_required', next_run_at: null, state });
    else if (phase === 'awaiting_quotes') {
      this.platform.updateAgent(id, { status: 'active', state,
        next_run_at: new Date(Date.now() + (agent.inbox_id === 'sandbox' ? 0 : (agent.interval_seconds ?? 300) * 1000)).toISOString() });
    } else if (phase === 'done') this.platform.updateAgent(id, { status: 'completed', next_run_at: null, state });
    else this.platform.updateAgent(id, { ...this.afterRun(agent), state });
    return run;
  }

  private execute(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    switch (agent.workflow_plan.template) {
      case 'invoice_ledger': return this.invoiceLedger(agent, context, ops);
      case 'vendor_rfq': return this.vendorRfq(agent, context, ops);
      case 'photo_receipts': return this.photoReceipts(agent, context, ops);
      case 'inbox_digest': return this.inboxDigest(agent, context, ops);
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

  private async photoRows(agent: AgentRecord, context: MissionContext, ops: WorkspaceOps) {
    const adapter = this.engine.workspace(context.mode);
    const items = await adapter.searchPhotos({ category: 'RECEIPTS', limit: 10 });
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
    const messages = await this.engine.readMessages(context.mode);
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

    const photos = plan.params.include_photos ? await this.photoRows(agent, context, ops) : [];
    const month = this.today(context.mode).slice(0, 7);
    const folderPath = [...plan.params.folder_path ?? ['Clam', 'Invoices'], month];
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

    const sheetTitle = plan.params.sheet_title ?? 'Clam Invoice Ledger';
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
    await ops.upsertDoc(plan.params.doc_title ?? 'Clam Invoice Summary', parent, `Daily invoice digest - ${this.today(context.mode)}`, [
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
      const state = this.platform.agent(agent.id)!.state;
      this.platform.updateAgent(agent.id, { state: { ...state, sent_vendors: vendors } });
      return outcome.approvalId ? { pending: [outcome.approvalId], phase: 'awaiting_rfq_approval', notes: [] } : { pending: [], phase: 'awaiting_quotes', notes: [] };
    }

    // awaiting_quotes: only vendors whose RFQ was actually sent and verified count as contacted.
    const actions = vendors.map((vendor) => this.rfqAction(agent, vendor, item));
    const sent = vendors.filter((_vendor, index) => this.engine.store.sqlite.prepare(
      "SELECT 1 FROM inbox_actions WHERE kind='send' AND target=? AND status='VERIFIED'").get(actions[index].target));
    if (context.mode === 'sandbox' && sent.length) {
      // $0 sandbox mail delivery: vendors reply only to RFQs that really left Clam.
      const delivered = this.engine.store.sqlite.prepare(`UPDATE inbox_sandbox_messages SET scope='workspace'
        WHERE scope='vendor_pending' AND lower(json_extract(body,'$.from')) IN (${sent.map(() => '?').join(',')})`).run(...sent).changes;
      if (Number(delivered)) this.logRead(agent, context, 'gmail', 'sandbox_vendor_replies', `${sent.length} RFQs verified as sent`, `${delivered} vendor replies delivered to the sandbox inbox`);
    }
    const messages = await this.engine.readMessages(context.mode);
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
    if (!priced.length) return { pending: [], phase: 'awaiting_quotes', notes: ['Waiting for vendor replies'] };

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
    const details = await this.photoRows(agent, context, ops);
    const sheetTitle = agent.workflow_plan.params.sheet_title ?? 'Clam Receipts';
    await ops.ensureSpreadsheet(sheetTitle, null, [{ name: 'Receipts', headers: ['Date', 'Merchant', 'Reference', 'Amount', 'Currency', 'Pay By', 'Source Photo'] }]);
    await ops.appendRows(sheetTitle, 'Receipts', details.map((item) => [item.fields.date ?? '', item.fields.merchant ?? 'Unknown', item.fields.reference ?? '',
      item.fields.amount ?? '', item.fields.currency ?? '', item.fields.due ?? '', item.media_item_id]), 'Source Photo');
    if (agent.workflow_plan.params.calendar_reminders) {
      for (const item of details.filter((entry) => entry.fields.due)) {
        const id = 'clam-reminder-' + sha256(item.media_item_id).slice(0, 16);
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
    const messages = (await this.engine.readMessages(context.mode)).filter((message) => !message.contextOnly && !message.sent);
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
    await ops.upsertDoc(doc_title ?? 'Clam Digest', folder, `Digest - ${this.today(context.mode)}`, [
      `Request: ${agent.goal_prompt.slice(0, 300)}`, `Messages reviewed: ${messages.length}; included: ${selected.length}.`,
      ...selected.map((message) => `• ${message.receivedAt.slice(0, 10)} · ${address(message.from)} · ${this.engine.redact(context.mode, message.subject)}`),
    ].join('\n'), 'replace_section');
    return { pending: [], phase: 'start', notes: [...ops.flags] };
  }
}

export type { WorkflowPlan };
export { namespace };
