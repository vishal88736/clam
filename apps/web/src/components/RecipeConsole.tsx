'use client';

import {
  Bot, Check, CircleDot, ClipboardCopy, FlaskConical, GraduationCap, Mail, Pause, Play, Plus, Power, Repeat,
  Send, Sparkles, Terminal, Trash2, X, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { nice, platform, serviceIcon, Tag, time, type PlatformData } from './AgentConsole';

type Provenance = 'request' | 'step' | 'constant' | 'formula' | 'builtin' | 'ask';
type Binding = { step: string; arg: string; kind: Provenance; detail: string; field?: string; name?: string };
type Rule = { field: string; op: '>' | '>=' | '<' | '<=' | '=' | '!=' | 'contains' | 'missing'; value: string; then: 'approve' | 'skip' | 'agent' };
type Computed = { name: string; expr: string };
type Decision = 'run' | 'approve' | 'skip' | 'agent' | 'filtered';
type BacktestRow = { message_id: string; date: string; from: string; subject: string; decision: Decision; reason: string; actions: string[]; agent_handled: boolean };
type Recipe = {
  id: string; name: string; goal_prompt: string; status: 'draft' | 'enabled' | 'paused' | 'archived'; version: number; mode: 'sandbox' | 'live';
  source_agent: { id: string; name: string }; trigger: { step: string; description: string };
  steps: Array<{ id: string; op: string; service: string; label: string; tier2: boolean; bindings: Binding[] }>;
  computed: Computed[]; rules: Rule[]; observed_fields: string[]; asks: Binding[]; ready: boolean; blockers: string[];
  backtest: null | { version: number; at: string; duration_ms: number; per_email_ms: number; tokens: number;
    counts: Record<Decision, number>; agreement: { agent_handled: number; agree: number; rate: number | null }; rows: BacktestRow[] };
  backtest_current: boolean;
  stats: { runs: number; handled: number; held: number; escalated: number; skipped: number; total_ms: number; last_ms: number | null; tokens: number };
  baseline: { runs: number; avg_tokens: number | null; avg_ms: number | null; model: string | null; planner: string };
  item_counts: Record<string, number>; interval_seconds: number; next_run_at: string | null; last_run_at: string | null; tool_name: string;
};
type Item = { message_id: string; status: 'done' | 'awaiting_approval' | 'declined' | 'escalated' | 'skipped'; reason: string; summary: string;
  approval_id: string | null; agent_id: string | null; updated_at: string };
type RecipeRun = { run_id: string; trigger: string; status: string; handled: number; held: number; escalated: number; skipped: number; duration_ms: number; tokens: number; created_at: string };
type Learnable = { agent_id: string; name: string; ready: boolean; reason: string | null };

const provenance: Record<Provenance, { label: string; tone: 'green' | 'amber' | 'red' | 'neutral'; hint: string }> = {
  request: { label: 'From the email', tone: 'green', hint: 'Read from each matching email' },
  step: { label: 'From a step', tone: 'neutral', hint: 'Output of an earlier step' },
  constant: { label: 'Fixed', tone: 'neutral', hint: 'The same every time' },
  formula: { label: 'Formula', tone: 'amber', hint: 'Calculated by your formula' },
  builtin: { label: 'Automatic', tone: 'neutral', hint: 'Filled in by the recipe (date, count, summary)' },
  ask: { label: 'Question', tone: 'red', hint: 'Siftvane could not prove where this comes from' },
};
const decisionView: Record<Decision, [string, 'green' | 'amber' | 'red' | 'neutral']> = {
  run: ['Runs automatically', 'green'], approve: ['Asks you first', 'amber'], agent: ['Goes to an agent', 'red'],
  skip: ['Skipped', 'neutral'], filtered: ['Left out by a step', 'neutral'],
};
const itemView: Record<Item['status'], [string, 'green' | 'amber' | 'red' | 'neutral']> = {
  done: ['Handled', 'green'], awaiting_approval: ['Waiting for you', 'amber'], escalated: ['Needs an agent', 'red'],
  skipped: ['Skipped', 'neutral'], declined: ['Declined', 'neutral'],
};
const statusView: Record<Recipe['status'], [string, 'green' | 'amber' | 'red' | 'neutral']> = {
  draft: ['Draft', 'amber'], enabled: ['On', 'green'], paused: ['Off', 'neutral'], archived: ['Deleted', 'neutral'],
};
const ops: Array<[Rule['op'], string]> = [['>', 'is more than'], ['>=', 'is at least'], ['<', 'is less than'], ['<=', 'is at most'],
  ['=', 'is'], ['!=', 'is not'], ['contains', 'contains'], ['missing', 'is missing']];
const thens: Array<[Rule['then'], string]> = [['approve', 'Ask me first'], ['skip', 'Skip it'], ['agent', 'Hand it to an agent']];
const ms = (value: number | null | undefined) => value === null || value === undefined ? '—' : value >= 1000 ? (value / 1000).toFixed(1) + ' s' : Math.round(value) + ' ms';
const tokens = (value: number | null | undefined) => value === null || value === undefined ? '—' : value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value);
const fieldLabel = (field: string) => field.replace(/_/g, ' ');
const selectedKey = 'siftvane.selected-recipe';
const remember = (id: string | null) => { try { if (id) sessionStorage.setItem(selectedKey, id); else sessionStorage.removeItem(selectedKey); } catch { /* storage is optional */ } };
const recalled = () => { try { return sessionStorage.getItem(selectedKey); } catch { return null; } };

