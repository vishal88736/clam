import { rm } from 'node:fs/promises';
import path from 'node:path';
import { scanOutboundSecrets, scanPromptInjection, verificationNotice, type InboxCalendarEvent } from '@siftvane/shared';
import { safeAttachmentBytes, stageWorkspaceAttachment } from '../inbox/attachmentWorkspace.js';
import { readAttachments } from '../inbox/attachments.js';
import type { SafeAction } from '../inbox/contracts.js';
import type { InboxEngine, MissionContext, MissionOutcome } from '../inbox/engine.js';
import { address, stripHtml } from '../inbox/reader.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { sandboxClock, type ReaderMessage } from '../sandbox/seed.js';
import { extractPhotoDetails } from '../workspace/photos.js';
import { sanitizeCell, sanitizeText } from '../workspace/sanitize.js';
import { describeStep, genericStepSchema, genericStepScopes, opService, type GenericStep } from './generic.js';
import { llmReview } from './llmPlanner.js';
import { emailsIn, workflowPlanSchema } from './planner.js';
import type { AgentRecord, LogService, PlatformService } from './service.js';
import { verdictLabel, type WorkspaceOps } from './workspaceOps.js';

type Value = string | number;
interface Row { fields: Record<string, Value>; message?: ReaderMessage }
interface StepResult { rows: Row[]; text?: string; notes: string[] }

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const synonyms: Record<string, string[]> = {
  amount: ['amount', 'total', 'price', 'unit_price', 'cost', 'fine'], total: ['total', 'amount'], price: ['price', 'unit_price', 'amount'],
  due: ['due', 'due_date', 'pay_by', 'deadline'], due_date: ['due_date', 'due', 'pay_by', 'deadline'], deadline: ['deadline', 'due', 'due_date'],
  from: ['from', 'sender'], sender: ['sender', 'from'], vendor: ['vendor', 'merchant', 'from'], merchant: ['merchant', 'vendor'],
  invoice: ['invoice', 'invoice_number', 'reference'], invoice_number: ['invoice', 'reference'], reference: ['reference', 'invoice', 'ticket', 'order'],
  source_id: ['message_id', 'media_item_id'], link: ['drive_link'], drive_link: ['drive_link'], date: ['date', 'received'],
};
const lookup = (row: Row, column: string): Value => {
  const name = key(column);
  for (const candidate of [name, ...(synonyms[name] ?? [])]) if (row.fields[candidate] !== undefined) return row.fields[candidate];
  const partial = Object.keys(row.fields).find((field) => field.includes(name) || (name.length > 3 && name.includes(field)));
  return partial ? row.fields[partial] : '';
};
const money = (text: string) => /(-?[0-9]{1,9}(?:\.[0-9]{1,2})?)/.exec(text)?.[1];

class PickerRequired extends Error { constructor(readonly uri: string) { super('PHOTOS_PICKER_SELECTION_REQUIRED'); } }

/**
 * Executes an agent's general program. Every effect is an engine action (POLICY → ACT → read-back CHECK) and every
 * step is journaled. In LLM mode the model reviews sanitized observations afterwards and may add follow-up steps.
 */
export class ProgramExecutor {
  private readonly results = new Map<string, StepResult>();
  private readonly pending: string[] = [];
  private summary = '';

  constructor(private readonly engine: InboxEngine, private readonly platform: PlatformService, private readonly agent: AgentRecord,
    private readonly context: MissionContext, private readonly ops: WorkspaceOps) {}

  private today() {
    return (this.context.mode === 'sandbox' ? sandboxClock : new Date().toISOString()).slice(0, 10);
  }

  private log(service: LogService, action: string, input: string, output: string, outcome?: MissionOutcome, ruleId = 'READ_ONLY_SCOPED') {
    const step = outcome ? undefined : this.context.record('CHECK', { action, outcome: 'VERIFIED', rule_id: ruleId });
    this.platform.log({ userId: this.agent.user_id, agentId: this.agent.id, runId: this.context.runId, service, action, input, output,
      verdict: outcome ? verdictLabel(outcome) : 'ALLOW_TIER_0', ruleId: outcome?.ruleId ?? ruleId,
      verified: outcome ? outcome.verified : true,
      traceStepHash: (outcome?.checkStep ?? outcome?.policyStep ?? step)?.step_hash });
  }

