'use client';

import {
  Activity, ArrowDownToLine, Bot, CalendarDays, CircleHelp,
  FileCheck2, GitCompareArrows, House, Inbox, ListChecks, Power, UserRound, Wrench,
  Repeat, RotateCcw, ShieldCheck, Sun, Moon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxPolicy } from '@siftvane/shared';
import { SiftvaneMark } from './SiftvaneMark';
import { useTheme } from './ThemeContext';
import { GoogleAccountBar, useGoogleSession } from './GoogleSession';
import { ThreadExecutionStack } from './ThreadExecutionStack';
import { AgentSwitcherBar, AgentsView, usePlatformData } from './AgentConsole';
import { RecipesView } from './RecipeConsole';
import { PolicyEditor, policyChanges } from './PolicyEditor';
import { HomeView } from './HomeView';

// Home and Approvals are the everyday pages; the rest are operator tools under Advanced.
const views = [
  { id: 'home', label: 'Home', icon: House, simple: true },
  { id: 'approvals', label: 'Approvals', icon: ListChecks, simple: true },
  { id: 'agents', label: 'Agents & Activity', icon: Bot, simple: false },
  { id: 'recipes', label: 'Recipes', icon: Repeat, simple: false },
  { id: 'policy', label: 'Rules & Policy', icon: GitCompareArrows, simple: false },
  { id: 'monitor', label: 'Runs & traces', icon: Activity, simple: false },
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
  run_meta: (Run & { rollback_available: boolean }) | null;
  autonomy: { autonomous_verified: number; gated_for_approval: number; blocked_quarantined: number };
  changed: Change[]; needs_attention: Approval[];
  handled_autonomously: Array<{ trace_step_id: string; playbook_id: string; action: string; entity: string; policy_rule_id: string; tier: number }>;
  blocked_and_quarantined: Array<{ msg_id: string; threat_type: string; policy_rule_id: string }>;
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

/** Why something waits for the user, in plain words (the rule id stays available as a tooltip). */
const approvalReasons: Record<string, string> = {
  AGENT_REPLY_APPROVAL: 'An agent wrote this reply. Read it, change anything, then approve to send it.',
  RECIPIENT_NOT_ALLOWLISTED: 'This person isn’t on your trusted list, so the email waits for you.',
  DUPLICATE_OR_SPOOFED_INVOICE: 'This invoice looks like a duplicate or came from an unverified sender.',
  AGENT_LOOP_PREVENTED: 'An agent kept replying in this thread, so it was stopped to prevent a loop.',
};

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
  const contact = item.proposed_action.effectiveContact;
  const kind = item.proposed_action.kind;
  const title = kind === 'draft' && contact ? 'Reply to ' + contact : kind === 'send' && contact ? 'Email to ' + contact
    : kind === 'calendar' ? 'Calendar change' : playbookName(item.proposed_action.playbook);
  const why = approvalReasons[item.triggered_rule_id] ?? item.reason;
  const hours = Math.floor(seconds / 3600);
  const left = !clock ? '' : expired ? 'Expired' : hours >= 1 ? `Expires in ${hours} h` : `Expires in ${Math.max(1, Math.floor(seconds / 60))} min`;
  return <article className="approval-card">
    <header className="approval-head">
      <span className="block-icon" aria-hidden="true">{kind === 'calendar' ? <CalendarDays size={18} /> : kind === 'review' ? <FileCheck2 size={18} /> : <Inbox size={18} />}</span>
      <div className="block-title"><h3>{title}</h3><p title={item.triggered_rule_id}>{why}</p></div>
      {left && <span className="status-chip" data-tone={expired ? 'neutral' : 'amber'}>{left}</span>}
    </header>
    <div className="approval-body">
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
    </ol> : canEditReply ? <>
      <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Message<textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} /></label>
    </> : item.proposed_action.after && <dl className="inbox-fields">
      {Object.entries(item.proposed_action.after).filter(([field]) => !['id', 'etag'].includes(field)).map(([field, value]) =>
        <div key={field}><dt>{label(field)}</dt><dd>{display(field, value)}</dd></div>)}
    </dl>}
    </div>
    <footer className="approval-foot">
      <button className="inbox-button" type="button" disabled={busy || expired} onClick={() => onResolve(item.approval_id, false)}>Decline</button>
      <button className="inbox-button" data-tone="primary" type="button" disabled={busy || expired || Boolean(canEditReply && (!subject.trim() || !text.trim())) ||
        (canEditCalendar && (!start || !end || start >= end)) || batchEdits?.some((message) => !message.subject.trim() || !message.text.trim())}
        onClick={() => onResolve(item.approval_id, true, canEditReply ? { subject, text } : undefined,
          canEditCalendar ? { start: start + ':00Z', end: end + ':00Z' } : undefined, batchEdits)}>
        {item.batch_actions?.length ? 'Approve batch' : item.triggered_rule_id === 'AGENT_LOOP_PREVENTED' ? 'Reset thread budget' :
          item.proposed_action.kind === 'review' ? 'Acknowledge' : canEditReply ? 'Approve and send' : 'Approve'}
      </button>
    </footer>
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
  return <Panel title={`Waiting for you${items?.length ? ` (${items.length})` : ''}`} icon={<ListChecks size={18} />} action={
    <label className="inline-field">Show <select value={priority} onChange={(event) => {
      setFiltered(null);
      setError('');
      setPriority(event.target.value);
    }}>
      <option value="">All priorities</option><option value="high">High</option>
      <option value="medium">Medium</option><option value="low">Low</option>
    </select></label>}>
    {error ? <p role="alert" className="inbox-error">{error}</p> : !items
      ? <Empty>Loading approvals.</Empty>
      : !items.length ? <Empty>Nothing is waiting for you. New replies and sends from your agents will appear here.</Empty>
      : <div className="approval-list">{items.map((item) =>
        <ApprovalEditor key={item.approval_id} item={item} busy={busy} onResolve={onResolve} />)}</div>}
  </Panel>;
}

