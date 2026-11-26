'use client';

import Link from 'next/link';
import { ArrowLeft, Plug, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AgentInboxes } from '../../components/AgentInboxes';
import { InboxTokenList } from '../../components/InboxTokenList';
import { actionsGranted, authRequest, connectionStatus, GoogleAccountBar, useGoogleSession } from '../../components/GoogleSession';

const choices = [
  ['mail:read', 'Read mail and threads'], ['attachment:extract', 'Extract attachment text'],
  ['mail:draft', 'Request drafts'], ['mail:send', 'Request or send policy-allowed mail'],
  ['calendar:propose', 'Read or propose calendar changes'],
  ['agent:manage', 'Create, switch, and inspect persistent agents'], ['workspace:write', 'Write Drive folders/files, Docs, and Sheets'],
  ['photos:read', 'Search and extract receipt photos (read-only)'],
] as const;

function SetupCommands() {
  const [copyError, setCopyError] = useState('');
  const apiOrigin = 'http://localhost:4000';
  const endpoint = apiOrigin + '/mcp';
  const settings = (type?: string) => JSON.stringify({ mcpServers: { 'clam-mail': {
    ...(type ? { type } : {}), url: endpoint,
    headers: { Authorization: 'Bearer REPLACE_WITH_MCP_TOKEN' },
  } } }, null, 2);
  const commands = [
    ['Claude Code', `claude mcp add --transport http clam-mail ${endpoint} --header "Authorization: Bearer $CLAM_MCP_TOKEN"`],
    ['Claude Code (stdio)', `claude mcp add --env CLAM_API_URL=${apiOrigin} --env CLAM_MCP_TOKEN="$CLAM_MCP_TOKEN" --transport stdio clam-mail -- pnpm --silent clam-mcp`],
    ['Codex', `[mcp_servers.clam-mail]\nurl = "${endpoint}"\nbearer_token_env_var = "CLAM_MCP_TOKEN"`],
    ['Codex (stdio)', `[mcp_servers.clam-mail]\ncommand = "pnpm"\nargs = ["--silent", "clam-mcp"]\nenv_vars = ["CLAM_MCP_TOKEN"]\nstartup_timeout_sec = 30\n\n[mcp_servers.clam-mail.env]\nCLAM_API_URL = "${apiOrigin}"`],
    ['Cline MCP settings', settings('streamableHttp')],
    ['Cursor MCP settings', settings()],
  ];
  return <div>
    <p>Export your scoped <code>CLAM_MCP_TOKEN</code> before running either client. Use one transport per client. For stdio, start from the Clam repo with <code>pnpm</code> on your PATH.</p>
    {commands.map(([name, value]) => <details key={name} className="inbox-item">
      <summary>{name}</summary>
      <pre>{value}</pre>
      <button type="button" className="inbox-button" onClick={() => void navigator.clipboard.writeText(value)
        .then(() => setCopyError('')).catch(() => setCopyError('Select and copy the command from the screen.'))}>Copy</button>
    </details>)}
    {copyError && <p role="status">{copyError}</p>}
  </div>;
}

