import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

const root = 'https://www.googleapis.com/auth/';
const readonly = [root + 'gmail.readonly', root + 'calendar.events.readonly'];
const readwrite = [root + 'gmail.modify', root + 'calendar.events'];
const identity = ['openid', root + 'userinfo.email', root + 'userinfo.profile'];
const access = 'mock-access-ya29.test-xy67';
const refresh = 'mock-refresh-test-as89';
const clientSecret = 'mock-google-client-secret';
const leaks = [access, refresh, clientSecret, 'Authorization: Bearer'];
const goodVerificationLink = 'https://verify.example/verify-email?token=single-use-fixture-xy69';
const wrongHostLink = 'https://outside.example/verify-email?token=wrong-host-fixture';
const redirectLink = 'https://verify.example/verify-email?next=https%3A%2F%2Foutside.example%2F';
const alphanumericCode = 'CL48A2';

function smallPdf(text: string) {
  const content = 'BT /F1 12 Tf 24 90 Td (' + text + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 130] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const entries = ['0000000000 65535 f '];
  for (const [i, object] of objects.entries()) {
    entries.push(String(body.length).padStart(10, '0') + ' 00000 n ');
    body += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = body.length;
  body += 'xref\n0 6\n' + entries.join('\n') + '\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body);
}

const googleResult = (value: unknown) => Response.json(value);

