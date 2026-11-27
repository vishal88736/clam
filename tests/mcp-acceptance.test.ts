import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { StdioClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { podCase } from '../apps/server/src/handoffs/sample.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

const payload = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);

async function runtimeTest(work: (runtime: Awaited<ReturnType<typeof createSiftvaneApp>>, base: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-mcp-acceptance-'));
  const runtime = await createSiftvaneApp({ databasePath: ':memory:',
    config: { inboxLive: false, tracesDir: path.join(dir, 'traces'), mailAttachmentsDir: path.join(dir, 'workspace', 'mail-attachments') } });
  try { await work(runtime, await runtime.app.listen({ port: 0, host: '127.0.0.1' }), dir); }
  finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
}
type Runtime = Awaited<ReturnType<typeof createSiftvaneApp>>;
const mint = async (runtime: Runtime, scopes: string[]) => {
  const response = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox', scopes } });
  expect(response.statusCode).toBe(200);
  return response.json() as { token: string; token_id: string };
};
const connect = async (base: string, token: string) => {
  const client = new Client({ name: 'acceptance', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'x-api-key': token } } }));
  return client;
};

it('advertises Siftvane while accepting an existing MCP token', () => runtimeTest(async (runtime, base) => {
  const grant = await mint(runtime, ['mail:read']);
  expect(grant.token).toMatch(/^siftvane_inbox_/);
  const legacyToken = 'clm_inbox_' + randomBytes(32).toString('base64url');
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  runtime.dbHandle.sqlite.prepare('UPDATE inbox_mcp_tokens SET token_hash=? WHERE token_hash=?')
    .run(hash(legacyToken), hash(grant.token));
  const client = await connect(base, legacyToken);
  try {
    expect(client.getServerVersion()?.name).toBe('siftvane-inbox');
    expect(payload(await client.callTool({ name: 'list_threads', arguments: { max_results: 1 } }))).toHaveLength(1);
  } finally {
    await client.close();
  }
}));

