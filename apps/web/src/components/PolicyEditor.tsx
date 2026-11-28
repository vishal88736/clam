'use client';

import { Gauge, Plus, RotateCcw, Users, Clock3, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { InboxPolicy } from '@siftvane/shared';

type ListKey = 'allowlist' | 'blocklist' | 'contacts' | 'vips' | 'trustedAirlines';
type NumberKey = 'confidenceThreshold' | 'outboundBudget' | 'calendarBudget' | 'toolBudget' | 'workStart' | 'workEnd' | 'maxMeetingMinutes';

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domain = /^[a-z\d.-]+\.[a-z]+$/i;

const lists: Array<{ key: ListKey; title: string; help: string; placeholder: string; kind: 'email' | 'domain' }> = [
  { key: 'allowlist', title: 'Trusted senders', help: 'Agents may reply to these people without asking you first.', placeholder: 'name@company.com', kind: 'email' },
  { key: 'vips', title: 'VIPs', help: 'Mail from these people is always flagged as a priority.', placeholder: 'boss@company.com', kind: 'email' },
  { key: 'contacts', title: 'Known contacts', help: 'People you know. Mail from strangers is treated with more care.', placeholder: 'friend@example.com', kind: 'email' },
  { key: 'blocklist', title: 'Blocked senders', help: 'Agents never act on mail from these addresses.', placeholder: 'spam@example.com', kind: 'email' },
  { key: 'trustedAirlines', title: 'Trusted airline domains', help: 'Flight emails from these domains can update your calendar.', placeholder: 'airline.com', kind: 'domain' },
];

const names: Record<keyof InboxPolicy, string> = {
  allowlist: 'Trusted senders', vips: 'VIPs', contacts: 'Known contacts', blocklist: 'Blocked senders', trustedAirlines: 'Trusted airline domains',
  confidenceThreshold: 'Confidence needed to act', outboundBudget: 'Emails sent per run', calendarBudget: 'Calendar changes per run',
  toolBudget: 'Tool calls per run', timeZone: 'Time zone', workStart: 'Workday starts', workEnd: 'Workday ends', maxMeetingMinutes: 'Longest meeting',
};

const hour = (value: number) => value === 24 ? 'Midnight' : new Date(2000, 0, 1, value).toLocaleTimeString([], { hour: 'numeric' });
const show = (key: keyof InboxPolicy, value: unknown) => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (key === 'confidenceThreshold') return Math.round(Number(value) * 100) + '%';
  if (key === 'workStart' || key === 'workEnd') return hour(Number(value));
  if (key === 'maxMeetingMinutes') return value + ' min';
  return String(value);
};

/** Readable policy changes between the installed version and the draft. */
export function policyChanges(current: InboxPolicy, draft: InboxPolicy) {
  return (Object.keys(names) as Array<keyof InboxPolicy>).flatMap((key) => {
    const before = current[key];
    const after = draft[key];
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (Array.isArray(before) && Array.isArray(after)) {
      const added = after.filter((item) => !before.includes(item));
      const removed = before.filter((item) => !after.includes(item));
      return [{ key, text: [added.length ? 'added ' + added.join(', ') : '', removed.length ? 'removed ' + removed.join(', ') : ''].filter(Boolean).join('; ') }];
    }
    return [{ key, text: show(key, before) + ' → ' + show(key, after) }];
  });
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="policy-section"><h3>{icon} {title}</h3>{children}</section>;
}

function ListField({ spec, value, original, onChange }: {
  spec: typeof lists[number]; value: string[]; original: string[]; onChange: (next: string[]) => void;
}) {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const add = () => {
    const item = entry.trim().toLowerCase();
    if (!item) return;
    if (!(spec.kind === 'email' ? email : domain).test(item)) { setError(spec.kind === 'email' ? 'Enter a full email address.' : 'Enter a domain like airline.com.'); return; }
    if (value.includes(item)) { setError('Already on the list.'); return; }
    onChange([...value, item]);
    setEntry('');
    setError('');
  };
  const changed = JSON.stringify(value) !== JSON.stringify(original);
  return <div className="policy-field">
    <div className="policy-field-head"><strong>{spec.title}</strong>{changed && <span className="inbox-tag" data-tone="amber">changed</span>}<span className="policy-count">{value.length}</span></div>
    <p>{spec.help}</p>
    <ul className="policy-chips" aria-label={spec.title}>
      {value.map((item) => <li key={item} data-new={!original.includes(item)}>
        <span>{item}</span>
        <button type="button" aria-label={'Remove ' + item} onClick={() => onChange(value.filter((other) => other !== item))}><X size={12} /></button>
      </li>)}
      {!value.length && <li className="policy-empty">Nobody yet</li>}
    </ul>
    <form className="policy-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <input value={entry} placeholder={spec.placeholder} aria-label={'Add to ' + spec.title}
        onChange={(event) => { setEntry(event.target.value); setError(''); }} />
      <button type="submit" className="inbox-button" disabled={!entry.trim()}><Plus size={14} /> Add</button>
    </form>
    {error && <small className="inbox-error" role="alert">{error}</small>}
  </div>;
}

