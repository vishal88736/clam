import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { podCase } from '../apps/server/src/handoffs/sample.js';
import { handoffPayloadHash } from '../apps/server/src/handoffs/service.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

const parse = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);

async function withRuntime(work: (runtime: Awaited<ReturnType<typeof createSiftvaneApp>>, base: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-agent-handoffs-'));
  const runtime = await createSiftvaneApp({ databasePath: ':memory:', config: { tracesDir: dir, inboxLive: false } });
  try {
    const base = await runtime.app.listen({ port: 0, host: '127.0.0.1' });
    await work(runtime, base, dir);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function connect(runtime: Awaited<ReturnType<typeof createSiftvaneApp>>, base: string, inboxId: string,
  scopes = ['handoff:read','handoff:send','attachment:extract']) {
  const result = await runtime.app.inject({ method: 'POST', url: '/api/inbox/agent-inboxes/' + inboxId + '/token', payload: { scopes } });
  expect(result.statusCode).toBe(200);
  const token = result.json().token as string;
  const client = new Client({ name: 'pod-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + token } },
  }));
  return { client, token };
}

const send = (client: Client, from: string, to: string, threadId: string, extra: Record<string, unknown> = {}) =>
  client.callTool({ name: 'handoff_to_agent_inbox', arguments: {
    from_inbox_id: from, to_inbox_id: to, thread_id: threadId, task_summary: 'Review the captured evidence',
    structured_payload: { note: 'Attachment confirms the original invoice value' }, ...extra,
  } }).then(parse);

it('receives a signed HMAC handoff over scoped MCP and replays the verified two-hop vendor case', () => withRuntime(async (runtime, base, dir) => {
  const { client: triage, token } = await connect(runtime, base, 'triage');
  const { client: executor } = await connect(runtime, base, 'executor');
  const { client: viewer } = await connect(runtime, base, 'triage', ['handoff:read']);
  try {
    expect((await runtime.app.inject('/api/inbox/agent-inboxes')).json().inboxes.map((item: { email: string }) => item.email))
      .toEqual(['sandbox@siftvane.local','triage@siftvane.local','executor@siftvane.local']);
    expect(await send(viewer, 'triage', 'executor', podCase.threadId)).toEqual({ error: 'MCP_SCOPE_REQUIRED' });
    expect(await send(triage, 'executor', 'triage', 'spoof')).toEqual({ error: 'HANDOFF_INBOX_NOT_AUTHORIZED' });
    expect(await send(triage, 'triage', 'executor', podCase.threadId, { attachment_ids: [podCase.attachmentId] }))
      .toEqual({ error: 'TAINT_DESTINATION' });

    const attachment = parse(await triage.callTool({ name: 'extract_attachment_text', arguments: { message_id: podCase.messageId } }));
    expect(attachment).toMatchObject({ attachment_id: podCase.attachmentId, trust_level: 'untrusted_external' });
    expect(attachment.text).toContain('Duplicate shipping charge');

    const one = await send(triage, 'triage', 'executor', podCase.threadId, {
      attachment_ids: [podCase.attachmentId], structured_payload: { trust_level: 'pretend-trusted', extracted: attachment.text },
    });
    expect(one).toMatchObject({ status: 'DELIVERED', headers: {
      'X-Siftvane-Agent-Origin': 'triage', 'X-Siftvane-Hop-Count': '1', 'X-Siftvane-Max-Hops': '4',
    } });
    const [received] = parse(await executor.callTool({ name: 'list_agent_handoffs' }));
    expect(received).toMatchObject({ id: one.handoff_id, trust_level: 'verified_agent_handoff', payload: {
      trust_level: 'untrusted_external', data: { trust_level: 'untrusted_external' }, attachment_ids: [podCase.attachmentId],
    } });
    expect(parse(await triage.callTool({ name: 'list_agent_handoffs' }))).toEqual([]);
    const key = createHmac('sha256', runtime.config.encryptionKey).update('clam:agent-handoff:v1').digest();
    const signature = createHmac('sha256', key).update([
      'sandbox-pod', podCase.threadId, 'triage', 'executor', 1, handoffPayloadHash(received),
    ].join('|')).digest('hex');
    expect(received.headers['X-Siftvane-Handoff-Sig']).toBe(signature);
    expect(runtime.inbox.handoffs.verify({ ...received, task_summary: 'Modified summary' })).toBe(false);
    expect(runtime.inbox.handoffs.verify({ ...received, max_hops: 6 })).toBe(false);
    const legacyHeaders = Object.fromEntries(Object.entries(received.headers)
      .map(([name, value]) => [name.replace('X-Siftvane-', 'X-Clam-'), value]));
    runtime.inbox.store.sqlite.prepare('UPDATE agent_handoffs SET payload_json=? WHERE id=?')
      .run(JSON.stringify({ payload: received.payload, headers: legacyHeaders }), received.id);
    expect(runtime.inbox.handoffs.delivery(received.id)?.headers['X-Siftvane-Handoff-Sig']).toBe(signature);

    expect(parse(await executor.callTool({ name: 'extract_attachment_text', arguments: { message_id: podCase.messageId } })).text)
      .toBe(attachment.text);
    const two = await send(executor, 'executor', 'triage', podCase.threadId, {
      task_summary: 'Return a verified credit reply draft', structured_payload: { draft: 'Please apply the confirmed 18.00 USD credit.' },
    });
    expect(two).toMatchObject({ status: 'DELIVERED', headers: { 'X-Siftvane-Hop-Count': '2' } });
    expect(parse(await executor.callTool({ name: 'complete_agent_handoff', arguments: { handoff_id: one.handoff_id } })).status).toBe('COMPLETED');
    expect(runtime.inbox.store.actions(one.run_id)).toMatchObject([{ kind: 'handoff', status: 'VERIFIED', traceId: one.trace_step_id }]);

    const trace = await readFile(path.join(dir, one.run_id + '.json'), 'utf8');
    expect(verifyTrace(JSON.parse(trace))).toBe(true);
    expect(trace).not.toContain(attachment.text);
    expect(trace).not.toContain(token);
    const replay = (await runtime.app.inject('/api/inbox/threads?run_id=' + two.run_id)).json().threads;
    expect(replay[0].hops.flatMap((hop: { inbound?: { hop_count?: number } }) => hop.inbound?.hop_count ?? [])).toEqual([1, 2]);
    expect(replay[0].hops.some((hop: { step_id: string }) => hop.step_id === one.trace_step_id)).toBe(true);
    expect((await runtime.app.inject('/api/inbox/capabilities')).json()).toMatchObject({ signed_handoffs: 2, parsed_attachments: 1 });
  } finally {
    await Promise.all([triage.close(), executor.close(), viewer.close()]);
  }
}));

it('halts a thread on its hop budget or ping-pong pattern, streams the warning, and requires a reset', () => withRuntime(async (runtime, base) => {
  const { client: triage } = await connect(runtime, base, 'triage');
  const { client: executor } = await connect(runtime, base, 'executor');
  const response = await fetch(base + '/api/inbox/events');
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let events = '';
  const stream = (async () => { for (;;) {
    const next = await reader.read();
    if (next.done) return;
    events += next.value;
  } })();
  try {
    const first = await send(triage, 'triage', 'executor', 'budget-stop', { max_hops: 1 });
    expect(first.status).toBe('DELIVERED');
    const stopped = await send(executor, 'executor', 'triage', 'budget-stop', { max_hops: 6 });
    expect(stopped).toMatchObject({ status: 'LOOP_HALTED', rule_id: 'AGENT_LOOP_PREVENTED' });
    expect(runtime.inbox.store.actions(stopped.run_id)).toHaveLength(0);
    expect(runtime.inbox.store.approval(stopped.approval_id)).toMatchObject({ status: 'PENDING', triggered_rule_id: 'AGENT_LOOP_PREVENTED' });
    expect((await send(executor, 'executor', 'sandbox', 'budget-stop')).status).toBe('LOOP_HALTED');
    expect(runtime.inbox.handoffs.list('sandbox')).toHaveLength(0);
    const reset = await runtime.app.inject({
      method: 'POST', url: '/api/inbox/approvals/' + stopped.approval_id, payload: { approve: true },
    });
    expect(reset.statusCode).toBe(200);
    expect((await send(executor, 'executor', 'triage', 'budget-stop')).headers['X-Siftvane-Hop-Count']).toBe('1');

    expect((await send(triage, 'triage', 'executor', 'ping-pong')).status).toBe('DELIVERED');
    expect((await send(executor, 'executor', 'triage', 'ping-pong')).status).toBe('DELIVERED');
    const pingPong = await send(triage, 'triage', 'executor', 'ping-pong');
    expect(pingPong.status).toBe('LOOP_HALTED');
    expect(runtime.inbox.store.approval(pingPong.approval_id)?.reason).toContain('Repeated');
    expect(runtime.inbox.halted()).toBe(false);
    await reader.cancel();
    await stream;
    expect(events).toContain('event: warning');
    expect(events).toContain('AGENT_LOOP_PREVENTED');
    expect(verifyTrace(runtime.inbox.store.trace(stopped.run_id))).toBe(true);
  } finally {
    await reader.cancel();
    await Promise.all([triage.close(), executor.close()]);
  }
}));
