'use client';

import { CalendarDays, Check, FileSpreadsheet, FileText, FolderOpen, Image as ImageIcon, Mail, Plug, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { authRequest, type ConnectedInbox, type OperatorSession } from './GoogleSession';
import { Section } from './Section';

const google = 'https://www.googleapis.com/auth/';
/** What each Google service needs; any one listed scope counts as connected. */
const services: Array<{ name: string; icon: ReactNode; scopes: string[]; readOnly?: string[] }> = [
  { name: 'Gmail', icon: <Mail size={16} />, scopes: [google + 'gmail.modify'], readOnly: [google + 'gmail.readonly'] },
  { name: 'Calendar', icon: <CalendarDays size={16} />, scopes: [google + 'calendar.events'], readOnly: [google + 'calendar.events.readonly'] },
  { name: 'Drive', icon: <FolderOpen size={16} />, scopes: [google + 'drive.readonly', google + 'drive.file'] },
  { name: 'Docs', icon: <FileText size={16} />, scopes: [google + 'documents'] },
  { name: 'Sheets', icon: <FileSpreadsheet size={16} />, scopes: [google + 'spreadsheets'] },
  { name: 'Photos', icon: <ImageIcon size={16} />, scopes: [google + 'photospicker.mediaitems.readonly'] },
];

const access = (inbox?: ConnectedInbox) => services.map((service) => ({
  ...service,
  state: !inbox ? 'none' as const : service.scopes.some((scope) => inbox.scopes.includes(scope)) ? 'full' as const
    : service.readOnly?.some((scope) => inbox.scopes.includes(scope)) ? 'read' as const : 'none' as const,
}));

function ServiceGrid({ inbox }: { inbox?: ConnectedInbox }) {
  return <ul className="service-grid" aria-label="Google services">
    {access(inbox).map((item) => <li key={item.name} data-state={item.state}>
      <span className="service-icon">{item.icon}</span>
      <span className="service-name">{item.name}</span>
      <span className="service-state">{item.state === 'full' ? <><Check size={13} /> On</> : item.state === 'read' ? 'Read only' : <><X size={13} /> Off</>}</span>
    </li>)}
  </ul>;
}

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
  if (!session) return <Section icon={<Plug size={18} />} title="Google account" intro="Checking your connection…" />;
  if (!session.google_enabled || !session.live_enabled) return <Section icon={<Plug size={18} />} title="Google account"
    intro="Google sign-in isn’t set up on this server, so agents work in the practice mailbox.">
    <p className="block-note">To connect real Gmail, add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> and restart Siftvane.</p>
  </Section>;
  const inbox = session.inboxes.find((item) => item.id === session.active_inbox_id) ?? session.inboxes[0];
  if (!session.user || !inbox) return <Section icon={<Plug size={18} />} title="Connect your Google account"
    intro="One sign-in gives agents Gmail, Calendar, Drive, Docs, Sheets and Photos. Anything they send waits for your approval.">
    <ServiceGrid />
    <div className="block-foot"><a className="inbox-button" data-tone="primary" href="/api/auth/google/start"><Plug size={16} /> Connect Google</a></div>
  </Section>;
  const missing = access(inbox).some((item) => item.state !== 'full');
  return <Section icon={session.user.picture ? <img src={session.user.picture} alt="" width={40} height={40} referrerPolicy="no-referrer" /> : <Plug size={18} />}
    title={inbox.email}
    intro={inbox.status !== 'active' ? 'Google needs you to sign in again.' : missing ? 'Connected. Some services still need permission.' : 'Connected to all your Google services.'}
    actions={<button type="button" className="inbox-button" disabled={busy} onClick={() => void change('logout', {}).then(() => window.location.assign('/'))}>Sign out</button>}>
    <ServiceGrid inbox={inbox} />
    <div className="block-foot">
      <label className="inline-field">Agents work in
        <select value={session.active_inbox_id} disabled={busy} onChange={(event) => void change('inbox', { inbox_id: event.target.value })}>
          {session.inboxes.map((item) => <option value={item.id} key={item.id}>{item.email}</option>)}
          <option value="sandbox">Practice mailbox</option>
        </select>
      </label>
      {(inbox.status !== 'active' || missing) && <a className="inbox-button" data-tone="primary" href="/api/auth/google/start">
        {inbox.status !== 'active' ? 'Reconnect Google' : 'Allow the rest'}</a>}
    </div>
    {error && <p className="inbox-error" role="alert">{error}</p>}
  </Section>;
}