function PolicyView({ reload }: { reload: () => Promise<void> }) {
  const [policy, setPolicy] = useState<{ version: number; policy: InboxPolicy; mode: string } | null>(null);
  const [draft, setDraft] = useState<InboxPolicy | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ version: number; policy: InboxPolicy; mode: string }>('policy')
      .then((value) => { setPolicy(value); setDraft(value.policy); })
      .catch((err) => setError(showError(err)));
  }, []);
  const save = async () => {
    if (!policy || !draft) return;
    setError('');
    setBusy(true);
    try {
      const installed = await api<{ version: number; policy: InboxPolicy }>('policy', 'PUT', { version: policy.version, policy: draft });
      setPolicy({ ...installed, mode: policy.mode });
      setDraft(installed.policy);
      setNotice(`Saved as version ${installed.version}. Every agent follows it from its next step.`);
      await reload();
    } catch (err) { setError(showError(err)); }
    finally { setBusy(false); }
  };
  return <Panel title="Rules every agent follows" icon={<GitCompareArrows size={18} />}>
    {policy && draft ? <>
      <p>You are on <strong>version {policy.version}</strong>. These rules decide which actions run on their own and which wait for your approval.</p>
      <PolicyEditor current={policy.policy} draft={draft} onChange={(next) => { setDraft(next); setError(''); setNotice(''); }} />
      <div className="inbox-actions">
        <button className="inbox-button" data-tone="primary" disabled={busy || policyChanges(policy.policy, draft).length === 0}
          onClick={() => void save()}>Save as version {policy.version + 1}</button>
      </div></> : <Empty>Loading your rules.</Empty>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="inbox-error">{error}</p>}
  </Panel>;
}

