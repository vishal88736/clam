'use client';

import {
  Activity, ArrowDownToLine, ArrowRight, Bot, CalendarDays, CircleHelp, Clock3,
  FileCheck2, GitCompareArrows, Inbox, ListChecks, Play, Power, ReceiptText,
  Repeat, RotateCcw, ShieldCheck, Sun, Moon, TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxPolicy, InboxSchedule } from '@siftvane/shared';
import { SiftvaneMark } from './SiftvaneMark';
import { useTheme } from './ThemeContext';
import { GoogleAccountBar, useGoogleSession } from './GoogleSession';
import { ThreadExecutionStack } from './ThreadExecutionStack';
import { AgentSwitcherBar, AgentsView, usePlatformData } from './AgentConsole';
import { RecipesView } from './RecipeConsole';
import { PolicyEditor, policyChanges } from './PolicyEditor';

const views = [
  { id: 'briefing', label: 'Inbox Briefing', icon: Inbox },
  { id: 'agents', label: 'Agents & Activity', icon: Bot },
  { id: 'recipes', label: 'Recipes', icon: Repeat },
  { id: 'approvals', label: 'Approval Inbox', icon: ListChecks },
  { id: 'calendar', label: 'Calendar Sync', icon: CalendarDays },
  { id: 'policy', label: 'Policy Change Preview', icon: GitCompareArrows },
  { id: 'monitor', label: 'Runs & Live Monitor', icon: Activity },
  { id: 'bills', label: 'Bills & Receipts', icon: ReceiptText },
] as const;
type View = typeof views[number]['id'];
type Snapshot = Record<string, unknown>;
type Run = {
  id: string; trigger: string; startedAt: string; completedAt: string | null; status: string;
  emails: number; conflicts: number; outbound: number; calendar: number; steps: number;
  tokens: number; usd: number; error: string | null; changesCount?: number;
  mcp_caller?: { tool: string; client: string; token_id: string; inbox_id: string };
};
type Approval = {
  approval_id: string; priority: string; expires_at: string; status: string; triggered_rule_id: string; reason: string;
  proposed_action: { kind: string; playbook: string; target: string; effectiveContact?: string; after: Snapshot | null };
  editable_payload: Snapshot | null;
  batch_actions?: Array<{ effectiveContact?: string; after: Snapshot | null }>;
};
type Change = {
  type: string; entity: string; diff: Record<string, { before: unknown; after: unknown }>;
  source_msg_ids: string[]; conflict_flag: boolean; next_action: string | null;
};
type Step = {
  id: string; run_id: string; stage: string; timestamp: string;
  step_hash: string; detail: Snapshot;
  mode?: 'llm' | 'offline-smoke';
  model_usage?: { provider: string; model: string; prompt_tokens: number | null; completion_tokens: number | null; latency_ms: number; estimated_usd: number | null };
  budgets: { outbound: number; calendar: number; steps: number; tokens: number | null; usd: number | null };
};
type Briefing = {
  mode: 'sandbox' | 'live'; agent_mode: 'llm' | 'offline-smoke'; agent_model: string; halted: boolean; last_success: Run | null;
  schedule: InboxSchedule; run_meta: (Run & { rollback_available: boolean }) | null;
  autonomy: { autonomous_verified: number; gated_for_approval: number; blocked_quarantined: number };
  changed: Change[]; needs_attention: Approval[];
  handled_autonomously: Array<{ trace_step_id: string; playbook_id: string; action: string; entity: string; policy_rule_id: string; tier: number }>;
  blocked_and_quarantined: Array<{ msg_id: string; threat_type: string; policy_rule_id: string }>;
  digest: {
    upcoming_bills_summary: Snapshot[]; active_deliveries: Snapshot[];
    waiting_on_commitments: Snapshot[]; newsletter_rollup: Snapshot[]; bill_flags: Approval[];
  };
};

type RequestFn = <T,>(endpoint: string, method?: string, body?: unknown) => Promise<T>;

const api: RequestFn = async <T,>(endpoint: string, method = 'GET', body?: unknown) => {
  const response = await fetch('/api/inbox/' + endpoint, {
    method, cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
};
const label = (value: string) => value.replace(/_/g, ' ').toLowerCase().replace(/^./, (char) => char.toUpperCase());
const when = (value: unknown): string => typeof value === 'string' && !Number.isNaN(Date.parse(value))
  ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value))
  : '—';
const raw = (value: unknown) => value === null || value === undefined ? '—'
  : Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const display = (field: string, value: unknown) => (field === 'start' || field === 'end') && value ? when(value) : raw(value);
const playbookName = (id: string) => label(id);
const showError = (error: unknown) => error instanceof Error ? label(error.message) : 'Request failed';

function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'red' | 'amber' }) {
  return <span className="inbox-tag" data-tone={tone}>{children}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="inbox-empty">{children}</div>;
}