export default function SettingsPage() {
  const { session, refresh, accountError } = useGoogleSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState<{ token: string; expires_at: string } | null>(null);
  const [newTokenFor, setNewTokenFor] = useState('');
  const [scopes, setScopes] = useState<string[]>(['mail:read']);
  const [domain, setDomain] = useState('');
  const [tokenRevision, setTokenRevision] = useState(0);
  async function update(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to update the account.'); }
    finally { setBusy(false); }
  }
  return <main className="inbox-main max-w-3xl">
    <Link className="inbox-text-link" href="/#briefing"><ArrowLeft size={16} /> Inbox Briefing</Link>
    <header className="inbox-title"><h1>Connections</h1><p>Manage Google accounts and scoped MCP access.</p></header>
    <GoogleAccountBar session={session} />
    {(error || accountError) && <p className="inbox-error" role="alert">{error || accountError}</p>}
    <section className="inbox-panel">
      <h2><Plug size={19} /> Google accounts</h2>
      {!session ? <p>Loading connections.</p> : !session.user ?
        <p>No Google account connected. {session.google_enabled ? 'Sign in to link one.' : <>Local Sandbox Mode works without credentials. To connect Gmail, configure <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> using the repository README.</>}</p> : <>
          {session.live_enabled && <div className="inbox-actions">
            <a className="inbox-button" data-tone="primary" href="/api/auth/google/connect?mode=readonly">Connect Gmail (Read-Only)</a>
            <a className="inbox-button" href="/api/auth/google/login?link=true">Link another Google account</a>
          </div>}
          {!session.inboxes.length && <p>No Google account connected.</p>}
          {session.inboxes.map((account) => <article key={account.id} className="inbox-item">
            <strong>{account.email}</strong><p>{connectionStatus(account)}</p>
            <details><summary>Granted Google scopes</summary><ul>{account.scopes.map((item) => <li key={item}><code>{item}</code></li>)}</ul></details>
            <div className="inbox-actions">
              {account.status === 'reauth_required' && <a className="inbox-button" href={'/api/auth/google/connect?mode=' +
                (actionsGranted(account) ? 'readwrite' : 'readonly') + '&inboxId=' + account.id}>Reconnect</a>}
              {!actionsGranted(account) && <a className="inbox-button" href={'/api/auth/google/connect?mode=readwrite&inboxId=' +
                account.id}>Upgrade to Read+Write</a>}
              {!account.scopes.includes('https://www.googleapis.com/auth/drive.file') && <a className="inbox-button" href={'/api/auth/google/connect?mode=workspace&inboxId=' +
                account.id} title="Requests drive.file and photoslibrary.readonly only. Full Drive access is never requested.">Add Drive, Docs, Sheets &amp; Photos (least privilege)</a>}
              {account.scopes.includes('https://www.googleapis.com/auth/drive.file') && !account.scopes.includes('https://www.googleapis.com/auth/spreadsheets') &&
                <a className="inbox-button" href={'/api/auth/google/connect?mode=workspace_edit&inboxId=' + account.id}
                  title="Adds documents and spreadsheets scopes so agents can edit existing files you choose.">Allow editing existing Docs &amp; Sheets</a>}
              <button className="inbox-button" type="button" disabled={busy} onClick={() => {
                if (window.confirm('Disconnect ' + account.email + ' and revoke its Google and MCP access?')) void update(async () => {
                  const result = await authRequest<{ remote_revoked: boolean }>('google/disconnect/' + account.id, { revoke_mcp: true });
                  setToken(null);
                  setNewTokenFor('');
                  await refresh();
                  if (!result.remote_revoked) setError('Clam removed local access. Google did not confirm remote revocation.');
                });
              }}>Disconnect &amp; Revoke Token</button>
              <button className="inbox-button" type="button" disabled={busy || account.status !== 'active'}
                onClick={() => { setToken(null); setNewTokenFor(account.id); }}>Create scoped MCP token</button>
            </div>
            {newTokenFor === account.id && <form className="inbox-form-row" onSubmit={(event) => {
              event.preventDefault();
              void update(async () => {
                setToken(await authRequest('google/token/' + account.id, {
                  scopes: [...scopes, ...(domain.trim() ? ['otp:read:' + domain.trim().toLowerCase()] : [])],
                }));
                setTokenRevision((value) => value + 1);
              });
            }}>
              {choices.map(([value, label]) => <label key={value}><input type="checkbox" checked={scopes.includes(value)}
                onChange={(event) => setScopes(event.target.checked ? [...scopes, value] : scopes.filter((item) => item !== value))} /> {label}</label>)}
              <label>Optional verification sender domain<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="github.com" /></label>
              <button className="inbox-button" data-tone="primary" disabled={busy || (!scopes.length && !domain.trim())}>Mint MCP token</button>
            </form>}
            <InboxTokenList inboxId={account.id} revision={tokenRevision} onRevoke={() => setToken(null)} />
          </article>)}
        </>}
    </section>
    <AgentInboxes sandboxSelected={!session || session.active_inbox_id === 'sandbox'} />
    {session && (!session.live_enabled || session.user) && <section className="inbox-panel">
      <h2>Sandbox mailbox tokens</h2>
      <InboxTokenList inboxId="sandbox" revision={0} canMint />
    </section>}
    <section className="inbox-panel">
      <h2><ShieldCheck size={19} /> MCP setup</h2>
      {token && <div className="inbox-item">
        <label>Scoped MCP token (shown once)<input readOnly value={token.token} aria-label="Scoped MCP token" /></label>
        <p>Expires {new Date(token.expires_at).toLocaleString()}</p>
        <button type="button" className="inbox-button" onClick={() => void navigator.clipboard.writeText(token.token)
          .catch(() => setError('Select and copy the token from the screen.'))}>Copy token</button>
      </div>}
      <SetupCommands />
    </section>
  </main>;
}