async function fixture(work: (test: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const test = await createFixture();
  try { await work(test); }
  finally {
    await test.runtime.close();
    await rm(test.dir, { recursive: true, force: true });
  }
}

async function createFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-google-test-'));
  let nonce = '';
  let sub = 'google-operator-100';
  let granted = '';
  let challenge = '';
  let expiry = 3600;
  let refreshFailure = false;
  let apiCalls = 0;
  let sendCount = 0;
  let revokeCount = 0;
  let refreshCount = 0;
  const listStatuses: (number | { status: number; reason: string })[] = [];
  const programQueries: URLSearchParams[] = [];
  let attachmentCalls = 0;
  let includePinnedLink = false;
  let writeHeaders: Headers | undefined;
  const pdf = smallPdf('Quarterly notes ' + refresh);
  let sent: { raw: string; threadId?: string } | undefined;
  const sender = 'sam@team.example';
  const event = {
    id: 'managed-event', summary: 'Original event', etag: 'etag1',
    start: { dateTime: '2026-12-10T13:00:00.000Z' }, end: { dateTime: '2026-12-10T13:30:00.000Z' },
    extendedProperties: { private: { clamKind: 'focus', clamFlexible: 'true' } },
  };
  let current = structuredClone(event);
  const raw = {
    id: 'source-message', threadId: 'thread-one', labelIds: ['INBOX'], internalDate: String(Date.now() - 60_000),
    payload: {
      headers: [
        { name: 'From', value: sender }, { name: 'To', value: 'operator@test.example' },
        { name: 'Subject', value: 'Quarterly notes' }, { name: 'Message-ID', value: '<original@team.example>' },
        { name: 'References', value: '<earlier@team.example>' },
        { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=NONE) header.from=team.example' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Notes for review ' + access).toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'notes.pdf', body: { attachmentId: 'part-one', size: pdf.length } },
      ],
    },
  };
  const verificationMessage = (id: string, sender: string, when: number, verificationCode: string, link = false) => ({
    id, threadId: id, labelIds: ['INBOX'], internalDate: String(Date.now() - when * 60_000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'verification@' + sender },
        { name: 'Subject', value: link ? 'Your verification link' : 'Your sign-in code' },
        { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=' + sender },
      ],
      body: { data: Buffer.from((link ? 'Your verification link is ' : 'Your verification code is ') + verificationCode + '.').toString('base64url') },
    },
  });
  const fake: typeof fetch = async (resource, init = {}) => {
    const url = new URL(String(resource));
    const body = init.body ? String(init.body) : '';
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(body);
      expect(form.get('client_secret')).toBe(clientSecret);
      if (form.get('grant_type') === 'refresh_token') {
        refreshCount++;
        expect(form.get('refresh_token')).toBe(refresh);
        if (refreshFailure) return Response.json({ error: 'invalid_grant', debug: refresh }, { status: 400 });
      } else {
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(challenge);
      }
      return googleResult({ access_token: access, refresh_token: refresh, expires_in: expiry, scope: granted, id_token: 'mock-oidc-token' });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      expect(new URLSearchParams(body).get('token')).toBe(refresh);
      revokeCount++;
      return new Response(null, { status: 200 });
    }
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer ' + access);
    if (url.hostname === 'openidconnect.googleapis.com') return googleResult({ sub, email: sub + '@test.example', email_verified: true });
    apiCalls++;
    const endpoint = url.pathname;
    if (endpoint.endsWith('/messages/send')) {
      sendCount++;
      sent = JSON.parse(body);
      return googleResult({ id: 'delivered-1' });
    }
    if (endpoint.endsWith('/messages/delivered-1')) return googleResult({ raw: sent?.raw });
    if (endpoint.endsWith('/attachments/part-one')) {
      attachmentCalls++;
      return googleResult({ data: pdf.toString('base64url') });
    }
    if (endpoint.endsWith('/messages/source-message')) return googleResult(raw);
    if (endpoint.endsWith('/messages/verify-decoy')) return googleResult(verificationMessage('verify-decoy', 'github.com.example.org', 1, '000001'));
    if (endpoint.endsWith('/messages/verify-stale')) return googleResult(verificationMessage('verify-stale', 'github.com', 45, '000002'));
    if (endpoint.endsWith('/messages/verify-current')) return googleResult(verificationMessage('verify-current', 'github.com', 2, '653241'));
    if (endpoint.endsWith('/messages/wrong-link')) return googleResult(verificationMessage('wrong-link', 'verify.example', 1, wrongHostLink, true));
    if (endpoint.endsWith('/messages/redirect-link')) return googleResult(verificationMessage('redirect-link', 'verify.example', 1, redirectLink, true));
    if (endpoint.endsWith('/messages/pinned-link')) return googleResult(verificationMessage('pinned-link', 'verify.example', 1, goodVerificationLink, true));
    if (endpoint.endsWith('/messages/alpha-code')) return googleResult(verificationMessage('alpha-code', 'code.example', 1, alphanumericCode));
    if (endpoint.endsWith('/threads/thread-one')) return googleResult({ id: 'thread-one', messages: [raw] });
    if (endpoint.endsWith('/threads')) {
      const status = listStatuses.shift();
      if (status) return typeof status === 'number' ? Response.json({ debug: access }, { status }) :
        Response.json({ error: { details: [{ reason: status.reason }] }, debug: access }, { status: status.status });
      return googleResult({ threads: [{ id: 'thread-one' }] });
    }
    if (endpoint.endsWith('/messages') && url.searchParams.get('q')?.startsWith('from:@github.com ')) {
      expect(url.searchParams.get('q')).toBe('from:@github.com newer_than:1h -in:spam -in:trash');
      return googleResult({ messages: ['verify-decoy','verify-stale','verify-current'].map((id) => ({ id })) });
    }
    if (endpoint.endsWith('/messages') && url.searchParams.get('q')?.startsWith('from:@verify.example ')) {
      return googleResult({ messages: ['wrong-link','redirect-link', ...(includePinnedLink ? ['pinned-link'] : [])].map((id) => ({ id })) });
    }
    if (endpoint.endsWith('/messages') && url.searchParams.get('q')?.startsWith('from:@code.example ')) {
      return googleResult({ messages: [{ id: 'alpha-code' }] });
    }
    if (endpoint.endsWith('/messages') && url.searchParams.get('q')?.includes('subject:"Quarterly notes"')) {
      programQueries.push(url.searchParams);
      if (!url.searchParams.has('pageToken')) return googleResult({ messages: [{ id: 'verify-current' }], nextPageToken: 'page-two' });
      return googleResult({ messages: [{ id: raw.id }] });
    }
    if (endpoint.endsWith('/messages')) return googleResult({ messages: [{ id: raw.id }] });
    if (url.hostname === 'photospicker.googleapis.com') return Response.json({
      error: { status: 'FAILED_PRECONDITION', details: [{ reason: 'PENDING_USER_ACTION' }] }, debug: access,
    }, { status: 400 });
    if (endpoint.endsWith('/labels')) return googleResult({ labels: [] });
    if (endpoint.endsWith('/events')) return googleResult({ items: [current] });
    if (endpoint.endsWith('/events/managed-event')) {
      if (init.method === 'PATCH') {
        writeHeaders = headers;
        current = { ...current, ...JSON.parse(body), etag: 'etag-' + (apiCalls + 1) };
      }
      return googleResult(current);
    }
    throw new Error('Unexpected Google request ' + endpoint);
  };
  const runtime = await createSiftvaneApp({
    databasePath: ':memory:',
    config: {
      tracesDir: path.join(dir, 'traces'), mailAttachmentsDir: path.join(dir, 'stage'), inboxLive: true, googleClientId: 'fixture.apps.googleusercontent.com',
      googleClientSecret: clientSecret, googleTokenKey: randomBytes(32).toString('hex'), sessionSecret: randomBytes(32).toString('hex'),
      googleRedirectUri: 'http://localhost:4000/api/auth/google/callback', webOrigin: 'http://localhost:3000',
    },
    google: {
      fetch: fake, verifyIdentity: async (token) => {
        expect(token).toBe('mock-oidc-token');
        return { sub, email: sub + '@test.example', email_verified: true, nonce };
      },
    },
  });
  const base = await runtime.app.listen({ port: 0, host: '127.0.0.1' });
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([key, value]) => key + '=' + value).join('; ');
  const capture = (set: string | string[] | undefined) => {
    for (const line of typeof set === 'string' ? [set] : set ?? []) {
      expect(line).toContain('HttpOnly');
      expect(line).toContain('SameSite=Lax');
      const pair = line.slice(0, line.indexOf(';'));
      const key = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value) jar.set(key, value);
      else jar.delete(key);
    }
  };
  const authorization = (result: { headers: { location?: string; 'set-cookie'?: string | string[] }; statusCode: number }) => {
    expect(result.statusCode).toBe(302);
    const url = new URL(String(result.headers.location));
    challenge = url.searchParams.get('code_challenge')!;
    nonce = url.searchParams.get('nonce') ?? '';
    capture(result.headers['set-cookie']);
    return url;
  };
  const begin = async (endpoint: string) => authorization(
    await runtime.app.inject({ url: '/api/auth/google/' + endpoint, headers: { Cookie: cookie() } }),
  );
  const complete = async (state: string) => {
    const result = await runtime.app.inject({
      url: '/api/auth/google/callback?' + new URLSearchParams({ code: 'mock-code', state }),
      headers: { Cookie: cookie() },
    });
    capture(result.headers['set-cookie']);
    return result;
  };
  const login = async () => {
    const auth = await begin('login');
    granted = identity.join(' ');
    expect((await complete(auth.searchParams.get('state')!)).statusCode).toBe(302);
  };
  const connect = async (mode: 'readonly' | 'readwrite', scopes = mode === 'readonly' ? readonly : readwrite) => {
    const consent = await begin('connect?mode=' + mode);
    granted = scopes.join(' ');
    return complete(consent.searchParams.get('state')!);
  };
  const api = (url: string, payload?: unknown, authenticated = true) => runtime.app.inject({
    url, method: payload === undefined ? 'GET' : 'POST', headers: authenticated ? { Cookie: cookie() } : {}, payload: payload as object | undefined,
  });
  const getInbox = async () => (await api('/api/auth/session')).json().active_inbox_id as string;
  const issueToken = async (inbox: string, scopes: string[]) => {
    const response = await api('/api/auth/google/token/' + inbox, { scopes });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  };
  const mcp = async (token: string) => {
    const client = new Client({ name: 'google-inbox-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    return client;
  };
  return {
    dir, runtime, api, base, cookie, begin, complete, login, connect, getInbox, issueToken, mcp, authorization,
    useSubject: (value: string) => { sub = value; },
    apiCalls: () => apiCalls, sendCount: () => sendCount, revokeCount: () => revokeCount,
    refreshCount: () => refreshCount, respondToList: (...statuses: typeof listStatuses) => { listStatuses.push(...statuses); },
    attachmentCalls: () => attachmentCalls, programQueries,
    enablePinnedLink: () => { includePinnedLink = true; },
    expire: () => { expiry = 1; refreshFailure = true; },
    setScopes: (value: string[]) => { granted = value.join(' '); },
    sent: () => sent, event: () => current, writeHeaders: () => writeHeaders,
  };
}

const output = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);