/** Called from an agent card: learns a recipe and opens it on the Recipes page. */
export async function teachRecipe(agentId: string) {
  const { recipe } = await platform<{ recipe: Recipe }>('recipes', 'POST', { agent_id: agentId });
  remember(recipe.id);
  window.location.hash = 'recipes';
  return recipe;
}

function Section({ title, icon, children, action, testId }: { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode; testId?: string }) {
  return <section className="recipe-section" data-testid={testId}>
    <div className="inbox-panel-head"><h3>{icon}{title}</h3>{action}</div>
    {children}
  </section>;
}

function Checklist({ recipe }: { recipe: Recipe }) {
  const steps = [
    { done: !recipe.asks.length, label: recipe.asks.length ? `Answer ${recipe.asks.length} question${recipe.asks.length > 1 ? 's' : ''}` : 'Every value has a proven source' },
    { done: recipe.backtest_current, label: recipe.backtest_current ? 'Backtested on your mail' : recipe.backtest ? 'Rules changed — backtest again' : 'Backtest on mail you already have' },
    { done: recipe.status === 'enabled', label: recipe.status === 'enabled' ? 'Switched on' : 'Switch it on' },
  ];
  return <ol className="recipe-checklist" aria-label="Setup progress">{steps.map((step, index) =>
    <li key={step.label} data-done={step.done}>{step.done ? <Check size={14} /> : <span>{index + 1}</span>}{step.label}</li>)}</ol>;
}

function Savings({ recipe }: { recipe: Recipe }) {
  const recipeMs = recipe.stats.runs ? recipe.stats.total_ms / recipe.stats.runs : recipe.backtest?.duration_ms ?? null;
  const agentMs = recipe.baseline.avg_ms;
  const faster = agentMs && recipeMs ? agentMs / Math.max(1, recipeMs) : null;
  return <div className="recipe-savings" data-testid="recipe-savings">
    <div><span>Agent run</span><strong>{recipe.baseline.planner === 'llm-planner' ? tokens(recipe.baseline.avg_tokens) + ' tokens' : 'Offline planner'}</strong>
      <small>{ms(agentMs)} per run{recipe.baseline.model ? ' · ' + recipe.baseline.model : ''}</small></div>
    <div data-highlight="true"><span>Recipe run</span><strong data-testid="recipe-tokens">{tokens(recipe.stats.tokens)} tokens</strong>
      <small>{ms(recipeMs)} per run · no model call</small></div>
    <div><span>So far</span><strong>{recipe.stats.handled} handled</strong>
      <small>{recipe.stats.runs} runs{faster && faster > 1.2 ? ` · ${faster.toFixed(faster > 10 ? 0 : 1)}× faster` : ''}</small></div>
  </div>;
}

