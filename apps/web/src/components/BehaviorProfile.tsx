'use client';

import { Download, PenLine, RefreshCw, UserRound } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';

type Behavior = { inbox_id: string; markdown: string; built_by: 'ai' | 'stats' | 'user' | null; source_count: number;
  built_at: string | null; updated_at: string | null; building: boolean };

const call = async (method: string, path = '', body?: unknown) => {
  const response = await fetch('/api/inbox/platform/behavior' + path, {
    method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error === 'SIGN_IN_REQUIRED' ? 'Sign in with Google first.' : 'The request failed.');
  return data as Behavior;
};

/** **bold** and _italic_ inside a line, rendered as elements (never as HTML). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') && part.length > 4
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith('_') && part.endsWith('_') && part.length > 2
      ? <em key={index}>{part.slice(1, -1)}</em> : <Fragment key={index}>{part}</Fragment>);
}

/** A small, safe Markdown view: headings, bullet lists, quotes and paragraphs. */
export function MarkdownView({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push(heading[1].length === 1 ? <h3 key={index}>{inline(heading[2])}</h3> : <h4 key={index}>{inline(heading[2])}</h4>); index++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={index}>{items.map((item, at) => <li key={at}>{inline(item)}</li>)}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('>')) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={index}>{quote.map((item, at) => <Fragment key={at}>{inline(item)}{at < quote.length - 1 && <br />}</Fragment>)}</blockquote>);
      continue;
    }
    if (line.trim()) blocks.push(<p key={index}>{inline(line)}</p>);
    index++;
  }
  return <div className="markdown-view">{blocks}</div>;
}

const when = (value: string | null) => value ? new Date(value).toLocaleString() : '';

/** behavior.md: learned from the user's own replies, shown readably, and theirs to edit. Agents follow it. */
export function BehaviorProfile() {
  const [profile, setProfile] = useState<Behavior | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const load = useCallback(async () => {
    try {
      const loaded = await call('GET');
      setProfile(loaded);
      setDraft((current) => editing ? current : loaded.markdown);
    } catch (failure) { setStatus(failure instanceof Error ? failure.message : 'Could not load your behavior file.'); }
  }, [editing]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!profile?.building) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [profile?.building, load]);

  const save = async () => {
    try { const saved = await call('PUT', '', { markdown: draft }); setProfile(saved); setDraft(saved.markdown); setEditing(false); setStatus('Saved. Agents use it from their next reply.'); }
    catch (failure) { setStatus(failure instanceof Error ? failure.message : 'Saving failed.'); }
  };
  const rebuild = async () => {
    if (profile?.built_by === 'user' && !window.confirm('Rebuilding replaces your edits with a fresh file learned from your sent mail. Continue?')) return;
    try { setProfile(await call('POST', '/rebuild')); setEditing(false); setStatus(''); }
    catch (failure) { setStatus(failure instanceof Error ? failure.message : 'Could not start the rebuild.'); }
  };
  const download = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([draft], { type: 'text/markdown' }));
    link.download = 'behavior.md';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const origin = profile?.built_by === 'ai' ? `Written by the AI from ${profile.source_count} of your replies`
    : profile?.built_by === 'stats' ? `Counted from ${profile.source_count} of your replies (pick an AI provider below for a richer file)`
      : profile?.built_by === 'user' ? 'Edited by you' : '';

  return <section className="inbox-panel behavior-profile">
    <div className="inbox-panel-head"><h2><UserRound size={19} /> How I handle my email <code>behavior.md</code></h2>
      <div className="inbox-actions">
        {!editing && <button type="button" className="inbox-button" disabled={!profile || profile.building} onClick={() => setEditing(true)}><PenLine size={15} /> Edit</button>}
        <button type="button" className="inbox-button" disabled={!profile || profile.building} onClick={() => void rebuild()}>
          <RefreshCw size={15} /> {profile?.building ? 'Reading your mail…' : 'Rebuild from my sent mail'}</button>
        <button type="button" className="inbox-button" disabled={!draft} onClick={download} aria-label="Download behavior.md"><Download size={15} /></button>
      </div></div>
    <p>Siftvane reads the emails you replied to and writes down which mail you answer and how you write. Agents follow this file when they decide
      what to reply to and how to word it. Change anything you like.</p>
    {!profile ? <p>Loading…</p> : profile.building && !profile.markdown ? <p className="behavior-building">Reading the emails you’ve replied to and writing your file. This takes under a minute.</p> :
      editing ? <>
        <textarea className="behavior-editor" value={draft} rows={18} maxLength={12000} aria-label="behavior.md"
          onChange={(event) => { setDraft(event.target.value); setStatus(''); }} />
        <div className="business-profile-actions">
          <small>{draft.length}/12000 · Markdown: # headings, - bullets, &gt; quotes</small>
          <span className="inbox-actions">
            <button type="button" className="inbox-button" onClick={() => { setDraft(profile.markdown); setEditing(false); }}>Cancel</button>
            <button type="button" className="inbox-button" data-tone="primary" disabled={draft.trim() === profile.markdown} onClick={() => void save()}>Save</button>
          </span>
        </div>
      </> : profile.markdown ? <MarkdownView text={profile.markdown} /> : <p>No file yet.</p>}
    {profile?.updated_at && !editing && <small className="behavior-origin">{origin}{origin && ' · '}{when(profile.updated_at)}</small>}
    {status && <p role="status">{status}</p>}
  </section>;
}