  private render(template: string, row?: Row, source?: StepResult) {
    return template.replace(/\{\{\s*([a-zA-Z_ ]{1,40})\s*\}\}/g, (_match, raw: string) => {
      const name = key(raw);
      if (name === 'count') return String(source?.rows.length ?? 0);
      if (name === 'date') return this.today();
      if (name === 'summary') return this.summary || '(no matching items)';
      if (name === 'rows') return (source?.rows ?? []).slice(0, 25).map((entry) => '• ' + [entry.fields.from, entry.fields.subject ?? entry.fields.merchant]
        .filter(Boolean).join(' · ')).join('\n');
      return row ? String(lookup(row, name) ?? '') : '';
    });
  }

  private hostile(message: ReaderMessage) {
    const content = [message.subject, message.text, message.html ?? ''].join('\n');
    return scanPromptInjection(content).detected || Boolean(message.threatSignals?.length) ||
      Boolean(message.replyTo && address(message.replyTo) !== address(message.from));
  }

  async run() {
    const program = this.agent.workflow_plan.params.program ?? [];
    if (program.some((step) => !this.hasStepScope(step))) throw new Error('MCP_SCOPE_REQUIRED');
    try {
      for (const step of program) await this.step(step);
      // Only model-authored programs are reviewed by the model; offline plans run exactly as compiled.
      if (this.engine.agent.mode === 'llm' && this.agent.workflow_plan.planner === 'llm-planner') await this.review(program);
    } catch (error) {
      if (error instanceof PickerRequired) return { pending: [], phase: 'awaiting_photo_selection', notes: [error.uri] };
      throw error;
    }
    return { pending: [...this.pending], phase: this.pending.length ? 'awaiting_review' : 'start', notes: [...this.ops.flags] };
  }

  private hasStepScope(step: GenericStep) {
    if (this.agent.source_cli === 'web') return true;
    const scopes = this.agent.workflow_plan.params.mcp_scopes ?? [];
    return genericStepScopes(step).every((scope) => scopes.includes(scope));
  }

  /** LLM "think" loop: up to two review rounds over sanitized observations; new steps run under the same gates. */
  private async review(program: GenericStep[]) {
    const executed = [...program];
    for (let round = 1; round <= 2; round++) {
      let decision;
      try {
        const kinds = Object.fromEntries(executed.map((entry) => [entry.id, entry.op === 'mail.search' ? 'mail' : entry.op === 'photos.extract' ? 'photo' : 'other'])) as
          Record<string, 'mail' | 'photo' | 'other'>;
        for (const entry of executed) if ('from' in entry && entry.from && kinds[entry.id] === 'other') kinds[entry.id] = kinds[entry.from] ?? 'other';
        decision = await llmReview(this.engine.agent, this.agent.goal_prompt, executed, this.observations(), undefined, kinds,
          (call) => this.context.recordModel({ event: 'AGENT_MODEL_CALL', phase: call.phase, status: call.status, round }, call.usage), this.context.signal);
      } catch (error) {
        this.context.checkout();
        this.log('system', 'llm_review', `round ${round}`, 'Review unavailable: ' + (error instanceof Error ? error.message : 'error'), undefined, 'REVIEW_SKIPPED');
        return;
      }
      if (decision.done) {
        this.logReview(round, decision.reasoning, [], decision.issues);
        return;
      }
      const typed = new Set(emailsIn(this.agent.goal_prompt));
      const ids = new Set(executed.map((entry) => entry.id));
      const added: GenericStep[] = [];
      for (const raw of decision.steps) {
        if (!this.hasStepScope(raw)) {
          const trace = this.context.record('POLICY', { action: raw.op, outcome: 'BLOCKED', rule_id: 'MCP_SCOPE_REQUIRED' });
          this.platform.log({ userId: this.agent.user_id, agentId: this.agent.id, runId: this.context.runId, service: 'policy',
            action: 'review_step_rejected', input: raw.op, output: 'The originating MCP token lacks the required scope.',
            verdict: 'BLOCKED', ruleId: 'MCP_SCOPE_REQUIRED', verified: false, traceStepHash: trace.step_hash });
          continue;
        }
        let entry: GenericStep = { ...raw, id: ids.has(raw.id) ? (raw.id + '_r' + round).slice(0, 24) : raw.id };
        if (entry.op === 'mail.send') {
          const to = entry.to.map((value) => value.toLowerCase()).filter((value) => typed.has(value));
          if (!to.length) continue;
          entry = { ...entry, to };
        }
        if ('from' in entry && entry.from && !ids.has(entry.from)) continue;
        const parsed = genericStepSchema.safeParse(entry);
        if (!parsed.success) continue;
        ids.add(parsed.data.id);
        added.push(parsed.data);
      }
      if (!added.length) {
        this.logReview(round, decision.reasoning, [], decision.issues);
        return;
      }
      this.context.checkout();
      if (!this.saveExtendedPlan(added)) {
        this.logReview(round, decision.reasoning, [], [...decision.issues, 'The combined plan failed validation or exceeded the step limit.']);
        return;
      }
      this.logReview(round, decision.reasoning, added, decision.issues);
      for (const entry of added) await this.step(entry);
      executed.push(...added);
    }
  }