function Panel({ title, icon, children, action }: { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <section className="inbox-panel">
    <div className="inbox-panel-head"><h2>{icon}{title}</h2>{action}</div>
    {children}
  </section>;
}

function ChangeList({ changes }: { changes: Change[] }) {
  if (!changes.length) return <Empty>No verified changes recorded for this run.</Empty>;
  return <div className="inbox-stack">
    {changes.map((change, index) => {
      const names = Object.keys(change.diff).sort((left, right) => {
        const priorities = ['start', 'end', 'deadline', 'amount', 'status', 'labels'];
        return (priorities.includes(left) ? priorities.indexOf(left) : 99) - (priorities.includes(right) ? priorities.indexOf(right) : 99);
      });
      return <details className="inbox-change" key={change.entity + index} open={index < 4 || change.conflict_flag}>
        <summary>
          <div><strong>{change.diff.title?.after ? raw(change.diff.title.after) : label(change.entity.replace(/-/g, ' '))}</strong>
            <span>{label(change.type)}</span></div>
          {change.conflict_flag && <Tag tone="amber">Conflict</Tag>}
        </summary>
        <dl>
          {names.map((name) => <div key={name}>
            <dt>{label(name)}</dt>
            <dd><span>{display(name, change.diff[name].before)}</span><ArrowRight size={14} aria-hidden="true" /><span>{display(name, change.diff[name].after)}</span></dd>
          </div>)}
        </dl>
        <div className="inbox-source">Sources {change.source_msg_ids.join(' · ')}{change.next_action && <> · {change.next_action}</>}</div>
      </details>;
    })}
  </div>;
}

function ApprovalEditor({ item, busy, onResolve }: {
  item: Approval; busy: boolean; onResolve: (id: string, approve: boolean, edit?: Snapshot, calendarEdit?: Snapshot,
    batchEdits?: Array<{ subject: string; text: string }>) => void;
}) {
  const [subject, setSubject] = useState(raw(item.editable_payload?.subject));
  const [text, setText] = useState(raw(item.editable_payload?.text));
  const [start, setStart] = useState(raw(item.editable_payload?.start).slice(0, 16));
  const [end, setEnd] = useState(raw(item.editable_payload?.end).slice(0, 16));
  const [batchEdits, setBatchEdits] = useState(() => item.batch_actions?.map((message) => ({
    subject: raw(message.after?.subject), text: raw(message.after?.text),
  })));
  const canEditReply = item.proposed_action.kind === 'send' || item.proposed_action.kind === 'draft';
  const canEditCalendar = item.proposed_action.kind === 'calendar' && Boolean(item.editable_payload);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.parse(item.expires_at) - clock) / 1000));
  const expired = clock > 0 && seconds === 0;
  return <article className="inbox-item">
    <div className="inbox-row"><strong>{playbookName(item.proposed_action.playbook)}</strong>
      <Tag tone={item.priority === 'high' ? 'red' : 'amber'}>{label(item.priority)} priority</Tag></div>
    <p>{item.reason}</p><div className="inbox-source">{item.triggered_rule_id} · {clock ? expired ? 'Expired' :
      `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s left` : 'Loading expiry'}</div>
    {canEditCalendar && <div className="inbox-two">
      <label>Start (UTC)<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>End (UTC)<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
    </div>}
    {batchEdits?.length ? <ol className="inbox-stack">
      {batchEdits.map((message, index) => <li key={index}>
        <strong>{item.batch_actions?.[index].effectiveContact}</strong>
        <label>Subject {index + 1}<input value={message.subject} maxLength={180} onChange={(event) =>
          setBatchEdits(batchEdits.map((entry, row) => row === index ? { ...entry, subject: event.target.value } : entry))} /></label>
        <label>Reply {index + 1}<textarea value={message.text} maxLength={2000} rows={3} onChange={(event) =>
          setBatchEdits(batchEdits.map((entry, row) => row === index ? { ...entry, text: event.target.value } : entry))} /></label>
      </li>)}
    </ol> : canEditReply ? <div className="inbox-stack">
      <p>To {item.proposed_action.effectiveContact}</p>
      <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Reply<textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} /></label>
    </div> : item.proposed_action.after && <dl className="inbox-fields">
      {Object.entries(item.proposed_action.after).filter(([field]) => !['id', 'etag'].includes(field)).map(([field, value]) =>
        <div key={field}><dt>{label(field)}</dt><dd>{display(field, value)}</dd></div>)}
    </dl>}
    <div className="inbox-actions">
      <button className="inbox-button" type="button" disabled={busy || expired} onClick={() => onResolve(item.approval_id, false)}>Reject</button>
      <button className="inbox-button" data-tone="primary" type="button" disabled={busy || expired || Boolean(canEditReply && (!subject.trim() || !text.trim())) ||
        (canEditCalendar && (!start || !end || start >= end)) || batchEdits?.some((message) => !message.subject.trim() || !message.text.trim())}
        onClick={() => onResolve(item.approval_id, true, canEditReply ? { subject, text } : undefined,
          canEditCalendar ? { start: start + ':00Z', end: end + ':00Z' } : undefined, batchEdits)}>
        {item.batch_actions?.length ? 'Approve batch' : item.triggered_rule_id === 'AGENT_LOOP_PREVENTED' ? 'Reset thread budget' :
          item.proposed_action.kind === 'review' ? 'Acknowledge' : 'Approve'}
      </button>
    </div>
  </article>;
}