it('signs one-time PKCE state, binds it to the browser, and rejects broad or unexpected write scopes', () => fixture(async (test) => {
  const auth = await test.begin('login');
  const state = auth.searchParams.get('state')!;
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  expect(auth.searchParams.get('scope')?.split(' ')).toEqual(identity);
  expect((await test.complete(state + 'bad')).json()).toEqual({ error: 'INVALID_GOOGLE_STATE' });
  expect((await test.runtime.app.inject({ url: '/api/auth/google/callback?code=mock&state=' + state })).statusCode).toBe(400);
  test.setScopes(identity);
  expect((await test.complete(state)).statusCode).toBe(302);
  expect((await test.complete(state)).statusCode).toBe(400);
  const consent = await test.begin('connect?mode=readonly');
  expect(consent.searchParams.get('scope')?.split(' ')).toEqual(readonly);
  expect(consent.searchParams.get('include_granted_scopes')).toBe('true');
  expect(consent.searchParams.get('access_type')).toBe('offline');
  test.setScopes([...readonly, 'https://mail.google.com/']);
  expect((await test.complete(consent.searchParams.get('state')!)).json().error).toBe('GOOGLE_SCOPE_NOT_ALLOWED');
  expect((await test.connect('readonly', readwrite)).json().error).toBe('GOOGLE_SCOPE_NOT_ALLOWED');
  expect((await test.api('/api/auth/google/connect?mode=readonly&scope=' + root + 'calendar')).statusCode).toBe(400);
  expect(await test.getInbox()).toBe('sandbox');
  expect((await test.api('/api/auth/logout', {})).headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('Max-Age=0')]));
}));