function NumberField({ label, help, value, original, min, max, unit, onChange }: {
  label: string; help: string; value: number; original: number; min: number; max: number; unit?: string; onChange: (next: number) => void;
}) {
  return <label className="policy-field">
    <div className="policy-field-head"><strong>{label}</strong>{value !== original && <span className="inbox-tag" data-tone="amber">was {original}</span>}</div>
    <p>{help}</p>
    <span className="policy-number">
      <input type="number" min={min} max={max} value={value}
        onChange={(event) => onChange(Math.min(max, Math.max(min, Math.round(Number(event.target.value) || min))))} />
      {unit && <span>{unit}</span>}
    </span>
  </label>;
}

function HourField({ label, value, original, from, to, onChange }: {
  label: string; value: number; original: number; from: number; to: number; onChange: (next: number) => void;
}) {
  return <label className="policy-field">
    <div className="policy-field-head"><strong>{label}</strong>{value !== original && <span className="inbox-tag" data-tone="amber">was {hour(original)}</span>}</div>
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {Array.from({ length: to - from + 1 }, (_, index) => from + index).map((item) => <option key={item} value={item}>{hour(item)}</option>)}
    </select>
  </label>;
}

/** Form-based policy editor: every setting in plain words, with what changed against the installed version. */
export function PolicyEditor({ current, draft, onChange }: { current: InboxPolicy; draft: InboxPolicy; onChange: (next: InboxPolicy) => void }) {
  const set = <K extends keyof InboxPolicy>(key: K, value: InboxPolicy[K]) => onChange({ ...draft, [key]: value });
  const num = (key: NumberKey) => ({ value: draft[key], original: current[key], onChange: (next: number) => set(key, next) });
  const zones = useMemo(() => {
    try { return (Intl as unknown as { supportedValuesOf?: (kind: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; }
    catch { return []; }
  }, []);
  const changes = policyChanges(current, draft);
  return <div className="policy-editor">
    <Section icon={<Users size={16} />} title="People">
      <div className="policy-grid">
        {lists.map((spec) => <ListField key={spec.key} spec={spec} value={draft[spec.key]} original={current[spec.key]} onChange={(next) => set(spec.key, next)} />)}
      </div>
    </Section>
    <Section icon={<Gauge size={16} />} title="Safety limits">
      <div className="policy-grid">
        <label className="policy-field">
          <div className="policy-field-head"><strong>Confidence needed to act</strong>
            {draft.confidenceThreshold !== current.confidenceThreshold && <span className="inbox-tag" data-tone="amber">was {Math.round(current.confidenceThreshold * 100)}%</span>}</div>
          <p>Below this, agents ask you instead of acting on their own.</p>
          <span className="policy-range">
            <input type="range" min={0.5} max={1} step={0.05} value={draft.confidenceThreshold}
              onChange={(event) => set('confidenceThreshold', Number(event.target.value))} />
            <output>{Math.round(draft.confidenceThreshold * 100)}%</output>
          </span>
        </label>
        <NumberField label="Emails sent per run" help="Most emails an agent may send in one run." min={0} max={3} unit="emails" {...num('outboundBudget')} />
        <NumberField label="Calendar changes per run" help="Most calendar events an agent may change in one run." min={0} max={6} unit="changes" {...num('calendarBudget')} />
        <NumberField label="Tool calls per run" help="A run stops after this many steps." min={1} max={200} unit="calls" {...num('toolBudget')} />
      </div>
    </Section>
    <Section icon={<Clock3 size={16} />} title="Working hours">
      <div className="policy-grid">
        <label className="policy-field">
          <div className="policy-field-head"><strong>Time zone</strong>{draft.timeZone !== current.timeZone && <span className="inbox-tag" data-tone="amber">was {current.timeZone}</span>}</div>
          {zones.length ? <select value={draft.timeZone} onChange={(event) => set('timeZone', event.target.value)}>
            {(zones.includes(draft.timeZone) ? zones : [draft.timeZone, ...zones]).map((zone) => <option key={zone}>{zone}</option>)}
          </select> : <input value={draft.timeZone} onChange={(event) => set('timeZone', event.target.value)} />}
        </label>
        <HourField label="Workday starts" from={0} to={23} {...num('workStart')} />
        <HourField label="Workday ends" from={1} to={24} {...num('workEnd')} />
        <NumberField label="Longest meeting" help="Agents won't book or accept anything longer." min={15} max={480} unit="minutes" {...num('maxMeetingMinutes')} />
      </div>
      {draft.workStart >= draft.workEnd && <p className="inbox-error" role="alert">The workday must start before it ends.</p>}
    </Section>
    <div className="policy-summary" aria-live="polite">
      {changes.length ? <>
        <div className="policy-field-head"><strong>{changes.length} change{changes.length === 1 ? '' : 's'} in this draft</strong>
          <button type="button" className="inbox-text-link" onClick={() => onChange(current)}><RotateCcw size={13} /> Undo all</button></div>
        <ul>{changes.map((change) => <li key={change.key}><strong>{names[change.key]}:</strong> {change.text}</li>)}</ul>
      </> : <p>No changes yet. Edit any setting above, then preview how it would treat your mail.</p>}
    </div>
  </div>;
}