function ApprovalsView({ pending, busy, onResolve }: {
  pending: Approval[];
  busy: boolean;
  onResolve: Parameters<typeof ApprovalEditor>[0]['onResolve'];
}) {
  const [priority, setPriority] = useState('');
  const [filtered, setFiltered] = useState<Approval[] | null>(null);
  const [error, setError] = useState('');
  const ids = pending.map((item) => item.approval_id).join(',');
  useEffect(() => {
    if (!priority) return;
    let active = true;
    setFiltered(null);
    setError('');
    api<{ approvals: Approval[] }>('approvals?priority=' + encodeURIComponent(priority))
      .then(({ approvals }) => { if (active) setFiltered(approvals.filter((item) => item.status === 'PENDING')); })
      .catch((failure) => { if (active) setError(showError(failure)); });
    return () => { active = false; };
  }, [priority, ids]);
  const items = priority ? filtered : pending;
  return <Panel title="Pending approvals" icon={<ListChecks size={18} />} action={
    <label>Priority <select value={priority} onChange={(event) => {
      setFiltered(null);
      setError('');
      setPriority(event.target.value);
    }}>
      <option value="">All priorities</option><option value="high">High</option>
      <option value="medium">Medium</option><option value="low">Low</option>
    </select></label>}>
    {error ? <p role="alert" className="inbox-error">{error}</p> : !items
      ? <Empty>Loading approvals.</Empty>
      : !items.length ? <Empty>No items waiting for approval.</Empty>
      : <div className="inbox-two">{items.map((item) =>
        <ApprovalEditor key={item.approval_id} item={item} busy={busy} onResolve={onResolve} />)}</div>}
  </Panel>;
}

function PolicyView({ reload }: { reload: () => Promise<void> }) {
  const [policy, setPolicy] = useState<{ version: number; policy: InboxPolicy; mode: string } | null>(null);
  const [draft, setDraft] = useState<InboxPolicy | null>(null);
  const [compared, setCompared] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ messages_scanned: number; rows: Array<{
    id: string; before: { decision: string; ruleId: string } | null; after: { decision: string; ruleId: string } | null; changed: boolean;
  }> } | null>(null);
  useEffect(() => {
    api<{ version: number; policy: InboxPolicy; mode: string }>('policy')
      .then((value) => { setPolicy(value); setDraft(value.policy); })
      .catch((err) => setError(showError(err)));
  }, []);
  const execute = async (save: boolean) => {
    setError('');
    setBusy(true);
    try {
      const value = draft;
      if (!value) return;
      if (save && policy) {
        const installed = await api<{ version: number; policy: InboxPolicy }>('policy', 'PUT', { version: policy.version, policy: value });
        setPolicy({ ...installed, mode: policy.mode });
        setDraft(installed.policy);
        setReport(null);
        setCompared('');
        await reload();
      } else {
        setReport(await api('policy/preview', 'POST', value));
        setCompared(JSON.stringify(value));
      }
    } catch (err) { setError(showError(err)); }
    finally { setBusy(false); }
  };
  return <div className="inbox-stack">
    <Panel title="Policy versions" icon={<GitCompareArrows size={18} />}>
      {policy && draft ? <>
        <p>You are on <strong>version {policy.version}</strong>. Edit a copy below, preview how it would treat the sandbox mail, then save it as version {policy.version + 1}. Nothing changes until you save.</p>
        <PolicyEditor current={policy.policy} draft={draft} onChange={(next) => { setDraft(next); setError(''); }} />
        <div className="inbox-actions">
          <button className="inbox-button" disabled={busy || draft.workStart >= draft.workEnd} onClick={() => void execute(false)}>Preview sandbox decisions</button>
          <button className="inbox-button" data-tone="primary" disabled={busy || compared !== JSON.stringify(draft) || !report || policyChanges(policy.policy, draft).length === 0}
            onClick={() => void execute(true)}>Save as version {policy.version + 1}</button>
          {report && compared !== JSON.stringify(draft) && <small>You changed something since the preview. Preview again to save.</small>}
        </div></> : <Empty>Loading the active policy.</Empty>}
      {error && <p role="alert" className="inbox-error">{error}</p>}
    </Panel>
    {report && <Panel title={`Decisions across ${report.messages_scanned} sandbox messages`} icon={<FileCheck2 size={18} />}>
      <div className="inbox-table-wrap"><table><thead><tr><th>Source and action</th><th>Current</th><th>Draft</th></tr></thead><tbody>
        {report.rows.map((row) => <tr key={row.id} data-changed={row.changed}>
          <td>{row.id}</td><td>{label(row.before?.decision ?? 'No action')}<small>{row.before?.ruleId}</small></td>
          <td>{label(row.after?.decision ?? 'No action')}<small>{row.after?.ruleId}</small></td>
        </tr>)}
      </tbody></table></div>
    </Panel>}
  </div>;
}