  private logReview(round: number, reasoning: string, added: GenericStep[], issues: string[]) {
    const status = added.length ? ` → ${added.length} more step(s)` : issues.length ? ' → follow-up rejected' : ' → done';
    this.log('system', 'llm_review', `round ${round}`, reasoning + status +
      (issues.length ? ` (rejected: ${issues.join(' | ')})` : ''), undefined, 'LLM_REVIEW');
  }

  private saveExtendedPlan(added: GenericStep[]) {
    const current = this.platform.agent(this.agent.id)!;
    const usedServices = added.map((entry) => opService[entry.op]).filter((service) => service !== 'system');
    const plan = { ...current.workflow_plan, services: [...new Set([...current.workflow_plan.services, ...usedServices])],
      params: { ...current.workflow_plan.params, program: [...current.workflow_plan.params.program ?? [], ...added] },
      steps: [...current.workflow_plan.steps, ...added.map((entry) => ({ id: entry.id, service: opService[entry.op], action: entry.op.replace('.', '_'),
        label: describeStep(entry).slice(0, 160), depends_on: 'from' in entry && entry.from ? [entry.from] : [],
        tier_hint: (entry.op === 'mail.draft_replies' || entry.op === 'mail.send' ? 2 : 0) as 0 | 2 }))] };
    const valid = workflowPlanSchema.safeParse(plan);
    return valid.success && Boolean(this.platform.updatePlan(this.agent.id, valid.data, this.context.runId));
  }

  private observations() {
    return [...this.results.entries()].map(([id, result]) => ({
      step: id, count: result.rows.length, notes: result.notes.slice(0, 5),
      fields: [...new Set(result.rows.flatMap((row) => Object.keys(row.fields)))].slice(0, 15),
      sample: result.rows.slice(0, 3).map((row) => Object.fromEntries(Object.entries(row.fields).slice(0, 10)
        .map(([name, value]) => [name, typeof value === 'number' ? value : String(sanitizeCell(value).value).slice(0, 60)]))),
    }));
  }

  private rows(id: string) {
    const result = this.results.get(id);
    if (!result) throw new Error('PROGRAM_DEPENDENCY_INVALID');
    return result;
  }

  private async folderKey(folder?: string[]) {
    return folder ? (await this.ops.ensureFolderPath(folder)).key : null;
  }