it('encrypts both OAuth credentials, enforces readonly before Google, and disconnects the scoped token', () => fixture(async (test) => {
  await test.login();
  expect((await test.connect('readonly')).statusCode).toBe(302);
  const inbox = await test.getInbox();
  const row = test.runtime.dbHandle.sqlite.prepare('SELECT * FROM oauth_connections WHERE inbox_id=?').get(inbox);
  expect(row?.encrypted_access_token).toBeTruthy();
  expect(row?.encrypted_refresh_token).toBeTruthy();
  expect(JSON.parse(String(row?.iv)).access).not.toBe(JSON.parse(String(row?.iv)).refresh);
  expect(JSON.stringify(row)).not.toContain(access);
  expect(JSON.stringify(row)).not.toContain(refresh);
  expect(test.runtime.dbHandle.sqlite.prepare('SELECT adapter_type FROM inboxes WHERE id=?').get(inbox)?.adapter_type).toBe('gmail_oauth');
  expect(test.runtime.inbox.store.policy(`live:${inbox}`).policy.allowlist).toEqual([]);
  const accessToken = await test.issueToken(inbox, ['mail:send']);
  const client = await test.mcp(accessToken);
  const count = test.apiCalls();
  const blocked = await client.callTool({ name: 'send_message', arguments: {
    to: 'sam@team.example', subject: 'Read-only proof', text: 'Please review the notes.', message_id: 'source-message',
  } });
  expect(output(blocked)).toMatchObject({ error: 'SCOPE_UPGRADE_REQUIRED', action: expect.stringMatching(/Upgrade/) });
  expect(test.apiCalls()).toBe(count);
  const disconnect = (await test.api('/api/auth/google/disconnect/' + inbox, { revoke_mcp: true })).json();
  expect(disconnect).toMatchObject({ ok: true, remote_revoked: true });
  expect(test.revokeCount()).toBe(1);
  expect(test.runtime.dbHandle.sqlite.prepare('SELECT * FROM oauth_connections').all()).toEqual([]);
  expect(test.runtime.accounts.authenticateMcp(accessToken)).toBeUndefined();
  expect(verifyTrace(JSON.parse(await readFile(path.join(test.dir, 'traces', disconnect.audit_id + '.json'), 'utf8')))).toBe(true);
  await client.close();
}));