function Monitor({ runs, steps, schedule, loadTrace, saveSchedule, connected, busy, traceRun, selectedStep }: {
  runs: Run[]; steps: Step[]; schedule: InboxSchedule; loadTrace: (id: string) => void;
  saveSchedule: (value: InboxSchedule) => void; connected: boolean; busy: boolean; traceRun: string | null; selectedStep: string | null;
}) {
  const [frequency, setFrequency] = useState(schedule.frequency);
  const [interval, setIntervalValue] = useState(schedule.intervalMinutes);
  const [enabled, setEnabled] = useState(schedule.enabled);
  useEffect(() => {
    setFrequency(schedule.frequency);
    setIntervalValue(schedule.intervalMinutes);
    setEnabled(schedule.enabled);
  }, [schedule.frequency, schedule.intervalMinutes, schedule.enabled]);
  useEffect(() => {
    if (selectedStep) document.getElementById('trace-' + selectedStep)?.scrollIntoView({ block: 'nearest' });
  }, [selectedStep, steps]);
  const latest = steps[steps.length - 1];
  return <div className="inbox-stack">
    <Panel title="Schedule" icon={<Clock3 size={18} />}>
      <form className="inbox-form-row" onSubmit={(event) => {
        event.preventDefault();
        saveSchedule({ enabled, frequency, intervalMinutes: interval });
      }}>
        <label><input type="checkbox" disabled={busy} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable runs</label>
        <label>Frequency<select disabled={busy} value={frequency} onChange={(event) => setFrequency(event.target.value as InboxSchedule['frequency'])}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="interval">Custom interval</option>
        </select></label>
        {frequency === 'interval' && <label>Minutes<input type="number" min="1" max="10080" disabled={busy} value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} /></label>}
        <button className="inbox-button" type="submit" disabled={busy}>Save schedule</button>
      </form>
      {schedule.nextAt && <p>Next run {when(schedule.nextAt)}</p>}
    </Panel>
    <Panel title="Run history" icon={<ListChecks size={18} />}>
      {!runs.length ? <Empty>Run the inbox agent to populate history.</Empty> : <div className="inbox-table-wrap"><table>
        <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Messages</th><th>Changes</th><th>Conflicts</th><th>Writes</th><th /></tr></thead>
        <tbody>{runs.map((run) => <tr key={run.id}>
          <td>{when(run.startedAt)}</td><td>{run.mcp_caller ? <>
            <strong>{run.mcp_caller.tool}</strong><small>{run.mcp_caller.client} · Token {run.mcp_caller.token_id}</small>
          </> : raw(run.trigger.split(':')[0])}</td>
          <td><Tag tone={run.status === 'COMPLETED' ? 'green' : run.status === 'RUNNING' ? 'amber' : 'red'}>{label(run.status)}</Tag>{run.error && <small>{run.error}</small>}</td>
          <td>{run.emails}</td><td>{run.changesCount ?? 0}</td><td>{run.conflicts}</td>
          <td>{run.calendar} calendar · {run.outbound} {run.trigger === 'handoff' ? 'handoff' : 'email'}</td>
          <td><button className="inbox-button" onClick={() => loadTrace(run.id)}>Inspect trace</button></td>
        </tr>)}</tbody>
      </table></div>}
    </Panel>
    <Panel title="Trace monitor" icon={<Activity size={18} />} action={<Tag tone={connected ? 'green' : 'amber'}>{connected ? 'Live' : 'Reconnecting'}</Tag>}>
      {latest && <div className="inbox-actions">
        <Tag>{latest.budgets.steps} tool operations</Tag><Tag>{latest.budgets.calendar} calendar</Tag>
        <Tag>{latest.budgets.outbound} outbound</Tag>
        <Tag>{latest.budgets.tokens === null ? 'Model token count unavailable' : latest.budgets.tokens + ' model tokens'}</Tag>
        <Tag>{latest.budgets.usd === null ? 'Cost unavailable' : '$' + latest.budgets.usd.toFixed(5)}</Tag>
      </div>}
      {traceRun && <a href={`/api/inbox/runs/${traceRun}/trace`} download className="inbox-text-link">Download trace <ArrowDownToLine size={15} /></a>}
      {!steps.length ? <Empty>Pipeline events appear here during a run.</Empty> : <div className="inbox-trace">
        {steps.map((step) => <details key={step.id} id={'trace-' + step.id} className="inbox-item" open={selectedStep === step.id ? true : undefined}>
          <summary><Tag>{step.stage}</Tag> <strong>{raw(step.detail.outcome ?? step.detail.decision ?? step.detail.status ?? step.detail.action ?? step.detail.trigger ?? 'Pipeline event')}</strong>
            {typeof step.detail.rule_id === 'string' && <code> {step.detail.rule_id}</code>}</summary>
          <div className="inbox-source">SHA-256 {step.step_hash}</div>
          {step.model_usage && <div className="inbox-source">
            {step.mode} · {step.model_usage.provider}/{step.model_usage.model} · {raw(step.model_usage.prompt_tokens)} prompt tokens
            · {raw(step.model_usage.completion_tokens)} completion tokens · {step.model_usage.latency_ms} ms
            · {step.model_usage.estimated_usd === null ? 'cost unavailable' : '$' + step.model_usage.estimated_usd.toFixed(6)}
          </div>}
          <pre>{JSON.stringify(step.detail, null, 2)}</pre>
        </details>)}
      </div>}
    </Panel>
  </div>;
}

