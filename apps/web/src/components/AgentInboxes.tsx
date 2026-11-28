'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const metrics = [
  ['Two-way conversations', ['threads', 'active threads'], ['verified_replies', 'verified replies']],
  ['Send email at scale', ['batch_sends', 'batches with verified sends'], ['pending_batch_approvals', 'batch approvals pending']],
  ['Process incoming email', ['parsed_attachments', 'parsed attachments'], ['quarantined_threats', 'quarantined threats']],
  ['Coordinate schedules', ['verified_calendar_mutations', 'verified changes'], ['calendar_rollbacks', 'rollbacks']],
  ['Use services independently', ['service_verifications', 'scoped retrievals']],
  ['Work with other agents', ['signed_handoffs', 'signed handoffs'], ['prevented_loops', 'prevented loops']],
] as const;
const allScopes = ['handoff:read', 'handoff:send', 'attachment:extract'];
type PodInbox = { id: string; email: string; role: string };

async function request<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/inbox/' + endpoint, {
    cache: 'no-store', ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'REQUEST_FAILED');
  return value as T;
}

export function AgentInboxes() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [members, setMembers] = useState<PodInbox[]>([]);
  const [selected, setSelected] = useState('triage');
  const [scopes, setScopes] = useState(['handoff:read']);
  const [token, setToken] = useState<{ token: string; expires_at: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current;
    try {
      const [inboxes, totals] = await Promise.all([
        request<{ inboxes: PodInbox[] }>('agent-inboxes'), request<Record<string, number>>('capabilities'),
      ]);
      if (requestId !== refreshSequence.current) return;
      setMembers(inboxes.inboxes);
      setCounts(totals);
    } catch { setError('Agent inbox activity could not be loaded.'); }
  }, []);
  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/inbox/events');
    stream.addEventListener('step', (event) => {
      if ((JSON.parse(event.data) as { stage?: string }).stage === 'REPORT') void refresh();
    });
    stream.addEventListener('state', () => void refresh());
    return () => stream.close();
  }, [refresh]);

  async function apply(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/_/g, ' ').toLowerCase() : 'Request failed.'); }
    finally { setBusy(false); }
  }

  return <section className="inbox-panel" aria-label="Agent inboxes and MCP access">
    <h2>Agent inboxes &amp; MCP access</h2>
    <ol className="capability-strip" aria-label="Agent capabilities">
      {metrics.map(([title, ...items], index) => <li key={title}>
        <span className="capability-number">{String(index + 1).padStart(2, '0')}</span>
        <strong>{title}</strong>
        <small>{items.map(([key, text]) => (counts?.[key] ?? '—') + ' ' + text).join(' · ')}</small>
      </li>)}
    </ol>
    <form className="inbox-form-row" onSubmit={(event) => {
      event.preventDefault();
      void apply(async () => setToken(await request('agent-inboxes/' + selected + '/token', { scopes })));
    }}>
      <label>Pod inbox <select value={selected} onChange={(event) => { setSelected(event.target.value); setToken(null); }}>
        {members.map((member) => <option value={member.id} key={member.id}>{member.email}</option>)}
      </select></label>
      {allScopes.map((scope) => <label key={scope}>
        <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) =>
          setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))} /> {scope}
      </label>)}
      <button type="submit" className="inbox-button" disabled={busy || !members.length || !scopes.length}>Mint Pod token</button>
    </form>
    {token && <div className="inbox-item">
      <label>Pod MCP token<input readOnly value={token.token} aria-label="Pod MCP token" /></label>
      <small>Expires {new Date(token.expires_at).toLocaleString()}</small>
      <button type="button" className="inbox-button" onClick={() => void navigator.clipboard.writeText(token.token)
        .catch(() => setError('Select and copy the displayed token.'))}>Copy Pod token</button>
    </div>}
    <p>Each agent inbox receives its own case mail. Agents hand work to each other with signed handoffs; every hop is replayed under <a className="inbox-text-link" href="/#monitor">Runs &amp; traces</a>.</p>
    {error && <p className="inbox-error" role="alert">{error}</p>}
  </section>;
}