function Monitor({ runs, steps, loadTrace, connected, traceRun, selectedStep }: {
  runs: Run[]; steps: Step[]; loadTrace: (id: string) => void; connected: boolean; traceRun: string | null; selectedStep: string | null;
}) {
  useEffect(() => {
    if (selectedStep) document.getElementById('trace-' + selectedStep)?.scrollIntoView({ block: 'nearest' });
  }, [selectedStep, steps]);
  const latest = steps[steps.length - 1];
  return <div className="inbox-stack">
    <Panel title="Run history" icon={<ListChecks size={18} />}>
      {!runs.length ? <Empty>Agent runs appear here with every step they took.</Empty> : <div className="inbox-table-wrap"><table>
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

export function InboxWorkspace() {
  const { theme, toggleTheme } = useTheme();
  const { session, refresh: refreshGoogleSession } = useGoogleSession();
  const [view, setView] = useState<View>('home');
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
      setView(views.find((item) => item.id === id)?.id ?? 'home');
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
  const simple = views.find((item) => item.id === view)!.simple;
  const active = runs.some((run) => run.status === 'RUNNING');
  const halted = !!data?.halted;
  const blocked = !data || busy || active || halted;

  return <div className="inbox-layout">
    <aside className="inbox-sidebar">
      <Link href="/" className="inbox-brand"><SiftvaneMark /><span>Siftvane</span></Link>
      <nav aria-label="Inbox navigation">
        {views.filter((item) => item.simple).map(({ id, label: itemLabel, icon: Icon }) => <a key={id} href={'#' + id} aria-current={view === id ? 'page' : undefined}>
          <Icon size={17} aria-hidden="true" /><span>{itemLabel}</span>
          {id === 'approvals' && Boolean(data?.needs_attention.length) && <span className="inbox-nav-count">{data?.needs_attention.length}</span>}
        </a>)}
        <Link href="/settings"><UserRound size={17} aria-hidden="true" /><span>Profile</span></Link>
        <details className="inbox-nav-advanced" open={!simple}>
          <summary><Wrench size={16} aria-hidden="true" /><span>Advanced</span></summary>
          {views.filter((item) => !item.simple).map(({ id, label: itemLabel, icon: Icon }) => <a key={id} href={'#' + id} aria-current={view === id ? 'page' : undefined}>
            <Icon size={16} aria-hidden="true" /><span>{itemLabel}</span>
          </a>)}
          <Link href="/settings#developer"><ShieldCheck size={16} aria-hidden="true" /><span>MCP & connections</span></Link>
        </details>
      </nav>
      <div className="inbox-sidebar-bottom">
        <Link href="/about"><CircleHelp size={16} /> About Siftvane</Link>
      </div>
    </aside>
    <main className="inbox-main">
      <header className="inbox-header">
        <div className="inbox-title"><h1>{title}</h1>
          <p>{view === 'home' ? 'Tell Siftvane what you want done with your email. It builds an agent that keeps working for you.' :
            view === 'agents' ? 'Every agent your CLI or this console created, with live logs and Workspace artifacts.' :
            view === 'recipes' ? 'Teach a recipe from an agent once; matching emails then run with zero model calls.' :
            view === 'approvals' ? 'Replies, sends and changes your agents prepared. Nothing goes out until you approve it.' :
            view === 'policy' ? 'Who agents may contact on their own, and how much they may do in one run.' :
            'Every step each agent run took, with its checks and decisions.'}</p></div>
        <div className="inbox-actions">
          <button type="button" className="inbox-button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={toggleTheme}>
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button type="button" className="inbox-button" data-tone="danger" disabled={!data || (busy && halted)}
            title={halted ? 'Let agents run again' : 'Emergency stop: halt every agent immediately'}
            onClick={() => halted ? setShowResume(true) : void act(() => api('kill-switch', 'POST', { active: true, reason: 'Operator used the Inbox panic button.' }))}>
            <Power size={16} /> {halted ? (simple ? 'Restart agents' : 'Resume agent') : (simple ? 'Stop all agents' : 'Halt agent')}
          </button>
        </div>
      </header>
      {!simple && <><GoogleAccountBar session={session} />
      <AgentSwitcherBar data={platformData} onError={reportError} />
      <section className="inbox-status" aria-label="Agent status">
        <div><span>Status</span><Tag tone={halted ? 'red' : connected ? 'green' : 'amber'}>{halted ? 'Halted' : active ? 'Running' : connected ? 'Ready' : 'Connecting'}</Tag></div>
        <div><span>Data source</span><strong>{data?.mode === 'live' ? 'Gmail + Calendar' : data?.mode === 'sandbox' ? 'Sandbox' : '—'}</strong></div>
        <div><span>AI</span>{data ? <Tag tone={data.agent_mode === 'llm' ? 'green' : 'amber'}>{data.agent_mode === 'llm' ? data.agent_model : 'Not set'}</Tag> : '—'}</div>
        <div><span>Last successful run</span><strong>{when(data?.last_success?.completedAt)}</strong></div>
        <button type="button" className="inbox-button" disabled={blocked || !data?.run_meta?.rollback_available}
          onClick={() => data?.run_meta && rollback(data.run_meta.id)}>
          <RotateCcw size={16} /> Roll back last run
        </button>
      </section></>}
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
      {view === 'home' ? <HomeView data={platformData} session={session} waiting={data?.needs_attention.length ?? 0}
          aiReady={!data || data.agent_mode === 'llm'} onError={reportError} /> :
        !data ? <Empty><button className="inbox-button" onClick={() => void reload()}>Reload inbox state</button></Empty> :
        view === 'agents' ? <AgentsView data={platformData} revision={platformRevision} onError={reportError}
          onTrace={(id) => void inspect(id, true)} /> :
        view === 'recipes' ? <RecipesView data={platformData} revision={platformRevision} onError={reportError}
          onTrace={(id) => void inspect(id, true)} /> :
        view === 'approvals' ? <ApprovalsView pending={data.needs_attention} busy={busy || halted}
          onResolve={(id, approve, edit, calendarEdit, batchEdits) => void act(() => api(`approvals/${id}`, 'POST', { approve, edit, calendarEdit, batchEdits }),
            approve ? 'Approval recorded.' : 'Request rejected.')} /> :
        view === 'policy' ? <PolicyView reload={reload} /> :
        <>
          <ThreadExecutionStack revision={revision} runId={traceRun} onTrace={(id, step) => void inspect(id, false, step)} />
          <Monitor runs={runs} steps={steps} loadTrace={(id) => void inspect(id)}
            connected={connected} traceRun={traceRun} selectedStep={selectedStep} />
        </>}
    </main>
  </div>;
}