type CalendarDiff = {
  id: string; run_id: string; before: Snapshot | null; after: Snapshot | null; status: string; tier: number;
};

function CalendarView({ revision, blocked, rollback }: {
  revision: number; blocked: boolean; rollback: (id: string, actionIds?: string[]) => void;
}) {
  const [data, setData] = useState<{ events: Snapshot[]; changes: CalendarDiff[]; pending: Approval[] } | null>(null);
  const [selection, setSelection] = useState<CalendarDiff[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<typeof data>('calendar').then(setData).catch((err) => setError(showError(err)));
  }, [revision]);
  const group = (kind: 'add' | 'change' | 'cancel') => data?.changes.filter((entry) => {
    const before = Boolean(entry.before);
    const after = Boolean(entry.after);
    return kind === 'add' ? !before && after : kind === 'cancel' ? before && !after : before && after;
  }) ?? [];
  return <div className="inbox-stack">
    <Panel title="Calendar changes" icon={<CalendarDays size={18} />} action={
      <a className="inbox-button" href="/api/inbox/calendar.ics"><ArrowDownToLine size={16} /> Export .ics</a>}>
      {error && <p role="alert" className="inbox-error">{error}</p>}
      <div className="inbox-three">
        {([['add', 'Additions'], ['change', 'Changes'], ['cancel', 'Cancellations']] as const).map(([kind, title]) =>
          <section key={kind} className="inbox-item">
            <h3>{title}</h3>
            {!group(kind).length && <Empty>Nothing recorded.</Empty>}
            {group(kind).slice(0, 30).map((entry) => <div className="inbox-event" key={entry.id}>
              <strong>{raw(entry.after?.title ?? entry.before?.title)}</strong>
              <p>{when(entry.before?.start)} → {when(entry.after?.start)}</p>
              <Tag tone={entry.status === 'VERIFIED' ? 'green' : 'neutral'}>{label(entry.status)}</Tag>
              {entry.status === 'VERIFIED' && <label className="inbox-check">
                <input type="checkbox" checked={selection.some((item) => item.id === entry.id)}
                  onChange={(event) => setSelection(event.target.checked
                    ? [...selection.filter((item) => item.run_id === entry.run_id), entry]
                    : selection.filter((item) => item.id !== entry.id))} />
                Select to roll back
              </label>}
            </div>)}
          </section>)}
      </div>
      {!!selection.length && <button className="inbox-button" disabled={blocked} onClick={() => {
        rollback(selection[0].run_id, selection.map(({ id }) => id));
        setSelection([]);
      }}><RotateCcw size={16} /> Roll back selected changes</button>}
    </Panel>
    <Panel title="Pending calendar approvals" icon={<ListChecks size={18} />} action={<a href="#approvals" className="inbox-text-link">Review approvals <ArrowRight size={15} /></a>}>
      {data?.pending.length ? data.pending.map((item) => <div className="inbox-item" key={item.approval_id}>
        <strong>{raw(item.proposed_action.after?.title ?? item.proposed_action.target)}</strong>
        <p>{item.triggered_rule_id} · {when(item.proposed_action.after?.start)}</p>
      </div>) : <Empty>No calendar changes waiting for approval.</Empty>}
    </Panel>
    <Panel title="Current calendar" icon={<CalendarDays size={18} />}>
      <div className="inbox-table-wrap"><table><thead><tr><th>Event</th><th>Starts</th><th>Ends</th><th>Context</th></tr></thead><tbody>
        {data?.events.map((event) => <tr key={raw(event.id)}><td>{raw(event.title)}</td><td>{when(event.start)}</td><td>{when(event.end)}</td><td>{raw(event.dossier)}</td></tr>)}
      </tbody></table></div>
    </Panel>
  </div>;
}

