import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createClamApp } from '../apps/server/src/app.js';
import type { AgentConfig } from '../apps/server/src/inbox/agentConfig.js';
import { extractPhotoDetails, parseReceiptText } from '../apps/server/src/workspace/photos.js';
import type { WorkspaceAdapter } from '../apps/server/src/workspace/types.js';

type Runtime = Awaited<ReturnType<typeof createClamApp>>;
const payload = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);
const user = 'clam-local-sandbox';
const hasTesseract = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function runtimeTest(work: (runtime: Runtime, base: string) => Promise<void>, agent?: AgentConfig) {
  const dir = await mkdtemp(path.join(tmpdir(), 'clam-workspace-gaps-'));
  const runtime = await createClamApp({ databasePath: ':memory:', agent, config: {
    inboxLive: false, tracesDir: path.join(dir, 'traces'), mailAttachmentsDir: path.join(dir, 'workspace', 'mail-attachments'),
  } });
  try { await work(runtime, await runtime.app.listen({ port: 0, host: '127.0.0.1' })); }
  finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
}

async function until<T>(read: () => T, done: (value: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error('Timed out: ' + JSON.stringify(value).slice(0, 500));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const createAgent = async (runtime: Runtime, instruction: string) => {
  const response = await runtime.app.inject({ method: 'POST', url: '/api/inbox/platform/agents', payload: { instruction } });
  expect(response.statusCode).toBe(200);
  return response.json() as { agent_id: string; plan_summary: { template: string; planner: string } };
};

it('plans with the LLM when available, drops model-invented recipients, and falls back to the deterministic compiler', async () => {
  const replies = [
    JSON.stringify({ template: 'vendor_rfq', schedule_mode: 'one_shot', name: 'Mug Quotes', vendors: ['alice@supply.example', 'evil@attacker.example'],
      item: '200 ceramic mugs', quantity: 200, book: null, keywords: null }),
    'I think you should email some vendors!',
  ];
  const prompts: string[] = [];
  const model: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      prompts.push(JSON.parse(body).prompt);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ response: replies.shift() ?? '{}' }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (model.address() as { port: number }).port;
  try {
    await runtimeTest(async (runtime) => {
      const instruction = 'Ping alice@supply.example and bob@mugs.example about pricing for 200 ceramic mugs and put everything side by side.';
      const planned = await createAgent(runtime, instruction);
      expect(planned.plan_summary).toMatchObject({ template: 'vendor_rfq', planner: 'llm-planner' });
      const agent = runtime.platform.agent(planned.agent_id)!;
      expect(agent.name).toBe('Mug Quotes');
      // The model invented evil@attacker.example; only addresses the user typed survive.
      expect(agent.workflow_plan.params).toMatchObject({ vendors: ['alice@supply.example'], item: '200 ceramic mugs', quantity: 200 });
      expect(agent.workflow_plan.steps.some((step) => step.id === 'booking')).toBe(false);
      expect(prompts[0]).toContain(JSON.stringify(instruction));

      const fallback = await createAgent(runtime, 'Log my invoices into a Google Sheet every day');
      expect(fallback.plan_summary).toMatchObject({ template: 'invoice_ledger', planner: 'deterministic-intent-compiler' });
      const compileLog = runtime.platform.logs(user, { agentId: fallback.agent_id, service: 'system' }).find((entry) => entry.action_name === 'compile_plan')!;
      expect(compileLog).toMatchObject({ policy_rule_id: 'PLAN_FALLBACK_DETERMINISTIC' });
      expect(compileLog.output_summary).toContain('PLANNER_OUTPUT_INVALID');
    }, { mode: 'llm', provider: 'ollama', model: 'fake-planner', endpoint, timeoutMs: 5000, rates: { input: 0, output: 0 } });
  } finally {
    model.close();
  }
}, 60_000);

it('restores an overwritten Drive file from its verified backup on rollback', () => runtimeTest(async (runtime, base) => {
  const minted = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox', scopes: ['workspace:write'] } });
  const client = new Client({ name: 'cline', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + minted.json().token } } }));
  const save = async (text: string) => payload(await client.callTool({ name: 'drive_save_file', arguments: {
    folder_path: ['Clam', 'Notes'], file_name: 'notes.md', mime_type: 'text/markdown', content_text: text } }));
  const first = await save('# Version one\n');
  const second = await save('# Version two\n');
  expect(second).toMatchObject({ verified: true });
  const preview = async () => (await runtime.app.inject('/api/inbox/platform/artifacts/' + first.file.artifact_id)).json().preview.text_preview;
  expect(await preview()).toBe('# Version two\n');
  const rollback = await runtime.app.inject({ method: 'POST', url: `/api/inbox/runs/${second.run_id}/rollback`, payload: { wait: true } });
  expect(rollback.json().run.status).toBe('COMPLETED');
  expect(await preview()).toBe('# Version one\n');
  expect(runtime.platform.registry.byId(first.file.artifact_id)!.removed_at).toBeNull();
  await client.close();
}), 60_000);