  private async step(step: GenericStep) {
    this.context.checkout();
    const notes: string[] = [];
    let result: StepResult = { rows: [], notes };
    switch (step.op) {
      case 'mail.search': {
        const now = Date.parse(this.context.mode === 'sandbox' ? sandboxClock : new Date().toISOString());
        const messages = (await this.engine.readMessages(this.context.mode, step, this.context.signal)).filter((message) => !message.contextOnly && !message.sent);
        let quarantined = 0;
        const matched: Row[] = [];
        for (const message of messages.sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))) {
          const haystack = (message.from + '\n' + message.subject + '\n' + message.text).toLowerCase();
          if (this.context.mode === 'sandbox' && step.keywords.length && !step.keywords.some((word) => haystack.includes(word.toLowerCase()))) continue;
          if (step.from_contains && !message.from.toLowerCase().includes(step.from_contains.toLowerCase())) continue;
          if (step.subject_contains && !message.subject.toLowerCase().includes(step.subject_contains.toLowerCase())) continue;
          if (step.newer_than_days && Date.parse(message.receivedAt) < now - step.newer_than_days * 86_400_000) continue;
          if (this.hostile(message) || verificationNotice.test(message.subject + '\n' + message.text) ||
              scanOutboundSecrets(message.text)) { quarantined++; continue; }
          let text = stripHtml(message.text);
          if (step.include_attachments) {
            try {
              const parts = message.attachments ?? await message.loadAttachments?.() ?? [];
              const extracted = await readAttachments(parts.filter((part) => ['application/pdf', 'text/plain', 'text/csv'].includes(part.mime)));
              if (!scanPromptInjection(extracted).detected && !scanOutboundSecrets(extracted) && !verificationNotice.test(extracted)) text += '\n' + extracted;
            } catch {
              this.context.checkout();
              notes.push('attachment unreadable');
            }
          }
          const fields: Record<string, Value> = {};
          for (const match of text.matchAll(/^\s*([A-Za-z][A-Za-z #/-]{1,30}?)\s*:\s*(.{1,200})$/gm)) {
            const name = key(match[1]);
            if (name && fields[name] === undefined) fields[name] = match[2].trim();
          }
          for (const name of ['amount', 'total', 'price', 'unit_price']) {
            const amount = typeof fields[name] === 'string' ? money(String(fields[name])) : undefined;
            if (amount) fields[name] = Number(amount);
          }
          Object.assign(fields, { date: message.receivedAt.slice(0, 10), from: address(message.from), subject: this.engine.redact(this.context.mode, message.subject),
            message_id: message.id, thread_id: message.threadId, attachments: message.attachmentNames?.length ?? message.attachments?.length ?? 0 });
          matched.push({ fields, message });
          if (matched.length >= step.limit) break;
        }
        result = { rows: matched, notes };
        this.log('gmail', 'mail_search', describeStep(step), `${matched.length} matching messages${quarantined ? `, ${quarantined} quarantined` : ''}`);
        break;
      }
      case 'photos.extract': {
        const adapter = this.engine.workspace(this.context.mode);
        let items;
        try {
          items = await adapter.searchPhotos({ category: step.category, limit: step.limit });
        } catch (error) {
          if (!(error instanceof Error && error.message === 'PHOTOS_PICKER_SELECTION_REQUIRED' && adapter.startPhotoPicker)) throw error;
          const session = await adapter.startPhotoPicker();
          this.log('photos', 'request_photo_selection', 'Google Photos Picker', 'Open the picker link and choose the photos Siftvane may read: ' + session.picker_uri,
            undefined, 'PHOTOS_PICKER_SELECTION_REQUIRED');
          throw new PickerRequired(session.picker_uri);
        }
        for (const item of items) {
          const details = await extractPhotoDetails(adapter, item.id);
          if (details.quarantined) { notes.push('quarantined ' + item.filename); continue; }
          const fields: Record<string, Value> = { media_item_id: item.id, filename: item.filename, date: details.fields.date ?? '' };
          for (const [name, value] of Object.entries(details.fields)) if (value !== undefined) fields[name] = value;
          result.rows.push({ fields });
        }
        this.log('photos', 'photos_extract', describeStep(step), `${result.rows.length} photos extracted`);
        break;
      }
      case 'filter': {
        const source = this.rows(step.from);
        result = { rows: source.rows.filter((row) => {
          const value = String(lookup(row, step.field) ?? '');
          return step.contains ? value.toLowerCase().includes(step.contains.toLowerCase()) : step.exists === false ? !value : Boolean(value);
        }), notes };
        this.log('system', 'filter', describeStep(step), `${result.rows.length} of ${source.rows.length} rows kept`);
        break;
      }
      case 'summarize': {
        const source = this.rows(step.from);
        const detail = (row: Row) => ['amount', 'due', 'deadline', 'status', 'project', 'order']
          .map((name) => row.fields[name] !== undefined ? `${name.replace(/_/g, ' ')} ${row.fields[name]}` : '').filter(Boolean).join(', ');
        this.summary = [`${step.heading ?? 'Summary'}: ${source.rows.length} item(s) as of ${this.today()}.`,
          ...source.rows.slice(0, 40).map((row) => '• ' + [row.fields.date, row.fields.from ?? row.fields.merchant, row.fields.subject ?? row.fields.filename]
            .filter(Boolean).join(' · ') + (detail(row) ? ` (${detail(row)})` : ''))].join('\n');
        result = { rows: source.rows, text: this.summary, notes };
        this.log('system', 'summarize', describeStep(step), `${source.rows.length} items summarized`);
        break;
      }
      case 'drive.folder': {
        const made = await this.ops.ensureFolderPath(step.path);
        result = { rows: [], notes: [made.key] };
        break;
      }
      case 'drive.save_attachments': {
        const source = this.rows(step.from);
        await this.ops.ensureFolderPath(step.folder);
        let saved = 0;
        for (const row of source.rows) {
          const parts = row.message?.attachments ?? await row.message?.loadAttachments?.() ?? [];
          for (const part of parts.slice(0, 3)) {
            this.context.checkout();
            try {
              safeAttachmentBytes(part);
              const text = await readAttachments([part]).catch(() => '');
              if (scanPromptInjection(text).detected || scanOutboundSecrets(text)) { notes.push('quarantined ' + part.name); continue; }
              const staged = await stageWorkspaceAttachment(this.engine.stagingRoot(), row.message!.id, part, this.engine.guard);
              try {
                const outcome = await this.ops.saveFile(step.folder, part.name, part.mime, { staged_path: staged.path }, row.message!.id);
                const artifact = outcome.artifactId ? this.platform.registry.byId(outcome.artifactId) : undefined;
                if (outcome.verified) { saved++; row.fields.drive_link = artifact?.url ?? `sandbox://drive/${artifact?.external_id ?? ''}`; }
              } finally {
                await rm(path.dirname(staged.path), { recursive: true, force: true });
              }
            } catch (error) {
              notes.push(part.name + ': ' + (error instanceof Error ? error.message : 'blocked'));
            }
          }
        }
        result = { rows: source.rows, notes };
        if (!saved) this.log('drive', 'save_attachments', describeStep(step), 'No eligible attachments' + (notes.length ? ': ' + notes.join('; ') : ''));
        break;
      }
      case 'drive.save_text': {
        await this.ops.ensureFolderPath(step.folder);
        const source = step.from ? this.rows(step.from) : undefined;
        const content = sanitizeText(this.render(step.content, undefined, source), 100_000).value;
        const mime = step.name.endsWith('.csv') ? 'text/csv' : step.name.endsWith('.md') ? 'text/markdown' : 'text/plain';
        await this.ops.saveFile(step.folder, step.name, mime, { inline_text: content + '\n' });
        break;
      }
      case 'sheets.append': {
        const source = this.rows(step.from);
        const folder = await this.folderKey(step.folder);
        const hasSource = source.rows.some((row) => row.fields.message_id ?? row.fields.media_item_id);
        const sourceColumn = step.columns.find((column) => ['source_id', 'message_id', 'media_item_id'].includes(key(column)));
        const columns = hasSource && !sourceColumn ? [...step.columns, 'Source ID'] : step.columns;
        const sheet = await this.ops.ensureSpreadsheet(step.title, folder, [{ name: step.tab, headers: columns }]);
        if (!sheet.verified) break;
        const outcome = await this.ops.appendRows(step.title, step.tab, source.rows.map((row) => columns.map((column) => lookup(row, column))),
          hasSource ? sourceColumn ?? 'Source ID' : undefined);
        result = { rows: source.rows, notes: [`appended ${outcome.appended}`] };
        break;
      }
      case 'docs.write': {
        const source = step.from ? this.rows(step.from) : undefined;
        const folder = await this.folderKey(step.folder);
        const content = step.content ? this.render(step.content, undefined, source) : this.summary || this.render('{{rows}}', undefined, source);
        await this.ops.upsertDoc(step.title, folder, this.render(step.heading, undefined, source), content || '(no matching items)', step.mode);
        break;
      }
      case 'calendar.reminders': {
        const source = this.rows(step.from);
        let added = 0;
        for (const row of source.rows.slice(0, 10)) {
          const raw = String(lookup(row, step.date_field) ?? '');
          const date = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
          if (!date) continue;
          const title = String(sanitizeCell(this.render(step.title, row) || 'Reminder').value).slice(0, 140);
          const suffix = sha256(this.agent.id + ':' + (row.fields.message_id ?? row.fields.media_item_id ?? title) + ':' + date).slice(0, 16);
          const id = 'siftvane-reminder-' + suffix;
          if (await this.context.read('calendar', id) || await this.context.read('calendar', 'clam-reminder-' + suffix)) {
            this.log('calendar', 'add_reminder', `${title} on ${date}`, 'Reminder already scheduled', undefined, 'ALREADY_CURRENT');
            added++;
            continue;
          }
          const start = new Date(`${date}T${step.time_utc}:00.000Z`);
          const event: InboxCalendarEvent = { id, title, start: start.toISOString(), end: new Date(start.getTime() + 15 * 60_000).toISOString(),
            kind: 'reminder', guests: [], flexible: false };
          const outcome = await this.context.execute({ kind: 'calendar', playbook: 'agent_reminder', target: id, sourceId: String(row.fields.message_id ?? id),
            version: sha256(canonicalJson(event)), after: event as unknown as Record<string, unknown>, expectedBefore: null, requestedTier: 0, confidence: 1 });
          if (outcome.verified) added++;
          this.log('calendar', 'add_reminder', `${title} on ${date}`, outcome.verified ? 'Reminder verified' : outcome.outcome || outcome.decision, outcome);
        }
        if (!added && !source.rows.some((row) => /^\d{4}-\d{2}-\d{2}/.test(String(lookup(row, step.date_field))))) {
          this.log('calendar', 'add_reminders', describeStep(step), `No rows had a ${step.date_field} date`);
        }
        break;
      }
      case 'mail.label': {
        const source = this.rows(step.from);
        for (const row of source.rows.filter((entry) => entry.message).slice(0, 25)) {
          const id = row.message!.id;
          const before = await this.context.read('mail', id) as { labels?: string[] } | null;
          const current = before?.labels ?? row.message!.labels;
          if (current.includes(step.label)) continue;
          const after = { labels: [...current, step.label].sort() };
          const outcome = await this.context.execute({ kind: 'mail', playbook: 'agent_label', target: id, sourceId: id, threadId: row.message!.threadId,
            version: sha256(canonicalJson(after)), after, requestedTier: 0, confidence: 1 });
          this.log('gmail', 'label_message', `${step.label} → ${row.fields.subject}`, outcome.verified ? 'Label verified' : outcome.outcome || outcome.decision, outcome);
        }
        break;
      }
      case 'mail.draft_replies': {
        const source = this.rows(step.from);
        for (const row of source.rows.filter((entry) => entry.message).slice(0, 10)) {
          const to = address(row.message!.from);
          const subject = sanitizeText(this.render(step.subject, row), 150).value.replace(/[\r\n]+/g, ' ').replace(/^(?:re:\s*)+/i, 'Re: ').slice(0, 150) || 'Re:';
          const body = sanitizeText(this.render(step.body, row, source), 1800).value;
          const target = 'draft-' + sha256(this.agent.id + ':' + row.message!.id).slice(0, 24);
          if (this.engine.store.sqlite.prepare("SELECT 1 FROM inbox_approvals WHERE json_extract(body,'$.proposed_action.target')=?").get(target)) continue;
          const action: SafeAction = { kind: 'draft', playbook: 'agent_reply', target, sourceId: row.message!.id, threadId: row.message!.threadId,
            effectiveContact: to, version: sha256(canonicalJson({ subject, body, to })), after: { subject, text: body }, requestedTier: 2,
            reason: 'AGENT_REPLY_APPROVAL', confidence: 1 };
          const outcome = await this.context.execute(action);
          if (outcome.approvalId) this.pending.push(outcome.approvalId);
          this.log('gmail', 'draft_reply', `${to} · ${subject}`, outcome.approvalId ? 'Waiting in Approval Inbox' : `Blocked by ${outcome.ruleId}`, outcome);
        }
        break;
      }
      case 'mail.send': {
        const source = step.from ? this.rows(step.from) : undefined;
        const reports = /\{\{\s*(?:summary|count|rows)\s*\}\}/i.test(step.body);
        if (reports && ((source && !source.rows.length) || (!source && !this.summary) || /: 0 item\(s\)/.test(this.summary))) {
          this.log('gmail', 'send_email', `${step.to.join(', ')} · ${step.subject}`, 'Skipped: nothing to report yet', undefined, 'NOTHING_TO_REPORT');
          break;
        }
        const subject = sanitizeText(this.render(step.subject, undefined, source), 150).value.replace(/[\r\n]+/g, ' ').slice(0, 150);
        const body = sanitizeText(this.render(step.body, undefined, source), 1800).value;
        for (const to of step.to) {
          const run = this.agent.schedule_mode === 'one_shot' ? this.agent.id : this.context.runId;
          const version = sha256(canonicalJson({ subject, body, to, run }));
          const outcome = await this.context.execute({ kind: 'send', playbook: 'agent_send', target: 'send-' + version.slice(0, 24),
            sourceId: 'agent:' + this.agent.id, effectiveContact: to, version, after: { subject, text: body }, requestedTier: 1, confidence: 1 });
          if (outcome.approvalId) this.pending.push(outcome.approvalId);
          this.log('gmail', 'send_email', `${to} · ${subject}`, outcome.approvalId ? 'Waiting in Approval Inbox' : outcome.verified ? 'Sent and verified' :
            `Blocked by ${outcome.ruleId}`, outcome);
        }
        break;
      }
    }
    this.results.set(step.id, result);
  }
}