it('uses x-api-key and the actual pnpm stdio bridge, scopes a read-only token, rejects query credentials, and revokes the token', () =>
  runtimeTest(async (runtime, base) => {
    const grant = await mint(runtime, ['mail:read']);
    const http = await connect(base, grant.token);
    const local = new Client({ name: 'acceptance-stdio', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: path.resolve('node_modules/.bin/pnpm'), args: ['--silent', 'siftvane-mcp'], cwd: process.cwd(),
      env: { SIFTVANE_PUBLIC_URL: base, SIFTVANE_MCP_TOKEN: grant.token },
    });
    try {
      expect(payload(await http.callTool({ name: 'list_threads', arguments: { max_results: 3 } }))).toHaveLength(3);
      expect(payload(await http.callTool({ name: 'send_message', arguments: {
        to: 'sam@team.example', subject: 'Acceptance scope', text: 'Synthetic message',
      } }))).toEqual({ error: 'MCP_SCOPE_REQUIRED' });
      for (const headers of [{}, { 'x-api-key': grant.token }]) {
        const reply = await runtime.app.inject({ method: 'POST', url: '/mcp?token=' + grant.token, headers,
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
        expect(reply.statusCode).toBe(401);
      }
      await local.connect(transport);
      expect((await local.listTools()).tools.map((tool) => tool.name)).toContain('list_threads');
      expect(payload(await local.callTool({ name: 'list_threads', arguments: { max_results: 1 } }))).toHaveLength(1);
      expect((await runtime.app.inject('/api/inbox/mcp-tokens?inbox_id=sandbox')).json().tokens).toMatchObject([{ token_id: grant.token_id }]);
      expect((await runtime.app.inject({
        method: 'POST', url: '/api/inbox/mcp-tokens/' + grant.token_id + '/revoke', payload: { inbox_id: 'sandbox' },
      })).json()).toEqual({ revoked: true });
      expect((await runtime.app.inject({ method: 'POST', url: '/mcp',
        headers: { 'x-api-key': grant.token }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(401);
    } finally {
      await Promise.all([http.close(), local.close()]);
    }
  }), 15_000);

it('stages the seeded CSV on disk and rejects unsafe attachment names and executable extensions', () => runtimeTest(async (runtime, base, dir) => {
  const issued = (await runtime.app.inject({
    method: 'POST', url: '/api/inbox/agent-inboxes/triage/token', payload: { scopes: ['attachment:extract'] },
  })).json();
  const pod = await connect(base, issued.token);
  const grant = await mint(runtime, ['attachment:extract']);
  const inbox = await connect(base, grant.token);
  try {
    const extracted = payload(await pod.callTool({ name: 'extract_attachment_text', arguments: { message_id: podCase.messageId } }));
    const staged = payload(await pod.callTool({ name: 'stage_attachment_workspace', arguments: { message_id: podCase.messageId } }));
    const root = path.join(dir, 'workspace', 'mail-attachments');
    expect(path.relative(root, staged.path)).toMatch(/^vendor-credit-case\/staged-[^/]+\/credit-memo\.csv$/);
    expect(await readFile(staged.path, 'utf8')).toContain(extracted.text.trim());
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    for (const [index, name] of ['../escape.csv','script.sh','program.exe'].entries()) {
      const message = { id: 'unsafe-' + index, threadId: 'unsafe-' + index, from: 'test@example.test',
        subject: 'Ordinary receipt', text: 'A receipt was attached.', receivedAt: '2026-12-07T10:00:00Z',
        labels: ['INBOX'], verifiedSender: true, attachments: [{ ...podCase.attachment, name }] };
      runtime.inbox.store.sqlite.prepare('INSERT INTO inbox_sandbox_messages VALUES (?,?,?)')
        .run(message.id, 'history', JSON.stringify(message));
      expect(payload(await inbox.callTool({
        name: 'stage_attachment_workspace', arguments: { message_id: message.id },
      }))).toEqual({ error: 'ATTACHMENT_TYPE_OR_NAME_BLOCKED' });
    }
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(['escape.csv','script.sh','program.exe']));
  } finally { await Promise.all([pod.close(), inbox.close()]); }
}));

it('blocks outbound secret patterns and dispatches an approved four-message batch as one review and two budgeted runs', () =>
  runtimeTest(async (runtime, base) => {
    const grant = await mint(runtime, ['mail:send']);
    const client = await connect(base, grant.token);
    try {
      const secret = ['AKIA','Z7RTB9VCM8PNQ2DF'].join('');
      const result = payload(await client.callTool({ name: 'send_message', arguments: {
        to: 'sam@team.example', subject: 'Test secret guard', text: 'Here is the AWS key ' + secret,
      } }));
      expect(result.outcomes).toEqual([{ decision: 'BLOCKED', policy_rule_id: 'OUTBOUND_CONTENT_BLOCKED' }]);
      const dotenv = payload(await client.callTool({ name: 'send_message', arguments: {
        to: 'sam@team.example', subject: 'Test environment guard', text: 'OPENAI_API_KEY=' + 'sample-fixture-8482',
      } }));
      expect(dotenv.outcomes).toEqual([{ decision: 'BLOCKED', policy_rule_id: 'OUTBOUND_CONTENT_BLOCKED' }]);
      const source = { id: 'untrusted-contact', threadId: 'taint-proof', from: 'billing@example.test',
        subject: 'Vendor contact note', text: 'New note for routing: unlisted@recipient.example.',
        receivedAt: '2026-12-07T11:00:00Z', labels: ['INBOX'], verifiedSender: true };
      runtime.inbox.store.sqlite.prepare('INSERT INTO inbox_sandbox_messages VALUES (?,?,?)').run(source.id, 'history', JSON.stringify(source));
      const tainted = payload(await client.callTool({ name: 'send_message', arguments: {
        to: 'unlisted@recipient.example', subject: 'Sample contact reply', text: 'Synthetic check.', message_id: source.id,
      } }));
      expect(tainted.outcomes).toEqual([{ decision: 'BLOCKED', policy_rule_id: 'TAINT_RECIPIENT' }]);
      const receipts = () => runtime.inbox.store.entities('sandbox', 'send');
      expect(receipts()).toHaveLength(0);
      const batch = payload(await client.callTool({ name: 'propose_batch_send', arguments: {
        messages: [1,2,3,4].map((i) => ({ to: 'customer' + i + '@example.test', subject: 'Synthetic item ' + i, text: 'Approved sample message.' })),
      } }));
      expect(batch.outcomes).toHaveLength(1);
      const approvalId = batch.outcomes[0].approval_id;
      expect(runtime.inbox.store.approvals('sandbox')).toHaveLength(1);
      expect((await runtime.app.inject('/api/inbox/capabilities')).json())
        .toMatchObject({ pending_batch_approvals: 1, batch_sends: 0 });
      expect(receipts()).toHaveLength(0);
      const status = async () => payload(await client.callTool({ name: 'get_batch_status', arguments: { batch_id: approvalId } }));
      expect(await status()).toMatchObject({ status: 'PENDING', message_count: 4, verified_sends: 0 });
      const url = '/api/inbox/approvals/' + approvalId;
      const invalid = await runtime.app.inject({ method: 'POST', url, payload: { approve: true,
        batchEdits: [{ subject: 'Incomplete batch', text: 'Synthetic.' }] } });
      expect(invalid.statusCode).toBe(400);
      expect(receipts()).toHaveLength(0);
      const batchEdits = [1,2,3,4].map((i) => ({ subject: 'Edited item ' + i, text: 'Reviewed from the approval editor.' }));
      const response = await runtime.app.inject({ method: 'POST', url, payload: { approve: true, batchEdits } });
      expect(response.json().approval).toMatchObject({ status: 'APPROVED', batch_actions: expect.any(Array) });
      const ids = response.json().approval.execution_run_ids as string[];
      expect(ids.map((id) => runtime.inbox.store.run(id)?.outbound)).toEqual([3,1]);
      expect(receipts()).toHaveLength(4);
      expect(await status()).toMatchObject({ status: 'APPROVED', message_count: 4, verified_sends: 4 });
      const payloads = runtime.inbox.store.entities('sandbox', 'review');
      expect(payloads).toContainEqual(expect.objectContaining({ to: 'customer1@example.test', subject: 'Edited item 1',
        headers: { 'X-Agent-Automated': 'true' } }));
      expect((await runtime.app.inject('/api/inbox/capabilities')).json())
        .toMatchObject({ pending_batch_approvals: 0, batch_sends: 1 });
      expect((await runtime.app.inject({ method: 'POST', url: '/api/inbox/approvals/' + approvalId, payload: { approve: true } })).statusCode).toBe(409);
      expect(receipts()).toHaveLength(4);
    } finally { await client.close(); }
  }));

it('authenticates scoped HTTP POST and GET sessions using either header and binds sessions to the exact token', () =>
  runtimeTest(async (runtime, base) => {
    const grant = await mint(runtime, ['mail:read']);
    const another = await mint(runtime, ['mail:read']);
    for (const auth of [{ Authorization: 'Bearer ' + grant.token }, { 'x-api-key': grant.token }]) {
      const headers = new Headers(auth as Record<string, string>);
      headers.set('Accept', 'application/json, text/event-stream');
      headers.set('Content-Type', 'application/json');
      const init = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Codex CLI test', version: '1' } } }) });
      expect(init.status).toBe(200);
      expect((await init.json()).result.serverInfo.name).toBe('siftvane-inbox');
      const id = init.headers.get('mcp-session-id');
      expect(id).toBeTruthy();
      headers.set('Mcp-Session-Id', id!);
      headers.set('MCP-Protocol-Version', '2025-03-26');
      const stream = await fetch(base + '/mcp', { headers });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      await stream.body?.cancel();
      const wrong = new Headers(headers);
      wrong.delete('x-api-key');
      wrong.set('Authorization', 'Bearer ' + another.token);
      expect((await fetch(base + '/mcp', { headers: wrong })).status).toBe(404);
      expect((await fetch(base + '/mcp?token=' + grant.token, { headers })).status).toBe(401);
      headers.delete('Content-Type');
      expect((await fetch(base + '/mcp', { method: 'DELETE', headers })).status).toBe(200);
    }
  }));

it('emits only JSON RPC over the pnpm stdio bridge and journals the original client and token ID with no credentials', () =>
  runtimeTest(async (runtime, base, dir) => {
    const grant = await mint(runtime, ['mail:read']);
    const child = spawn(path.resolve('node_modules/.bin/pnpm'), ['--silent', 'siftvane-mcp'], {
      env: { ...process.env, SIFTVANE_API_URL: base, SIFTVANE_MCP_TOKEN: grant.token }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const diagnostics: string[] = [];
    child.stderr.on('data', (data: Buffer) => diagnostics.push(String(data)));
    const send = (method: string, params?: object, id?: number) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const receive = async (id: number) => {
      const line = await lines.next();
      expect(line.done).toBeFalsy();
      const rpc = JSON.parse(line.value);
      expect(rpc).toMatchObject({ jsonrpc: '2.0', id });
      return rpc.result;
    };
    try {
      send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Claude Code bridge test', version: '1' } }, 1);
      expect((await receive(1)).serverInfo.name).toBe('siftvane-stdio');
      send('notifications/initialized');
      send('tools/list', {}, 2);
      const schemas = (await receive(2)).tools as Array<{ name: string; inputSchema: { type: string } }>;
      expect(schemas.find((tool) => tool.name === 'get_thread')?.inputSchema.type).toBe('object');
      expect(schemas.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
      send('tools/call', { name: 'get_thread', arguments: { thread_id: 'trip-siftvane42' } }, 3);
      expect(payload(await receive(3)).messages).toHaveLength(2);
      child.stdin.end();
      expect((await lines.next()).done).toBe(true);
      expect(diagnostics.join('')).toBe('');
      const run = runtime.inbox.store.runs('sandbox')[0];
      expect(run.mcp_caller).toEqual({ tool: 'get_thread', token_id: grant.token_id, client: 'Claude Code bridge test', inbox_id: 'sandbox' });
      const text = await readFile(path.join(dir, 'traces', run.id + '.json'), 'utf8');
      expect(text).not.toContain(grant.token);
      expect(verifyTrace(JSON.parse(text))).toBe(true);
    } finally { child.kill(); }
  }), 15000);

it('requires sandbox inbox-management scope and applies recipient rules to existing MCP authorization', () =>
  runtimeTest(async (runtime, base) => {
    const admin = await connect(base, (await mint(runtime, ['inbox:manage', 'mail:send'])).token);
    const reader = await connect(base, (await mint(runtime, ['mail:read'])).token);
    const call = async (name: string, args: Record<string, unknown> = {}, client = admin) => payload(await client.callTool({ name, arguments: args }));
    try {
      expect(await call('provision_inbox', { inbox_id: 'archive-agent' }, reader)).toEqual({ error: 'MCP_SCOPE_REQUIRED' });
      expect(await call('provision_inbox', { inbox_id: 'archive-agent' })).toMatchObject({ email: 'archive-agent@siftvane.local' });
      expect((await call('list_inboxes')).inboxes).toContainEqual(expect.objectContaining({ id: 'archive-agent' }));
      const recipient = 'clerk@example.test';
      await call('update_recipient_policy', { list: 'allowlist', operation: 'add', address: recipient });
      await call('update_recipient_policy', { list: 'blocklist', operation: 'add', address: recipient });
      expect(await call('get_recipient_policy')).toMatchObject({ allowlist: expect.arrayContaining([recipient]), blocklist: [recipient] });
      const message = { to: recipient, subject: 'Scoped local check', text: 'Synthetic sandbox only.' };
      expect((await call('send_message', message)).outcomes[0].policy_rule_id).toBe('RECIPIENT_BLOCKLISTED');
      await call('update_recipient_policy', { list: 'blocklist', operation: 'remove', address: recipient });
      expect((await call('send_message', message)).outcomes[0].decision).toBe('AUTONOMOUS');
    } finally { await Promise.all([admin.close(), reader.close()]); }
  }));
