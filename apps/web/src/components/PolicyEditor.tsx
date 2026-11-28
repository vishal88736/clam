'use client';

import { Gauge, Plus, RotateCcw, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { InboxPolicy } from '@siftvane/shared';

type ListKey = 'allowlist' | 'blocklist' | 'contacts' | 'vips';
type NumberKey = 'confidenceThreshold' | 'outboundBudget' | 'calendarBudget' | 'toolBudget';

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const lists: Array<{ key: ListKey; title: string; help: string; placeholder: string }> = [
  { key: 'allowlist', title: 'Trusted senders', help: 'Agents may reply to these people without asking you first.', placeholder: 'name@company.com' },
  { key: 'vips', title: 'VIPs', help: 'Mail from these people is always flagged as a priority.', placeholder: 'boss@company.com' },
  { key: 'contacts', title: 'Known contacts', help: 'People you know. Mail from strangers is treated with more care.', placeholder: 'friend@example.com' },
  { key: 'blocklist', title: 'Blocked senders', help: 'Agents never act on mail from these addresses.', placeholder: 'spam@example.com' },
];

const names: Record<keyof InboxPolicy, string> = {
  allowlist: 'Trusted senders', vips: 'VIPs', contacts: 'Known contacts', blocklist: 'Blocked senders',
  confidenceThreshold: 'Confidence needed to act', outboundBudget: 'Emails sent per run', calendarBudget: 'Calendar changes per run',
  toolBudget: 'Tool calls per run',
};

const show = (key: keyof InboxPolicy, value: unknown) => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (key === 'confidenceThreshold') return Math.round(Number(value) * 100) + '%';
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
    if (!email.test(item)) { setError('Enter a full email address.'); return; }
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

/** Form-based policy editor: every setting in plain words, with what changed against the installed version. */
export function PolicyEditor({ current, draft, onChange }: { current: InboxPolicy; draft: InboxPolicy; onChange: (next: InboxPolicy) => void }) {
  const set = <K extends keyof InboxPolicy>(key: K, value: InboxPolicy[K]) => onChange({ ...draft, [key]: value });
  const num = (key: NumberKey) => ({ value: draft[key], original: current[key], onChange: (next: number) => set(key, next) });
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
    <div className="policy-summary" aria-live="polite">
      {changes.length ? <>
        <div className="policy-field-head"><strong>{changes.length} change{changes.length === 1 ? '' : 's'} in this draft</strong>
          <button type="button" className="inbox-text-link" onClick={() => onChange(current)}><RotateCcw size={13} /> Undo all</button></div>
        <ul>{changes.map((change) => <li key={change.key}><strong>{names[change.key]}:</strong> {change.text}</li>)}</ul>
      </> : <p>No changes yet. Edit any setting above, then save it as a new version.</p>}
    </div>
  </div>;
}