function BillsView({ records, approvals }: { records: Snapshot[]; approvals: Approval[] }) {
  const warnings = approvals;
  return <div className="inbox-stack">
    <Panel title="Bills and subscriptions" icon={<ReceiptText size={18} />} action={
      <a className="inbox-button" href="/api/inbox/bills.csv"><ArrowDownToLine size={16} /> Export CSV</a>}>
      {records.length ? <div className="inbox-table-wrap">
        <table><thead><tr><th>Vendor</th><th>Reference</th><th>Amount</th><th>Due</th><th>Flags</th></tr></thead><tbody>
          {records.map((bill) => <tr key={raw(bill.invoice)}><td>{raw(bill.vendor)}</td><td>{raw(bill.invoice)}</td>
            <td>{raw(bill.amount)} {raw(bill.currency)}</td><td>{raw(bill.due)}</td>
            <td>{Boolean(bill.duplicateOrSpoofed) && <Tag tone="red">Duplicate flagged</Tag>}{Boolean(bill.priceHike) && <Tag tone="amber">Price increase · {raw(bill.previousAmount)} → {raw(bill.amount)}</Tag>}</td></tr>)}
        </tbody></table>
      </div> : <Empty>No bills extracted yet. Run the inbox agent to build the ledger.</Empty>}
    </Panel>
    <Panel title="Invoice and renewal flags" icon={<TriangleAlert size={18} />} action={<a href="#approvals" className="inbox-text-link">Open approval inbox <ArrowRight size={15} /></a>}>
      {warnings.length ? warnings.map((item) => <div className="inbox-item" key={item.approval_id}>
        <strong>{label(item.triggered_rule_id)}</strong><p>{raw(item.proposed_action.after?.vendor)} · {raw(item.proposed_action.after?.invoice)}</p>
      </div>) : <Empty>No billing flags awaiting review.</Empty>}
    </Panel>
  </div>;
}

function BriefingView({ data, onTrace }: { data: Briefing; onTrace: (id: string) => void }) {
  const firstBill = [...data.digest.upcoming_bills_summary].sort((left, right) => raw(left.due).localeCompare(raw(right.due)))[0];
  const groups = new Map<string, Briefing['handled_autonomously']>();
  for (const item of data.handled_autonomously) groups.set(item.playbook_id, [...groups.get(item.playbook_id) ?? [], item]);
  return <>
    <div className="inbox-digest inbox-autonomy" aria-label="Autonomy breakdown">
      <div><ShieldCheck size={19} /><span>Autonomous &amp; Verified (Tier 0/1)</span><strong>{data.autonomy.autonomous_verified}</strong></div>
      <div><ListChecks size={19} /><span>Gated for Approval (Tier 2)</span><strong>{data.autonomy.gated_for_approval}</strong></div>
      <div><TriangleAlert size={19} /><span>Blocked / Quarantined</span><strong>{data.autonomy.blocked_quarantined}</strong></div>
    </div>
    <div className="inbox-digest">
      {[
        [ReceiptText, 'Next bill due', firstBill ? `${raw(firstBill.vendor)} · ${raw(firstBill.due)}` : 'No bills tracked'],
        [Inbox, 'Tracked deliveries', data.digest.active_deliveries.length],
        [Clock3, 'Waiting on', data.digest.waiting_on_commitments.length],
        [FileCheck2, 'Newsletter rollup', data.digest.newsletter_rollup.length],
      ].map(([Icon, title, value]) => {
        const DigestIcon = Icon as typeof Inbox;
        return <div key={String(title)}><DigestIcon size={19} aria-hidden="true" /><span>{String(title)}</span><strong>{String(value)}</strong></div>;
      })}
    </div>
    <div className="inbox-brief-grid">
      <Panel title="What changed" icon={<GitCompareArrows size={19} />} action={<Tag>{data.changed.length} changes</Tag>}>
        <ChangeList changes={data.changed} />
      </Panel>
      <div className="inbox-stack">
        <Panel title="Needs attention" icon={<TriangleAlert size={19} />} action={<Tag tone={data.needs_attention.length ? 'amber' : 'neutral'}>{data.needs_attention.length} pending</Tag>}>
          {!data.needs_attention.length ? <Empty>Nothing waiting for approval.</Empty> : data.needs_attention.slice(0, 5).map((item) =>
            <article className="inbox-item" key={item.approval_id}><strong>{label(item.triggered_rule_id)}</strong><p>{item.reason}</p></article>)}
          <a href="#approvals" className="inbox-text-link">Open approval inbox <ArrowRight size={15} /></a>
        </Panel>
        <Panel title="Already handled" icon={<ShieldCheck size={19} />}>
          {!groups.size ? <Empty>Verified actions will appear after a run.</Empty> : [...groups].map(([key, values]) =>
            <details key={key} className="inbox-item"><summary><strong>{playbookName(key)}</strong><Tag tone="green">{values.length} verified</Tag></summary>
              {values.map((value) => <div key={value.trace_step_id} className="inbox-event">
                <p>{label(value.action)} · {value.policy_rule_id}</p>
                <button className="inbox-text-link" onClick={() => onTrace(value.trace_step_id.split(':')[0])}>View trace <ArrowRight size={14} /></button>
              </div>)}
            </details>)}
          <p>{data.blocked_and_quarantined.length} threats blocked or quarantined</p>
          {data.blocked_and_quarantined.map((item) => <p className="inbox-source" key={item.msg_id}>{item.msg_id} · {item.policy_rule_id}</p>)}
        </Panel>
      </div>
    </div>
  </>;
}