it('runs isolated Gmail and Calendar MCP actions with verified read-back, rollback, and no OAuth leaks', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly');
  const inbox = await test.getInbox();
  await test.connect('readwrite');
  expect(await test.getInbox()).toBe(inbox);
  const scopedToken = await test.issueToken(inbox, ['mail:read', 'mail:send', 'attachment:extract', 'calendar:propose']);
  const client = await test.mcp(scopedToken);
  const sse = await fetch(test.base + '/api/inbox/events', { headers: { Cookie: test.cookie() } });
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
  const collected: string[] = [];
  const streaming = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(value);
    }
  })();
  try {
    const threads = await client.callTool({ name: 'list_threads' });
    expect(output(threads)[0].messages[0]).toMatchObject({ trust_level: 'untrusted_external', quarantined: false });
    const message = await client.callTool({ name: 'get_message', arguments: { message_id: 'source-message' } });
    expect(output(message).excerpt).toMatch(/Notes for review/);
    expect(output(message)).not.toHaveProperty('body');
    const attachment = await client.callTool({ name: 'extract_attachment_text', arguments: { message_id: 'source-message' } });
    expect(output(attachment)).toMatchObject({ name: 'notes.pdf', text: expect.stringContaining('Quarterly notes') });

    const { version, policy } = test.runtime.inbox.store.policy(`live:${inbox}`);
    test.runtime.inbox.store.savePolicy(`live:${inbox}`, version, { ...policy, allowlist: ['sam@team.example'] });
    const send = await client.callTool({ name: 'send_message', arguments: {
      to: 'sam@team.example', subject: 'Re: Quarterly notes', text: 'Do not include any automated footer', message_id: 'source-message',
    } });
    expect(output(send)).toMatchObject({ status: 'COMPLETED', outcomes: [{ decision: 'AUTONOMOUS' }] });
    expect(test.sendCount()).toBe(1);
    expect(test.sent()?.threadId).toBe('thread-one');
    const mime = Buffer.from(test.sent()!.raw, 'base64url').toString();
    const [headers] = mime.split('\r\n\r\n');
    const body = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--siftvane-/.exec(mime)?.[1] ?? '';
    expect(headers).toContain('X-Agent-Automated: true');
    expect(headers).toContain('In-Reply-To: <original@team.example>');
    expect(headers).toContain('References: <earlier@team.example> <original@team.example>');
    expect(Buffer.from(body, 'base64').toString()).toContain('automatically by Siftvane');
    const sentRun = output(send).run_id;
    const proof = (await test.api('/api/inbox/runs/' + sentRun + '/trace')).json();
    expect(proof.steps.some((item: { detail: { outcome?: string } }) => item.detail.outcome === 'VERIFIED')).toBe(true);
    expect((await test.api('/api/inbox/runs/' + sentRun + '/trace', undefined, false)).statusCode).toBe(404);
    const proposal = await client.callTool({ name: 'propose_calendar_change', arguments: {
      event_id: 'managed-event', event: { title: 'Updated event', start: '2026-12-10T13:15:00.000Z', end: '2026-12-10T13:45:00.000Z',
        guests: [], flexible: true, kind: 'focus' },
    } });
    const approval = output(proposal).outcomes[0].approval_id;
    expect(test.event().summary).toBe('Original event');
    const accepted = (await test.api('/api/inbox/approvals/' + approval, { approve: true })).json();
    expect(accepted.run).toMatchObject({ status: 'COMPLETED', calendar: 1 });
    expect(test.writeHeaders()?.get('If-Match')).toBe('etag1');
    expect(test.event().summary).toBe('Updated event');
    const rolled = (await test.api('/api/inbox/runs/' + accepted.run.id + '/rollback', { wait: true })).json();
    expect(rolled.run.status).toBe('COMPLETED');
    expect(test.event().summary).toBe('Original event');
    const strictScope = await client.callTool({ name: 'get_verification_code', arguments: { expected_sender_domain: 'github.com' } });
    expect(output(strictScope).error).toBe('MCP_SCOPE_REQUIRED');
    test.useSubject('operator-two');
    await test.login();
    expect((await test.api('/api/inbox/runs/' + sentRun + '/trace')).statusCode).toBe(404);
    expect((await test.api('/api/auth/session')).json().inboxes).toEqual([]);
    expect((await test.api('/api/auth/inbox', { inbox_id: inbox })).statusCode).toBe(404);
    await reader.cancel();
    await streaming;
    const files = await readdir(path.join(test.dir, 'traces'));
    const traceText = (await Promise.all(files.map((file) => readFile(path.join(test.dir, 'traces', file), 'utf8')))).join('\n');
    for (const secret of leaks) {
      expect(traceText).not.toContain(secret);
      expect(collected.join('')).not.toContain(secret);
      expect(JSON.stringify([threads, message, attachment, send, proposal])).not.toContain(secret);
    }
    expect(traceText).not.toContain('Notes for review');
    expect(collected.join('')).not.toContain('Notes for review');
    expect(collected.join('')).toContain('event: step');
    expect(collected.join('')).toContain('VERIFIED');
  } finally {
    await reader.cancel();
    await client.close();
  }
}), 20_000);

