'use client';

import { useCallback, useEffect, useState } from 'react';

type TokenInfo = { token_id: string; scopes: string[]; expires_at: string };
type IssuedToken = { token: string; token_id: string };

async function read<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/inbox/mcp-tokens' + path, {
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('The token request failed.');
  return response.json() as Promise<T>;
}

export function InboxTokenList({ inboxId, revision, canMint, onRevoke }: {
  inboxId: string; revision: number; canMint?: boolean; onRevoke?: () => void;
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () =>
    setTokens((await read<{ tokens: TokenInfo[] }>('?inbox_id=' + encodeURIComponent(inboxId))).tokens), [inboxId]);
  useEffect(() => {
    void reload().catch(() => setNotice('Active tokens could not be loaded.'));
  }, [reload, revision]);

  const apply = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice('');
    try {
      await work();
      await reload();
    } catch {
      setNotice('The token request failed.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="inbox-stack">
    {canMint && <button type="button" className="inbox-button" disabled={busy} onClick={() => void apply(async () => {
      setIssued(await read<IssuedToken>('', { inbox_id: inboxId, scopes: ['mail:read'] }));
    })}>Mint sandbox read token</button>}
    {issued && <label>Sandbox MCP token (shown once)<input aria-label="Sandbox MCP token" value={issued.token} readOnly /></label>}
    {tokens.map((token) => <div className="inbox-row" key={token.token_id}>
      <small>{token.scopes.join(', ')} · expires {new Date(token.expires_at).toLocaleDateString()}</small>
      <button type="button" className="inbox-button" disabled={busy} onClick={() => void apply(async () => {
        await read('/' + token.token_id + '/revoke', { inbox_id: inboxId });
        if (issued?.token_id === token.token_id) setIssued(null);
        onRevoke?.();
        setNotice('MCP token revoked.');
      })}>Revoke token</button>
    </div>)}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
