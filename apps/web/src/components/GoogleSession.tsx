'use client';

import { useCallback, useEffect, useState } from 'react';

export type ConnectedInbox = {
  id: string;
  email: string;
  adapter_type: 'gmail_oauth';
  status: 'active' | 'reauth_required' | 'revoked';
  scopes: string[];
};

export type OperatorSession = {
  google_enabled: boolean;
  live_enabled: boolean;
  user: { id: string; email: string; name: string; picture: string | null } | null;
  active_inbox_id: string;
  inboxes: ConnectedInbox[];
};

export const actionsGranted = (inbox: ConnectedInbox) =>
  inbox.scopes.includes('https://www.googleapis.com/auth/gmail.modify') &&
  inbox.scopes.includes('https://www.googleapis.com/auth/calendar.events');

export const connectionStatus = (inbox: ConnectedInbox) => inbox.status !== 'active' ? 'Re-auth Required' :
  actionsGranted(inbox) ? 'Connected (Read + Actions)' :
    inbox.scopes.some((scope) => [ 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events' ].includes(scope))
      ? 'Connected (Limited Actions)' : 'Connected (Read-Only)';

const errors: Record<string, string> = {
  SCOPE_UPGRADE_REQUIRED: 'Upgrade access for this inbox in Connections.',
  GOOGLE_REAUTH_REQUIRED: 'Reconnect the Google account in Connections.',
  INBOX_NOT_AVAILABLE: 'That inbox is unavailable. Choose another inbox.',
  OPERATOR_SESSION_REQUIRED: 'Sign in with Google to continue.',
  GOOGLE_AUTH_NOT_CONFIGURED: 'Google Sign-In is disabled in this installation.',
};

export async function authRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  const result = await fetch('/api/auth/' + endpoint, {
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(errors[data.error] ?? 'The account request failed.');
  return data as T;
}

export function useGoogleSession() {
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [accountError, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setSession(await authRequest<OperatorSession>('session'));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not load the account.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { session, refresh, accountError };
}

export function GoogleAccountBar({ session }: { session: OperatorSession | null }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = session?.inboxes.find((item) => item.id === session.active_inbox_id);
  async function change(endpoint: string, body: unknown, redirect?: string) {
    setBusy(true);
    setError('');
    try {
      await authRequest(endpoint, body);
      if (redirect) window.location.assign(redirect);
      else window.location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account request failed.');
      setBusy(false);
    }
  }
  if (!session) return null;
  if (!session.user) return session.google_enabled ? <div className="inbox-accountbar">
    <a className="inbox-button" href="/api/auth/google/login">Sign in with Google</a>
    <a className="inbox-text-link" href="/#briefing">Continue in Local Sandbox Mode</a>
  </div> : null;

  return <div className="inbox-accountbar">
    <div className="inbox-account-identity">
      {session.user.picture ? <img src={session.user.picture} alt="" width={28} height={28} referrerPolicy="no-referrer" /> :
        <span aria-hidden="true">{(session.user.name || session.user.email).charAt(0).toUpperCase()}</span>}
      <strong>{session.user.email}</strong>
    </div>
    <label className="inbox-account-picker">Active inbox
      <select value={session.active_inbox_id} disabled={busy} onChange={(event) => void change('inbox', { inbox_id: event.target.value })}>
        <option value="sandbox">Sandbox (@clam.local)</option>
        {session.inboxes.map((item) => <option value={item.id} key={item.id}>{item.email}</option>)}
      </select>
    </label>
    <button className="inbox-button" type="button" disabled={busy} onClick={() => void change('logout', {}, '/#briefing')}>Sign out</button>
    {active && <p className="inbox-live-banner">
      <strong>Live Gmail · {active.email}</strong> · {connectionStatus(active)}
      {active.status !== 'active' ? <> · <a href="/settings">Reconnect this account</a></> : null}
    </p>}
    {error && <p className="inbox-error" role="alert">{error}</p>}
  </div>;
}