it('marks expired refresh grants as reauth required without returning the upstream error body', () => fixture(async (test) => {
  await test.login();
  test.expire();
  await test.connect('readonly');
  const inbox = await test.getInbox();
  const token = await test.issueToken(inbox, ['mail:read']);
  const client = await test.mcp(token);
  const data = output(await client.callTool({ name: 'list_threads' }));
  expect(data).toMatchObject({ error: 'GOOGLE_REAUTH_REQUIRED' });
  expect(JSON.stringify(data)).not.toContain(refresh);
  expect((await test.api('/api/auth/session')).json().inboxes[0].status).toBe('reauth_required');
  await client.close();
}));

it('fails live startup when encryption and session keys are weak', async () => {
  await expect(createSiftvaneApp({ databasePath: ':memory:', config: {
    inboxLive: true, googleClientId: 'mock', googleClientSecret: 'test', googleTokenKey: 'a'.repeat(64), sessionSecret: 'b'.repeat(64),
  } })).rejects.toThrow('SIFTVANE_TOKEN_ENCRYPTION_KEY');
});

it('retries one 401, backs off a 429, maps 403, and scopes verification lookups to exact recent senders', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly');
  const inbox = await test.getInbox();
  const token = await test.issueToken(inbox, ['mail:read', 'otp:read:github.com']);
  const client = await test.mcp(token);
  try {
    test.respondToList(401, 429);
    expect(output(await client.callTool({ name: 'list_threads' }))).toHaveLength(1);
    expect(test.refreshCount()).toBe(1);
    test.respondToList(403);
    expect(output(await client.callTool({ name: 'list_threads' }))).toEqual({ error: 'GOOGLE_ACCESS_DENIED' });
    test.respondToList({ status: 403, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' });
    expect(output(await client.callTool({ name: 'list_threads' }))).toMatchObject({ error: 'SCOPE_UPGRADE_REQUIRED' });
    test.respondToList({ status: 403, reason: 'SERVICE_DISABLED' });
    expect(output(await client.callTool({ name: 'list_threads' }))).toMatchObject({ error: 'GOOGLE_API_DISABLED', action: expect.stringContaining('Google Cloud') });
    const denied = await client.callTool({ name: 'get_verification_code', arguments: { expected_sender_domain: 'example.org' } });
    expect(output(denied)).toMatchObject({ error: 'MCP_SCOPE_REQUIRED' });
    const code = await client.callTool({ name: 'get_verification_code', arguments: { expected_sender_domain: 'github.com', max_age_minutes: 5 } });
    expect(output(code)).toEqual({ code: '653241' });
    const absent = await client.callTool({ name: 'get_verification_code', arguments: { expected_sender_domain: 'github.com', max_age_minutes: 1 } });
    expect(output(absent)).toEqual({ found: false });
  } finally { await client.close(); }
}));

it('searches Gmail using the requested filters, follows pages, and loads only requested attachment bytes', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly');
  const inbox = await test.getInbox();
  const messages = await test.runtime.inbox.readMessages(`live:${inbox}`, {
    newer_than_days: 30, from_contains: 'sam@team.example', subject_contains: 'Quarterly notes', keywords: [], limit: 1,
  });
  expect(test.programQueries.map((query) => query.get('pageToken'))).toEqual([null, 'page-two']);
  expect(test.programQueries[0].get('q')).toBe('newer_than:30d -in:spam -in:trash -in:sent -in:drafts from:"sam@team.example" subject:"Quarterly notes"');
  expect(messages.map((message) => message.id)).toEqual(['source-message']);
  expect(test.attachmentCalls()).toBe(0);
  expect(await messages[0].loadAttachments?.()).toEqual([expect.objectContaining({ name: 'notes.pdf' })]);
  await messages[0].loadAttachments?.();
  expect(test.attachmentCalls()).toBe(1);
}));

it('tells an OAuth-connected user when Google Photos still needs account setup', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly', [...readonly, root + 'photospicker.mediaitems.readonly']);
  const inbox = await test.getInbox();
  const client = await test.mcp(await test.issueToken(inbox, ['photos:read']));
  try {
    const result = output(await client.callTool({ name: 'photos_start_picker' }));
    expect(result).toMatchObject({ error: 'GOOGLE_PHOTOS_SETUP_REQUIRED', action: expect.stringContaining('Complete Google Photos setup') });
    expect(JSON.stringify(result)).not.toContain(access);
  } finally { await client.close(); }
}));