it('treats an expired approval as declined so a waiting agent never hangs', () => runtimeTest(async (runtime) => {
  const { agent_id } = await createAgent(runtime, 'Email these 4 vendors for quotes on 500 custom boxes and compare them in a Sheet.');
  const waiting = await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.status === 'input_required');
  const approval = runtime.inbox.store.approval(waiting.state.pending_approvals[0])!;
  runtime.inbox.store.updateApproval({ ...approval, expires_at: new Date(Date.now() - 1000).toISOString() });
  await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.status === 'completed');
  expect(runtime.inbox.store.approval(approval.approval_id)!.status).toBe('EXPIRED');
  expect(runtime.platform.logs(user, { agentId: agent_id }).find((entry) => entry.action_name === 'rfq_batch_declined')!.output_summary).toContain('expired');
  expect(runtime.inbox.store.sqlite.prepare("SELECT count(*) AS n FROM inbox_actions WHERE kind='send'").get()).toEqual({ n: 0 });
}), 60_000);

it('waits for missing vendor replies until the requested quote window closes', () => runtimeTest(async (runtime) => {
  const { agent_id } = await createAgent(runtime, 'Email these 4 vendors for quotes on 500 custom boxes, wait up to 2 hours for replies, and compare them in a Sheet.');
  expect(runtime.platform.agent(agent_id)!.workflow_plan.params.quote_wait_hours).toBe(2);
  const waiting = await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.status === 'input_required');
  await runtime.app.inject({ method: 'POST', url: '/api/inbox/approvals/' + waiting.state.pending_approvals[0], payload: { approve: true } });
  const pending = await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.state.phase === 'awaiting_quotes' && (agent.state.notes ?? []).length > 0);
  expect(pending.state.notes![0]).toMatch(/^Waiting for 1 of 4 vendor replies until /);
  expect(Date.parse(pending.next_run_at!)).toBeGreaterThan(Date.now() + 60_000);
  expect(runtime.platform.artifacts(user, agent_id)).toHaveLength(0);
  // Close the window: the agent proceeds with the three replies it has.
  runtime.platform.updateAgent(agent_id, { next_run_at: new Date().toISOString(),
    state: { ...pending.state, phase_started_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
  await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.status === 'completed');
  expect(runtime.platform.artifacts(user, agent_id).map((row) => row.service).sort()).toEqual(['google_doc', 'google_sheet']);
}), 60_000);

it('parses labelled and OCR-style receipt text', () => {
  expect(parseReceiptText('Merchant: City Parking Authority\nTicket: PK-55821\nDate: 2026-12-06\nTotal: 32.00 USD\nPay by: 2026-12-20'))
    .toEqual({ merchant: 'City Parking Authority', reference: 'PK-55821', date: '2026-12-06', amount: 32, currency: 'USD', due: '2026-12-20' });
  expect(parseReceiptText('CORNER PHARMACY\nReceipt # RX-7781\nDate 12/03/2026\nJOTAL $23.45\nTax $1.20\nPay by 12/18/2026'))
    .toMatchObject({ merchant: 'CORNER PHARMACY', reference: 'RX-7781', date: '2026-12-03', amount: 23.45, currency: 'USD', due: '2026-12-18' });
  expect(parseReceiptText('Receipt for lunch').reference).toBeUndefined();
});

it.skipIf(!hasTesseract)('OCRs a raster receipt photo in the bounded parser without leaking image bytes', async () => {
  const data = await readFile(path.resolve('tests/fixtures/receipt-pharmacy.png'));
  const adapter = { photoBytes: async () => ({ data, item: { id: 'p1', filename: 'IMG_9001.png', mimeType: 'image/png', category: 'RECEIPTS',
    creationTime: '2026-12-03T10:00:00Z', description: '', productUrl: null } }) } as unknown as WorkspaceAdapter;
  const details = await extractPhotoDetails(adapter, 'p1');
  expect(details).toMatchObject({ extraction: 'ocr', quarantined: false,
    fields: { merchant: 'CORNER PHARMACY', amount: 23.45, currency: 'USD', date: '2026-12-03', due: '2026-12-18', reference: 'RX-7781' } });
  expect(JSON.stringify(details)).not.toContain(data.toString('base64').slice(0, 40));
}, 30_000);