export function InboxWorkspace() {
  const { theme, toggleTheme } = useTheme();
  const { session, refresh: refreshGoogleSession } = useGoogleSession();
  const [view, setView] = useState<View>('briefing');
  const [data, setData] = useState<Briefing | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [traceRun, setTraceRun] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [showResume, setShowResume] = useState(false);
  const [resumeReason, setResumeReason] = useState('');
  const reloadSequence = useRef(0);
  const [platformRevision, setPlatformRevision] = useState(0);
  const platformTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const platformData = usePlatformData(platformRevision);
  const bumpPlatform = useCallback(() => {
    if (platformTimer.current) return;
    platformTimer.current = setTimeout(() => {
      platformTimer.current = null;
      setPlatformRevision((value) => value + 1);
    }, 120);
  }, []);
  const reportError = useCallback((message: string) => setError(message), []);

  const reload = useCallback(async () => {
    const request = ++reloadSequence.current;
    try {
      const [briefing, history] = await Promise.all([api<Briefing>('briefing'), api<{ runs: Run[] }>('runs')]);
      if (request !== reloadSequence.current) return;
      setData(briefing);
      setRuns(history.runs);
      setRevision((value) => value + 1);
    } catch (err) { if (request === reloadSequence.current) setError(showError(err)); }
  }, []);

  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      setView(views.find((item) => item.id === id)?.id ?? 'briefing');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    const events = new EventSource('/api/inbox/events');
    events.addEventListener('connected', () => {
      setConnected(true);
      void reload();
    });
    events.addEventListener('step', (event) => {
      const step = JSON.parse(event.data) as Step;
      setSteps((previous) => {
        const prior = step.stage === 'TRIGGER' ? [] : previous.filter((item) => item.run_id === step.run_id);
        return prior.some((item) => item.id === step.id) ? prior : [...prior, step];
      });
      setTraceRun(step.run_id);
      if (step.stage === 'TRIGGER' || step.stage === 'REPORT') void reload();
    });
    events.addEventListener('state', () => { void reload(); bumpPlatform(); });
    events.addEventListener('platform', () => bumpPlatform());
    events.addEventListener('warning', () => setNotice('An agent loop was prevented. Review the thread in Approval Inbox.'));
    events.onerror = () => setConnected(false);
    void reload();
    return () => events.close();
  }, [reload, bumpPlatform]);

  async function act(action: () => Promise<{ run?: Run | null } | unknown>, message?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action() as { run?: Run | null } | null;
      if (result?.run?.error) throw new Error(result.run.error === 'GOOGLE_REAUTH_REQUIRED'
        ? 'Reconnect this Google account in Connections.' : result.run.error);
      if (message) setNotice(message);
    } catch (err) { setError(showError(err)); }
    finally {
      await Promise.all([reload(), refreshGoogleSession()]);
      setBusy(false);
    }
  }

  async function inspect(id: string, navigate = false, exactStep?: string) {
    try {
      const trace = await api<{ steps: Step[] }>(`runs/${id}/trace`);
      setSteps(trace.steps);
      setTraceRun(id);
      setSelectedStep(exactStep ?? null);
      if (navigate) window.location.hash = 'monitor';
    } catch (err) { setError(showError(err)); }
  }
  const rollback = (id: string, actionIds?: string[]) => void act(
    () => api(`runs/${id}/rollback`, 'POST', { wait: true, ...(actionIds ? { actionIds } : {}) }),
    'Rollback receipt recorded.',
  );

  const title = views.find((item) => item.id === view)!.label;
  const active = runs.some((run) => run.status === 'RUNNING');
  const halted = !!data?.halted;
  const blocked = !data || busy || active || halted;
  const canRun = !blocked && !session?.inboxes.some((item) => item.id === session.active_inbox_id && item.status !== 'active');

  return <div className="inbox-layout">
    <aside className="inbox-sidebar">
      <Link href="/" className="inbox-brand"><SiftvaneMark /><span>Siftvane</span></Link>
      <nav aria-label="Inbox navigation">
        {views.map(({ id, label: itemLabel, icon: Icon }) => <a key={id} href={'#' + id} aria-current={view === id ? 'page' : undefined}>
          <Icon size={17} aria-hidden="true" /><span>{itemLabel}</span>
          {id === 'approvals' && Boolean(data?.needs_attention.length) && <span className="inbox-nav-count">{data?.needs_attention.length}</span>}
        </a>)}
      </nav>
      <div className="inbox-sidebar-bottom">
        <Link href="/about"><CircleHelp size={16} /> About Siftvane</Link>
        <Link href="/settings"><ShieldCheck size={16} /> Connections</Link>
      </div>
    </aside>
    <main className="inbox-main">
      <header className="inbox-header">
        <div className="inbox-title"><h1>{title}</h1>
          <p>{view === 'briefing' ? 'What changed, what needs you, and what Siftvane handled.' :
            view === 'agents' ? 'Every agent your CLI or this console created, with live logs and Workspace artifacts.' :
            view === 'recipes' ? 'Teach a recipe from an agent once; matching emails then run with zero model calls.' :
            view === 'approvals' ? 'Review actions that require your permission.' :
            view === 'calendar' ? 'Review verified changes and upcoming calendar events.' :
            view === 'policy' ? 'See how rule changes affect real decisions before saving.' :
            view === 'monitor' ? 'Schedule runs and inspect the decisions they make.' :
            'Invoice amounts, due dates, and subscription changes.'}</p></div>
        <div className="inbox-actions">
          <button type="button" className="inbox-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={toggleTheme}>
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button type="button" className="inbox-button" data-tone="danger" disabled={!data || (busy && halted)}
            onClick={() => halted ? setShowResume(true) : void act(() => api('kill-switch', 'POST', { active: true, reason: 'Operator used the Inbox panic button.' }))}>
            <Power size={16} /> {halted ? 'Resume agent' : 'Halt agent'}
          </button>
          <button type="button" className="inbox-button" data-tone="primary" disabled={!canRun}
            onClick={() => void act(() => api('runs', 'POST', { wait: true }), 'Inbox run completed.')}>
            <Play size={16} /> {active ? 'Running…' : 'Run now'}
          </button>
        </div>
      </header>
      <GoogleAccountBar session={session} />
      <AgentSwitcherBar data={platformData} onError={reportError} />
      <section className="inbox-status" aria-label="Agent status">
        <div><span>Status</span><Tag tone={halted ? 'red' : connected ? 'green' : 'amber'}>{halted ? 'Halted' : active ? 'Running' : connected ? 'Ready' : 'Connecting'}</Tag></div>
        <div><span>Data source</span><strong>{data?.mode === 'live' ? 'Gmail + Calendar' : data?.mode === 'sandbox' ? 'Sandbox' : '—'}</strong></div>
        <div><span>Agent mode</span>{data ? <Tag tone={data.agent_mode === 'llm' ? 'green' : 'amber'}>{data.agent_mode}</Tag> : '—'}</div>
        <div><span>Last successful run</span><strong>{when(data?.last_success?.completedAt)}</strong></div>
        <div><span>Schedule</span><strong>{data?.schedule.enabled ? label(data.schedule.frequency) : 'Manual'}</strong></div>
        <button type="button" className="inbox-button" disabled={blocked || !data?.run_meta?.rollback_available}
          onClick={() => data?.run_meta && rollback(data.run_meta.id)}>
          <RotateCcw size={16} /> Roll back last run
        </button>
      </section>
      {showResume && <form className="inbox-panel inbox-form-row" onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          const result = await api('kill-switch', 'POST', { active: false, reason: resumeReason });
          setShowResume(false);
          setResumeReason('');
          return result;
        });
      }}>
        <label>Resume audit reason<input value={resumeReason} required onChange={(event) => setResumeReason(event.target.value)} /></label>
        <button className="inbox-button" data-tone="primary" type="submit" disabled={busy || !resumeReason.trim()}>Resume operations</button>
        <button type="button" className="inbox-button" onClick={() => setShowResume(false)}>Cancel</button>
      </form>}
      {error && <div className="inbox-error" role="alert">{error}</div>}
      {notice && <div className="inbox-notice" role="status">{notice}</div>}
      {!data ? <Empty><button className="inbox-button" onClick={() => void reload()}>Reload inbox state</button></Empty> :
        view === 'briefing' ? <>
          <BriefingView data={data} onTrace={(id) => void inspect(id, true)} />
          <ThreadExecutionStack revision={revision} onTrace={(id, step) => void inspect(id, true, step)} />
        </> :
        view === 'agents' ? <AgentsView data={platformData} revision={platformRevision} onError={reportError}
          onTrace={(id) => void inspect(id, true)} /> :
        view === 'recipes' ? <RecipesView data={platformData} revision={platformRevision} onError={reportError}
          onTrace={(id) => void inspect(id, true)} /> :
        view === 'approvals' ? <ApprovalsView pending={data.needs_attention} busy={busy || halted}
          onResolve={(id, approve, edit, calendarEdit, batchEdits) => void act(() => api(`approvals/${id}`, 'POST', { approve, edit, calendarEdit, batchEdits }),
            approve ? 'Approval recorded.' : 'Request rejected.')} /> : view === 'calendar' ? <CalendarView revision={revision} blocked={blocked} rollback={rollback} /> :
        view === 'policy' ? <PolicyView reload={reload} /> :
        view === 'monitor' ? <>
          <ThreadExecutionStack revision={revision} runId={traceRun} onTrace={(id, step) => void inspect(id, false, step)} />
          <Monitor runs={runs} steps={steps} schedule={data.schedule}
            loadTrace={(id) => void inspect(id)} saveSchedule={(schedule) => void act(() => api('schedule', 'PUT', schedule), 'Schedule saved.')}
            connected={connected} busy={busy} traceRun={traceRun} selectedStep={selectedStep} />
        </> :
        <BillsView records={data.digest.upcoming_bills_summary} approvals={data.digest.bill_flags} />}
    </main>
  </div>;
}