it('links a second Google account and keeps policy, history, and scoped MCP requests inbox-specific', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly');
  const first = await test.getInbox();
  const firstRun = (await test.api('/api/inbox/runs', { wait: true })).json().run;
  expect(firstRun).toMatchObject({ status: 'COMPLETED', mode: 'live:' + first });
  test.useSubject('secondary-address');
  const nextIdentity = await test.begin('login?link=true');
  test.setScopes(identity);
  const secondConsent = test.authorization(await test.complete(nextIdentity.searchParams.get('state')!));
  expect(secondConsent.searchParams.get('login_hint')).toBe('secondary-address@test.example');
  test.setScopes(readonly);
  expect((await test.complete(secondConsent.searchParams.get('state')!)).statusCode).toBe(302);
  const second = await test.getInbox();
  expect(second).not.toBe(first);
  const status = (await test.api('/api/auth/session')).json();
  expect(status.user.email).toBe('google-operator-100@test.example');
  expect(status.inboxes.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([first, second]));
  expect((await test.api('/api/inbox/runs/' + firstRun.id + '/trace')).statusCode).toBe(404);
  const sandboxToken = await test.issueToken('sandbox', ['mail:read']);
  const client = await test.mcp(sandboxToken);
  const before = test.apiCalls();
  try {
    const thread = await client.callTool({ name: 'get_thread', arguments: { thread_id: 'trip-siftvane42' } });
    expect(output(thread).messages).toHaveLength(2);
    expect(test.apiCalls()).toBe(before);
  } finally { await client.close(); }
}));

it('pins verification links, rejects redirect parameters, and records redacted one-time retrievals', () => fixture(async (test) => {
  await test.login();
  await test.connect('readonly');
  const inbox = await test.getInbox();
  const token = await test.issueToken(inbox, ['otp:read:verify.example', 'otp:read:code.example']);
  const client = await test.mcp(token);
  const sse = await fetch(test.base + '/api/inbox/events', { headers: { Cookie: test.cookie() } });
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
  let streamed = '';
  const reading = (async () => { for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    streamed += chunk.value;
  } })();
  const lookup = (domain: string, tool = 'get_verification_code') => client.callTool({
    name: tool, arguments: { expected_sender_domain: domain, max_age_minutes: 5 },
  }).then(output);
  try {
    expect(await lookup('verify.example')).toEqual({ found: false });
    const wildcard = await client.callTool({ name: 'get_verification_code', arguments: { expected_sender_domain: '*.example' } });
    expect(wildcard.isError).toBe(true);
    test.enablePinnedLink();
    expect(await lookup('verify.example', 'wait_for_verification_email')).toEqual({ verification_url: goodVerificationLink });
    expect(await lookup('verify.example')).toEqual({ found: false });
    expect(await lookup('code.example')).toEqual({ code: alphanumericCode });
    expect(await lookup('code.example')).toEqual({ found: false });
    const database = test.runtime.inbox.store.sqlite;
    const rows = database.prepare('SELECT * FROM verification_consumptions ORDER BY message_id').all();
    expect(rows).toMatchObject([{ inbox_id: inbox, message_id: 'alpha-code' }, { inbox_id: inbox, message_id: 'pinned-link' }]);
    expect(rows[0].token_id).toMatch(/^[a-f0-9]{24}$/);
    expect((await test.api('/api/inbox/capabilities')).json().service_verifications).toBe(2);
    await reader.cancel();
    await reading;
    const traces = await Promise.all((await readdir(path.join(test.dir, 'traces'))).filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(path.join(test.dir, 'traces', entry), 'utf8')));
    expect(traces).toHaveLength(5);
    const verified = traces.map((trace) => JSON.parse(trace));
    for (const trace of verified) expect(verifyTrace(trace)).toBe(true);
    expect(verified.flatMap((trace) => trace.steps).filter((step) => step.detail.action === 'verification_consumption')).toHaveLength(2);
    expect(verified.flatMap((trace) => trace.steps).filter((step) => step.detail.found === false)).toHaveLength(3);
    for (const surface of [traces.join('\n'), streamed, JSON.stringify(rows)]) {
      for (const secret of [token, goodVerificationLink, wrongHostLink, redirectLink, alphanumericCode]) expect(surface).not.toContain(secret);
    }
    expect(streamed).toContain('***8A2');
    expect(streamed).toContain('verification_url_redacted');
  } finally {
    await reader.cancel();
    await client.close();
  }
}));