function Questions({ recipe, busy, save }: { recipe: Recipe; busy: boolean; save: (computed: Computed[]) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, { mode: 'field' | 'fixed' | 'formula' | 'blank'; value: string }>>({});
  if (!recipe.asks.length) return null;
  const unique = [...new Map(recipe.asks.map((ask) => [ask.name ?? ask.detail, ask])).values()];
  const expr = (answer: { mode: string; value: string }) => answer.mode === 'blank' ? '""' : answer.mode === 'fixed' ? JSON.stringify(answer.value.replace(/["\\]/g, '')) : answer.value;
  return <Section title="Questions before it can run" icon={<CircleDot size={15} />} testId="recipe-questions">
    <p>Siftvane could not prove where these values come from in your emails. Tell it once and the recipe remembers.</p>
    {unique.map((ask) => {
      const name = ask.name ?? '';
      const answer = answers[name] ?? { mode: 'field', value: recipe.observed_fields[0] ?? '' };
      const set = (patch: Partial<typeof answer>) => setAnswers({ ...answers, [name]: { ...answer, ...patch } });
      return <form key={name} className="recipe-question" onSubmit={(event) => {
        event.preventDefault();
        void save([...recipe.computed.filter((entry) => entry.name !== name), { name, expr: expr(answer) }]);
      }}>
        <strong>{ask.detail}</strong>
        <div className="inbox-actions">
          <select aria-label={`How to fill ${name}`} value={answer.mode} onChange={(event) => set({ mode: event.target.value as typeof answer.mode,
            value: event.target.value === 'field' ? recipe.observed_fields[0] ?? '' : '' })}>
            <option value="field">Use a field from the email</option><option value="fixed">Always use this value</option>
            <option value="formula">Calculate it</option><option value="blank">Leave it blank</option>
          </select>
          {answer.mode === 'field' && <select aria-label="Email field" value={answer.value} onChange={(event) => set({ value: event.target.value })}>
            {recipe.observed_fields.map((field) => <option key={field} value={field}>{fieldLabel(field)}</option>)}</select>}
          {(answer.mode === 'fixed' || answer.mode === 'formula') && <input aria-label="Value" value={answer.value} maxLength={120}
            placeholder={answer.mode === 'formula' ? 'amount * 0.5' : 'Paid'} onChange={(event) => set({ value: event.target.value })} />}
          <button type="submit" className="inbox-button" data-tone="primary" disabled={busy || (answer.mode !== 'blank' && !answer.value.trim())}>Save answer</button>
        </div>
      </form>;
    })}
  </Section>;
}

function RulesEditor({ recipe, busy, save }: { recipe: Recipe; busy: boolean; save: (patch: { rules: Rule[]; computed: Computed[] }) => Promise<void> }) {
  const [rules, setRules] = useState<Rule[]>(recipe.rules);
  const [computed, setComputed] = useState<Computed[]>(recipe.computed);
  useEffect(() => { setRules(recipe.rules); setComputed(recipe.computed); }, [recipe.id, recipe.version, recipe.rules, recipe.computed]);
  const fields = [...new Set([...recipe.observed_fields, ...computed.map((entry) => entry.name).filter(Boolean)])];
  const dirty = JSON.stringify({ rules, computed }) !== JSON.stringify({ rules: recipe.rules, computed: recipe.computed });
  const numeric = fields.find((field) => ['amount', 'total', 'price'].includes(field));
  return <Section title="Rules" icon={<Zap size={15} />} testId="recipe-rules" action={dirty ? <Tag tone="amber">Unsaved changes</Tag> : undefined}>
    <p>Rules are checked on every email, top to bottom. The first match decides. Emails with no matching rule run automatically.
      If a rule needs a value the email doesn&apos;t have, the email goes to an agent — the recipe never guesses.</p>
    {!rules.length && <div className="inbox-empty">No rules yet: every matching email runs automatically.</div>}
    {numeric && !rules.some((rule) => rule.field === numeric) && <button type="button" className="inbox-text-link" data-testid="suggest-rule"
      onClick={() => setRules([...rules, { field: numeric, op: '>', value: '100', then: 'approve' }])}>+ Suggested: ask me before anything over 100</button>}
    <ol className="recipe-rules">{rules.map((rule, index) => {
      const set = (patch: Partial<Rule>) => setRules(rules.map((entry, row) => row === index ? { ...entry, ...patch } : entry));
      return <li key={index} data-testid="recipe-rule">
        <span>If</span>
        <select aria-label="Field" value={rule.field} onChange={(event) => set({ field: event.target.value })}>
          {[...new Set([rule.field, ...fields])].map((field) => <option key={field} value={field}>{fieldLabel(field)}</option>)}</select>
        <select aria-label="Comparison" value={rule.op} onChange={(event) => set({ op: event.target.value as Rule['op'] })}>
          {ops.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {rule.op !== 'missing' && <input aria-label="Value" value={rule.value} maxLength={80} onChange={(event) => set({ value: event.target.value })} />}
        <span>then</span>
        <select aria-label="Then" value={rule.then} onChange={(event) => set({ then: event.target.value as Rule['then'] })}>
          {thens.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <button type="button" className="inbox-button" aria-label="Remove rule" onClick={() => setRules(rules.filter((_entry, row) => row !== index))}><X size={14} /></button>
      </li>;
    })}</ol>
    <div className="inbox-actions">
      <button type="button" className="inbox-button" disabled={rules.length >= 12} onClick={() => setRules([...rules,
        { field: numeric ?? fields[0] ?? 'amount', op: '>', value: '', then: 'approve' }])}><Plus size={14} /> Add rule</button>
    </div>
    <h4>Formulas</h4>
    <p>Work out a value from the email, like <code>refund = amount * 0.5</code> or <code>fee = round(total * 0.03, 2)</code>.
      Use the result in rules or as a sheet column with the same name.</p>
    <ol className="recipe-rules">{computed.map((entry, index) => {
      const set = (patch: Partial<Computed>) => setComputed(computed.map((item, row) => row === index ? { ...item, ...patch } : item));
      return <li key={index} data-testid="recipe-formula">
        <input aria-label="Formula name" value={entry.name} maxLength={40} placeholder="refund" onChange={(event) => set({ name: event.target.value })} />
        <span>=</span>
        <input aria-label="Formula" className="recipe-formula" value={entry.expr} maxLength={200} placeholder="amount * 0.5" onChange={(event) => set({ expr: event.target.value })} />
        <button type="button" className="inbox-button" aria-label="Remove formula" onClick={() => setComputed(computed.filter((_item, row) => row !== index))}><X size={14} /></button>
      </li>;
    })}</ol>
    <div className="inbox-actions">
      <button type="button" className="inbox-button" disabled={computed.length >= 12} onClick={() => setComputed([...computed, { name: '', expr: '' }])}><Plus size={14} /> Add formula</button>
      <button type="button" className="inbox-button" data-tone="primary" data-testid="save-rules" disabled={busy || !dirty ||
        rules.some((rule) => rule.op !== 'missing' && !rule.value.trim()) || computed.some((entry) => !entry.name.trim())}
        onClick={() => void save({ rules: rules.map((rule) => ({ ...rule, value: rule.op === 'missing' ? '' : rule.value.trim() })),
          computed: computed.map((entry) => ({ name: entry.name.trim(), expr: entry.expr.trim() })) })}>Save rules</button>
      {dirty && <button type="button" className="inbox-button" onClick={() => { setRules(recipe.rules); setComputed(recipe.computed); }}>Undo</button>}
    </div>
  </Section>;
}

function TestEmail({ recipe, busy, send }: { recipe: Recipe; busy: boolean; send: (input: { from: string; subject: string; text: string }) => Promise<void> }) {
  const sample = recipe.backtest?.rows.find((row) => row.decision === 'run') ?? recipe.backtest?.rows[0];
  const amount = recipe.observed_fields.includes('amount');
  const [from, setFrom] = useState(sample?.from || 'billing@example.com');
  const [subject, setSubject] = useState(sample ? 'New: ' + sample.subject.replace(/^new:\s*/i, '') : 'New request');
  const [text, setText] = useState(amount ? 'Vendor: Example Co\nAmount: 250.00 USD\nDue: 2026-12-30' : 'Hello,\n\nPlease take care of this request.');
  return <Section title="Try it with a test email" icon={<Mail size={15} />} testId="recipe-test-email">
    <p>Drop an email into the $0 sandbox inbox and run the recipe on it. Change the amount to see your rules react.</p>
    <form className="recipe-test" onSubmit={(event: FormEvent) => { event.preventDefault(); void send({ from, subject, text }); }}>
      <label>From<input type="email" value={from} required maxLength={120} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Subject<input value={subject} required maxLength={150} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Body<textarea rows={3} value={text} required maxLength={4000} onChange={(event) => setText(event.target.value)} /></label>
      <button type="submit" className="inbox-button" data-tone="primary" disabled={busy || !recipe.ready}><Send size={14} />
        {recipe.ready ? 'Send and run the recipe' : 'Finish setup first'}</button>
    </form>
  </Section>;
}

function RecipeDetail({ recipe, items, runs, busy, act, onTrace }: {
  recipe: Recipe; items: Item[]; runs: RecipeRun[]; busy: boolean; onTrace: (runId: string) => void;
  act: (work: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [name, setName] = useState(recipe.name);
  const [copied, setCopied] = useState(false);
  useEffect(() => setName(recipe.name), [recipe.id, recipe.name]);
  const [statusText, tone] = statusView[recipe.status];
  const patch = (body: unknown, success = 'Saved.') => act(() => platform(`recipes/${recipe.id}`, 'PATCH', body), success);
  const post = (action: string, success: string) => act(() => platform(`recipes/${recipe.id}/${action}`, 'POST', {}), success);
  const waiting = items.filter((item) => item.status === 'awaiting_approval');
  const escalated = items.filter((item) => item.status === 'escalated');
  const history = items.filter((item) => !['awaiting_approval', 'escalated'].includes(item.status) && item.summary);
  const counts = recipe.backtest?.counts;

  return <article className="recipe-detail" data-testid="recipe-detail" data-recipe-id={recipe.id}>
    <header className="recipe-head">
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && name !== recipe.name) void patch({ name: name.trim() }, 'Renamed.'); }}>
        <label className="sr-only" htmlFor="recipe-name">Recipe name</label>
        <input id="recipe-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)}
          onBlur={() => { if (name.trim() && name !== recipe.name) void patch({ name: name.trim() }, 'Renamed.'); }} />
      </form>
      <Tag tone={tone} testId="recipe-status">{statusText}</Tag>
      <Tag>v{recipe.version}</Tag>
      <div className="inbox-actions">
        <button type="button" className="inbox-button" disabled={busy || Boolean(recipe.asks.length)} data-testid="recipe-backtest"
          onClick={() => void post('backtest', 'Backtest finished. Nothing in your inbox was changed.')}><FlaskConical size={14} /> Backtest</button>
        <button type="button" className="inbox-button" disabled={busy || !recipe.ready} data-testid="recipe-run"
          onClick={() => void post('run', 'Recipe ran.')}><Play size={14} /> Run now</button>
        {recipe.status === 'enabled'
          ? <button type="button" className="inbox-button" disabled={busy} data-testid="recipe-toggle" onClick={() => void post('disable', 'Recipe switched off.')}><Pause size={14} /> Switch off</button>
          : <button type="button" className="inbox-button" data-tone="primary" disabled={busy || !recipe.ready} data-testid="recipe-toggle"
            title={recipe.blockers.join(' · ')} onClick={() => void post('enable', 'Recipe is on. New matching mail now runs with no model call.')}><Power size={14} /> Switch on</button>}
        <button type="button" className="inbox-button" data-tone="danger" disabled={busy} aria-label="Delete recipe"
          onClick={() => window.confirm(`Delete the recipe "${recipe.name}"? Its history stays in the logs.`) && void post('archive', 'Recipe deleted.')}><Trash2 size={14} /></button>
      </div>
    </header>
    <p className="recipe-goal">Learned from <strong>{recipe.source_agent.name}</strong>: “{recipe.goal_prompt}”</p>
    <Checklist recipe={recipe} />
    <Savings recipe={recipe} />

    <Section title="When" icon={<Mail size={15} />}>
      <div className="recipe-when"><span>{recipe.trigger.description}</span>
        <label>Check for new mail every
          <select value={recipe.interval_seconds} disabled={busy} onChange={(event) => void patch({ interval_seconds: Number(event.target.value) }, 'Schedule saved.')}>
            {[60, 300, 900, 3600, 86_400].map((seconds) => <option key={seconds} value={seconds}>{seconds < 3600 ? seconds / 60 + ' min' : seconds === 3600 ? '1 hour' : '1 day'}</option>)}
            {![60, 300, 900, 3600, 86_400].includes(recipe.interval_seconds) && <option value={recipe.interval_seconds}>{Math.round(recipe.interval_seconds / 60)} min</option>}
          </select>
        </label>
        {recipe.status === 'enabled' && recipe.next_run_at && <small>Next check {time(recipe.next_run_at)}</small>}
      </div>
    </Section>

    <Section title="Then" icon={<Repeat size={15} />} testId="recipe-steps" action={<div className="recipe-legend">{(['request', 'formula', 'constant', 'ask'] as Provenance[])
      .map((kind) => <Tag key={kind} tone={provenance[kind].tone}>{provenance[kind].label}</Tag>)}</div>}>
      <ol className="recipe-steps">{recipe.steps.map((step) => <li key={step.id}>
        <div className="recipe-step-title">{serviceIcon(step.service, 14)}<strong>{step.label}</strong>{step.tier2 && <Tag tone="amber">You approve</Tag>}</div>
        <ul className="recipe-bindings">{step.bindings.filter((binding) => binding.arg !== 'from').map((binding, index) =>
          <li key={index} data-kind={binding.kind} title={provenance[binding.kind].hint} data-testid="recipe-binding">
            <Tag tone={provenance[binding.kind].tone}>{provenance[binding.kind].label}</Tag><span>{binding.detail}</span></li>)}</ul>
      </li>)}</ol>
    </Section>

    <Questions recipe={recipe} busy={busy} save={(computed) => patch({ computed }, 'Answer saved. Run a backtest to check it.')} />
    <RulesEditor recipe={recipe} busy={busy} save={(body) => patch(body, 'Rules saved. Run a backtest before the recipe runs again.')} />

    <Section title="Backtest" icon={<FlaskConical size={15} />} testId="recipe-backtest-results" action={recipe.backtest &&
      <Tag tone={recipe.backtest_current ? 'green' : 'amber'}>{recipe.backtest_current ? `${time(recipe.backtest.at)} · ${recipe.backtest.tokens} tokens` : 'Out of date'}</Tag>}>
      {!recipe.backtest ? <div className="inbox-empty">Replay the recipe on mail already in your inbox to see what it would do. Nothing is changed.
        <button type="button" className="inbox-button" data-tone="primary" disabled={busy || Boolean(recipe.asks.length)}
          onClick={() => void post('backtest', 'Backtest finished. Nothing in your inbox was changed.')}><FlaskConical size={14} /> Run backtest</button></div> : <>
        <div className="recipe-counts">
          {(Object.keys(decisionView) as Decision[]).filter((decision) => counts?.[decision]).map((decision) =>
            <Tag key={decision} tone={decisionView[decision][1]}>{counts![decision]} · {decisionView[decision][0]}</Tag>)}
          <span>{recipe.backtest.rows.length} emails in {ms(recipe.backtest.duration_ms)} ({recipe.backtest.per_email_ms} ms each to decide)</span>
        </div>
        {recipe.backtest.agreement.rate !== null && <p data-testid="recipe-agreement">Agrees with <strong>{recipe.source_agent.name}</strong> on {recipe.backtest.agreement.agree} of {recipe.backtest.agreement.agent_handled} emails
          it handled ({Math.round(recipe.backtest.agreement.rate * 100)}%).</p>}
        <div className="inbox-table-wrap"><table className="recipe-table">
          <thead><tr><th>Email</th><th>Decision</th><th>What it would do</th></tr></thead>
          <tbody>{recipe.backtest.rows.map((row) => <tr key={row.message_id} data-testid="backtest-row" data-decision={row.decision}>
            <td><strong>{row.subject || '(no subject)'}</strong><small>{row.from} · {row.date}{row.agent_handled ? ' · handled by the agent' : ''}</small></td>
            <td><Tag tone={decisionView[row.decision][1]}>{decisionView[row.decision][0]}</Tag>{row.decision !== 'run' && <small>{row.reason}</small>}</td>
            <td>{row.actions.length ? <ul>{row.actions.map((action, index) => <li key={index}>{action}</li>)}</ul> : <small>Nothing</small>}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
    </Section>

    <Section title="Waiting for you" icon={<CircleDot size={15} />} testId="recipe-waiting">
      {!waiting.length && !escalated.length ? <div className="inbox-empty">Nothing waiting. Emails your rules hold, or that the recipe can&apos;t decide, show up here.</div> :
        <ul className="recipe-items">
          {waiting.map((item) => <li key={item.message_id} data-testid="recipe-item" data-status={item.status}>
            <div><strong>{item.summary.split(' · from ')[0]}</strong><small>{item.summary.split(' · from ')[1]} · {item.reason}</small></div>
            <Tag tone="amber">Waiting for you</Tag>
            <div className="inbox-actions">
              <button type="button" className="inbox-button" disabled={busy} onClick={() => void act(() =>
                platform(`recipes/${recipe.id}/items/${encodeURIComponent(item.message_id)}/decline`, 'POST', {}), 'Declined. Nothing was done.')}>Decline</button>
              <button type="button" className="inbox-button" data-tone="primary" disabled={busy} data-testid="approve-item" onClick={() => void act(() =>
                platform(`recipes/${recipe.id}/items/${encodeURIComponent(item.message_id)}/approve`, 'POST', {}), 'Approved. The recipe is finishing it.')}>Approve</button>
            </div>
          </li>)}
          {escalated.map((item) => <li key={item.message_id} data-testid="recipe-item" data-status={item.status}>
            <div><strong>{item.summary.split(' · from ')[0]}</strong><small>{item.summary.split(' · from ')[1]} · {item.reason}</small></div>
            <Tag tone="red">{item.agent_id ? 'With an agent' : 'Needs an agent'}</Tag>
            {item.agent_id ? <a className="inbox-text-link" href="#agents">See the agent</a> :
              <button type="button" className="inbox-button" disabled={busy} onClick={() => void act(() =>
                platform(`recipes/${recipe.id}/items/${encodeURIComponent(item.message_id)}/escalate`, 'POST', {}), 'Handed to a new agent.')}><Bot size={14} /> Hand to agent</button>}
          </li>)}
        </ul>}
    </Section>

    {recipe.mode === 'sandbox' && <TestEmail key={recipe.id + recipe.backtest?.at} recipe={recipe} busy={busy} send={(input) => act(async () => {
      await platform('sandbox/messages', 'POST', input);
      await platform(`recipes/${recipe.id}/run`, 'POST', {});
    }, 'Test email delivered and the recipe ran.')} />}

    <Section title="Activity" icon={<Sparkles size={15} />} testId="recipe-activity">
      {!runs.length && !history.length ? <div className="inbox-empty">Runs and handled emails appear here.</div> : <>
        {runs.length > 0 && <div className="inbox-table-wrap"><table className="recipe-table">
          <thead><tr><th>Run</th><th>Handled</th><th>Waiting</th><th>To agent</th><th>Time</th><th>Tokens</th></tr></thead>
          <tbody>{runs.map((run) => <tr key={run.run_id} data-testid="recipe-run-row">
            <td><button type="button" className="inbox-text-link" onClick={() => onTrace(run.run_id)}>{time(run.created_at)}</button>
              <small>{nice(run.trigger.replace(/^mcp:/, 'CLI: '))}{run.status !== 'COMPLETED' ? ' · ' + nice(run.status) : ''}</small></td>
            <td>{run.handled}</td><td>{run.held}</td><td>{run.escalated}</td><td>{ms(run.duration_ms)}</td><td><Tag tone="green">{run.tokens}</Tag></td>
          </tr>)}</tbody>
        </table></div>}
        {history.length > 0 && <ul className="recipe-items">{history.slice(0, 20).map((item) => <li key={item.message_id} data-testid="recipe-item" data-status={item.status}>
          <div><strong>{item.summary.split(' · from ')[0]}</strong><small>{item.summary.split(' · from ')[1]} · {item.reason}</small></div>
          <Tag tone={itemView[item.status][1]}>{itemView[item.status][0]}</Tag><small>{time(item.updated_at)}</small>
        </li>)}</ul>}
      </>}
    </Section>

    <Section title="Use it from your CLI" icon={<Terminal size={15} />}>
      <p>{recipe.status === 'enabled' ? 'This recipe is published as an MCP tool. Any connected CLI agent can run it — with zero model calls on the Siftvane side.'
        : 'Switch the recipe on to publish it as an MCP tool for Claude Code, Codex, Cursor, and other MCP clients.'}
        {' '}CLI agents can run recipes but can never approve held emails.</p>
      <div className="recipe-tool"><code data-testid="recipe-tool-name">{recipe.tool_name}</code>
        <button type="button" className="inbox-button" onClick={() => {
          void navigator.clipboard?.writeText(recipe.tool_name).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
        }}><ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
        <span>Try: “Run my {recipe.name} recipe”</span></div>
    </Section>
  </article>;
}

export function RecipesView({ data, revision, onTrace, onError }: {
  data: PlatformData; revision: number; onTrace: (runId: string) => void; onError: (message: string) => void;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [learnable, setLearnable] = useState<Learnable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ recipe: Recipe; items: Item[]; runs: RecipeRun[] } | null>(null);
  const [teachFrom, setTeachFrom] = useState('');
  const [teachName, setTeachName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    platform<{ recipes: Recipe[]; learnable: Learnable[] }>('recipes').then((result) => {
      if (!live) return;
      setRecipes(result.recipes);
      setLearnable(result.learnable);
      setSelected((current) => {
        const wanted = current ?? recalled();
        return wanted && result.recipes.some((recipe) => recipe.id === wanted) ? wanted : result.recipes[0]?.id ?? null;
      });
    }).catch((failure) => onError(failure instanceof Error ? nice(failure.message) : 'Could not load recipes'));
    return () => { live = false; };
  }, [revision, tick, onError]);

  useEffect(() => {
    if (recipes !== null) remember(selected);
    if (!selected) { setDetail(null); return; }
    let live = true;
    platform<{ recipe: Recipe; items: Item[]; runs: RecipeRun[] }>('recipes/' + selected).then((result) => { if (live) setDetail(result); })
      .catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [selected, revision, tick, recipes]);

  useEffect(() => {
    const ready = learnable.filter((entry) => entry.ready);
    if (!ready.some((entry) => entry.agent_id === teachFrom)) setTeachFrom(ready[0]?.agent_id ?? '');
  }, [learnable, teachFrom]);

  const act = useCallback(async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setNotice('');
    try {
      await work();
      if (success) setNotice(success);
      setTick((value) => value + 1);
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : '';
      onError(({
        RECIPE_NOT_READY: 'Answer every question and run a backtest on this version first.',
        RECIPE_FORMULA_INVALID: 'That formula is not valid. Use numbers, field names, + - * / and round(), min(), max().',
        RECIPE_FORMULA_UNKNOWN_FIELD: 'A formula uses a field this recipe never saw in your emails.',
        RECIPE_AGENT_NOT_READY: 'That agent cannot be taught yet.',
        INBOX_HALTED: 'The kill switch is on. Resume operations before running recipes.',
      } as Record<string, string>)[code] ?? (code ? nice(code) : 'Request failed'));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  const agentNames = useMemo(() => new Map(data.agents.map((agent) => [agent.id, agent.name])), [data.agents]);
  const ready = learnable.filter((entry) => entry.ready);
  const blocked = learnable.filter((entry) => !entry.ready);
  const current = detail && detail.recipe.id === selected ? detail : null;
  const taught = new Set((recipes ?? []).map((recipe) => recipe.source_agent.id));

  return <div className="inbox-stack">
    <section className="inbox-panel recipe-hero">
      <div className="inbox-panel-head"><h2><GraduationCap size={18} />Recipes: teach once, run for free</h2><Tag tone="green">0 tokens per run</Tag></div>
      <p>A recipe remembers how one of your agents handled a kind of email. After that, matching emails are handled instantly by code with
        no AI call. Rules hold risky ones for you, and anything the recipe can&apos;t work out goes to an agent instead of being guessed.</p>
      <ol className="recipe-howto">
        <li><GraduationCap size={16} /><div><strong>1. Teach</strong><span>Pick an agent that did the job right.</span></div></li>
        <li><FlaskConical size={16} /><div><strong>2. Check</strong><span>Add rules, then backtest on mail you already have.</span></div></li>
        <li><Power size={16} /><div><strong>3. Switch on</strong><span>New mail runs with zero tokens, under every safety check.</span></div></li>
      </ol>
      <form className="recipe-teach" onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          const { recipe } = await platform<{ recipe: Recipe }>('recipes', 'POST', { agent_id: teachFrom, name: teachName.trim() || undefined });
          setSelected(recipe.id);
          setTeachName('');
        }, 'Recipe learned. Review it below, then run a backtest.');
      }}>
        <label>Teach from agent<select value={teachFrom} onChange={(event) => setTeachFrom(event.target.value)} disabled={!ready.length} data-testid="teach-agent">
          {!ready.length && <option value="">No agent is ready yet</option>}
          {ready.map((entry) => <option key={entry.agent_id} value={entry.agent_id}>{entry.name}{taught.has(entry.agent_id) ? ' (already has a recipe)' : ''}</option>)}
        </select></label>
        <label>Recipe name (optional)<input value={teachName} maxLength={80} placeholder={agentNames.get(teachFrom) ?? 'Billing tracker'}
          onChange={(event) => setTeachName(event.target.value)} /></label>
        <button type="submit" className="inbox-button" data-tone="primary" disabled={busy || !teachFrom} data-testid="teach-recipe"><GraduationCap size={15} /> Teach recipe</button>
      </form>
      {!ready.length && <p className="recipe-hint">{learnable.length ? 'Agents can be taught after they finish a run with a step-by-step plan. ' : ''}
        Create an agent in <a className="inbox-text-link" href="#agents">Agents &amp; Activity</a>, for example “Put billing emails in a sheet with the amount and due date”, let it run once, then teach it here.</p>}
      {blocked.length > 0 && ready.length > 0 && <details><summary>{blocked.length} agent{blocked.length > 1 ? 's' : ''} can&apos;t be taught yet</summary>
        <ul className="recipe-blocked">{blocked.map((entry) => <li key={entry.agent_id}><strong>{entry.name}</strong> — {entry.reason}</li>)}</ul></details>}
    </section>

    {notice && <div className="inbox-notice" role="status">{notice}</div>}

    {recipes === null ? <div className="inbox-empty">Loading recipes.</div> : !recipes.length ? null :
      <div className="recipe-layout">
        <nav className="recipe-list" aria-label="Your recipes">{recipes.map((recipe) => {
          const [label, tone] = statusView[recipe.status];
          return <button type="button" key={recipe.id} className="recipe-card" aria-current={recipe.id === selected ? 'true' : undefined}
            data-testid="recipe-card" onClick={() => setSelected(recipe.id)}>
            <span className="recipe-card-head"><strong>{recipe.name}</strong><Tag tone={tone}>{label}</Tag></span>
            <span>{recipe.trigger.description}</span>
            <span className="recipe-card-meta">{recipe.stats.handled} handled · {recipe.stats.tokens} tokens
              {recipe.item_counts.awaiting_approval ? <Tag tone="amber">{recipe.item_counts.awaiting_approval} waiting</Tag> : null}
              {recipe.asks.length ? <Tag tone="red">{recipe.asks.length} question{recipe.asks.length > 1 ? 's' : ''}</Tag> : null}</span>
          </button>;
        })}</nav>
        <section className="inbox-panel">
          {current ? <RecipeDetail recipe={current.recipe} items={current.items} runs={current.runs} busy={busy} act={act} onTrace={onTrace} />
            : <div className="inbox-empty">Loading recipe.</div>}
        </section>
      </div>}
  </div>;
}
