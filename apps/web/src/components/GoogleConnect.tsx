'use client';

import { Check, Plug, X } from 'lucide-react';
import { useState } from 'react';
import { authRequest, type ConnectedInbox, type OperatorSession } from './GoogleSession';

const google = 'https://www.googleapis.com/auth/';
/** What each Google service needs; any one listed scope counts as connected. */
const services: Array<{ name: string; scopes: string[]; readOnly?: string[] }> = [
  { name: 'Gmail', scopes: [google + 'gmail.modify'], readOnly: [google + 'gmail.readonly'] },
  { name: 'Calendar', scopes: [google + 'calendar.events'], readOnly: [google + 'calendar.events.readonly'] },
  { name: 'Drive', scopes: [google + 'drive.readonly', google + 'drive.file'] },
  { name: 'Docs', scopes: [google + 'documents'] },
  { name: 'Sheets', scopes: [google + 'spreadsheets'] },
  { name: 'Photos', scopes: [google + 'photospicker.mediaitems.readonly'] },
];

export const serviceAccess = (inbox: ConnectedInbox) => services.map((service) => ({
  name: service.name,
  state: service.scopes.some((scope) => inbox.scopes.includes(scope)) ? 'full' as const
    : service.readOnly?.some((scope) => inbox.scopes.includes(scope)) ? 'read' as const : 'none' as const,
}));

/** One card, one button: sign in with Google and connect every Google service in a single consent. */
export function GoogleConnect({ session, refresh }: { session: OperatorSession | null; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (endpoint: string, body: unknown) => {
    setBusy(true);
    setError('');
    try { await authRequest(endpoint, body); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The account request failed.'); }
    finally { setBusy(false); }
  };
  if (!session) return <section className="inbox-panel connect-card"><p>Loading your Google connection…</p></section>;
  if (!session.google_enabled || !session.live_enabled) return <section className="inbox-panel connect-card">
    <h2><Plug size={19} /> Google account</h2>
    <p>Google sign-in isn’t set up on this server yet, so Siftvane is using the practice mailbox. To connect your real Gmail, add
      <code> GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (see the README) and restart.</p>
  </section>;
  const inbox = session.inboxes.find((item) => item.id === session.active_inbox_id) ?? session.inboxes[0];
  if (!session.user || !inbox) return <section className="inbox-panel connect-card">
    <h2><Plug size={19} /> Connect your Google account</h2>
    <p>One step: sign in and allow Gmail, Calendar, Drive, Docs, Sheets and Photos. Agents read what they need; anything that sends
      mail or changes your files is checked against your rules, and replies wait for your approval.</p>
    <a className="inbox-button connect-google" data-tone="primary" href="/api/auth/google/start">Connect Google</a>
  </section>;
  const access = serviceAccess(inbox);
  const missing = access.some((item) => item.state !== 'full');
  return <section className="inbox-panel connect-card">
    <div className="connect-head">
      {session.user.picture ? <img src={session.user.picture} alt="" width={40} height={40} referrerPolicy="no-referrer" />
        : <span className="connect-avatar" aria-hidden="true">{(session.user.name || inbox.email).charAt(0).toUpperCase()}</span>}
      <div><h2>{inbox.email}</h2>
        <p>{inbox.status !== 'active' ? 'Google needs you to sign in again.' : missing ? 'Connected. Some services still need permission.' : 'Connected to all Google services.'}</p></div>
    </div>
    <ul className="connect-services" aria-label="Google services">
      {access.map((item) => <li key={item.name} data-state={item.state}>
        {item.state === 'none' ? <X size={14} /> : <Check size={14} />}{item.name}{item.state === 'read' && <small> (read only)</small>}
      </li>)}
    </ul>
    <div className="inbox-actions">
      {(inbox.status !== 'active' || missing) && <a className="inbox-button" data-tone="primary" href="/api/auth/google/start">
        {inbox.status !== 'active' ? 'Reconnect Google' : 'Allow the rest'}</a>}
      <label className="connect-mailbox">Agents work in
        <select value={session.active_inbox_id} disabled={busy} onChange={(event) => void change('inbox', { inbox_id: event.target.value })}>
          {session.inboxes.map((item) => <option value={item.id} key={item.id}>{item.email}</option>)}
          <option value="sandbox">Practice mailbox (sandbox)</option>
        </select>
      </label>
      <button type="button" className="inbox-button" disabled={busy} onClick={() => void change('logout', {}).then(() => window.location.assign('/'))}>Sign out</button>
    </div>
    {error && <p className="inbox-error" role="alert">{error}</p>}
  </section>;
}
