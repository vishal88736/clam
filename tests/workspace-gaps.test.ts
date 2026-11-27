import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { sandboxMcpOwner as user } from '../apps/server/src/auth/google.js';
import type { AgentConfig } from '../apps/server/src/inbox/agentConfig.js';
import { planFromProgram } from '../apps/server/src/platform/planner.js';
import { genericStepSchema } from '../apps/server/src/platform/generic.js';
import { extractPhotoDetails, parseReceiptText } from '../apps/server/src/workspace/photos.js';
import type { WorkspaceAdapter } from '../apps/server/src/workspace/types.js';

type Runtime = Awaited<ReturnType<typeof createSiftvaneApp>>;
const payload = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);
const hasTesseract = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function runtimeTest(work: (runtime: Runtime, base: string) => Promise<void>, agent?: AgentConfig) {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-workspace-gaps-'));
  const runtime = await createSiftvaneApp({ databasePath: ':memory:', agent, config: {
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
    JSON.stringify({ reasoning: 'The user wants supplier pricing compared; the vendor RFQ workflow fits.', name: 'Mug Quotes', schedule_mode: 'one_shot',
      workflow: { template: 'vendor_rfq', vendors: ['alice@supply.example', 'evil@attacker.example'], item: '200 ceramic mugs', quantity: 200, book: null } }),
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
      expect(agent.workflow_plan.params.reasoning).toContain('vendor RFQ workflow fits');
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
    folder_path: ['Siftvane', 'Notes'], file_name: 'notes.md', mime_type: 'text/markdown', content_text: text } }));
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

it('closes a quote window with no usable replies and leaves booking untouched', () => runtimeTest(async (runtime) => {
  const { agent_id } = await createAgent(runtime, 'Email 4 vendors for quotes on 500 custom boxes, compare them, and book the cheapest.');
  const waiting = await until(() => runtime.platform.agent(agent_id)!, (agent) => agent.status === 'input_required');
  runtime.inbox.store.sqlite.prepare("DELETE FROM inbox_sandbox_messages WHERE scope='vendor_pending'").run();
  await runtime.app.inject({ method: 'POST', url: '/api/inbox/approvals/' + waiting.state.pending_approvals[0], payload: { approve: true } });
  const agent = await until(() => runtime.platform.agent(agent_id)!, (entry) => entry.status === 'completed');
  expect(agent).toMatchObject({ next_run_at: null, state: { phase: 'no_usable_quotes', pending_approvals: [] } });
  expect(agent.state.notes).toContain('The quote window closed without a usable price.');
  expect(runtime.platform.artifacts(user, agent_id)).toHaveLength(0);
}), 60_000);

it('keeps an agent paused when a required workspace action is blocked', () => runtimeTest(async (runtime) => {
  const instruction = 'Put order emails in a sheet';
  const steps = [
    genericStepSchema.parse({ id: 'source', op: 'mail.search', keywords: ['order'] }),
    genericStepSchema.parse({ id: 'sheet', op: 'sheets.append', from: 'source', title: 'Orders', columns: ['='] }),
  ];
  const compiled = planFromProgram({ program: steps, name: 'Blocked sheet', scheduleMode: 'one_shot' }, instruction, 'deterministic-intent-compiler');
  const agent = runtime.platform.createAgent({ userId: user, inboxId: 'sandbox', name: compiled.name, goal: instruction, sourceCli: 'web',
    plan: compiled.plan, services: compiled.services, scheduleMode: 'one_shot', intervalSeconds: null });
  const stopped = await until(() => runtime.platform.agent(agent.id)!, (entry) => entry.status === 'paused');
  expect(stopped.state.last_error).toBe('WORKSPACE_FORMULA_INJECTION');
  expect(runtime.inbox.store.run(stopped.state.last_run_id!)).toMatchObject({ status: 'FAILED', error: 'WORKSPACE_FORMULA_INJECTION' });
  expect(runtime.platform.artifacts(user, agent.id)).toHaveLength(0);
}));

it('keeps pause and cancel decisions after a worker finishes and cancels pending approvals', () => runtimeTest(async (runtime) => {
  const { agent_id: draftId } = await createAgent(runtime, 'Draft replies to everyone who emailed me about meetings.');
  const waiting = await until(() => runtime.platform.agent(draftId)!, (entry) => entry.status === 'input_required');
  const cancelled = await runtime.app.inject({ method: 'POST', url: `/api/inbox/platform/agents/${draftId}/cancel` });
  expect(cancelled.json()).toMatchObject({ status: 'archived', next_run_at: null });
  expect(waiting.state.pending_approvals.map((id) => runtime.inbox.store.approval(id)?.status)).toEqual(['REJECTED', 'REJECTED']);

  const workspace = runtime.inbox.workspace('sandbox');
  const originalRead = workspace.read.bind(workspace);
  let release!: () => void;
  const waitingRead = new Promise<void>((resolve) => { release = resolve; });
  workspace.read = async (key) => {
    if (key.includes('/doc:')) await waitingRead;
    return originalRead(key);
  };
  try {
    const { agent_id } = await createAgent(runtime, 'Summarize order emails in a Doc.');
    const running = await until(() => runtime.platform.agent(agent_id)!, (entry) => Boolean(entry.state.running_run_id));
    const paused = await runtime.app.inject({ method: 'POST', url: `/api/inbox/platform/agents/${agent_id}/pause` });
    expect(paused.json()).toMatchObject({ status: 'paused', next_run_at: null });
    release();
    const stopped = await until(() => runtime.platform.agent(agent_id)!, (entry) => !entry.state.running_run_id);
    expect(stopped).toMatchObject({ run_count: 1, status: 'paused', next_run_at: null });
    expect(runtime.inbox.store.run(running.state.running_run_id!)).toMatchObject({ status: 'FAILED', error: 'AGENT_RUN_PAUSED' });
    expect(runtime.platform.artifacts(user, agent_id)).toHaveLength(0);
  } finally {
    release();
    workspace.read = originalRead;
  }
}));

it('keeps a due agent scheduled when another worker holds the lease and surfaces abandoned claims', () => runtimeTest(async (runtime) => {
  expect(runtime.inbox.store.acquireLease('other-worker')).toBe(true);
  const { agent_id } = await createAgent(runtime, 'Summarize order emails in a Doc.');
  try {
    await expect(runtime.missions.runAgent(agent_id)).rejects.toThrow('RUN_ALREADY_ACTIVE');
    expect(runtime.platform.agent(agent_id)).toMatchObject({ status: 'active', run_count: 0, next_run_at: expect.any(String) });
    expect(runtime.platform.claimDueAgent(agent_id, 'lost-run')).not.toBeNull();
    expect(runtime.platform.claimDueAgent(agent_id, 'duplicate-claim')).toBeNull();
  } finally {
    runtime.inbox.store.releaseLease('other-worker');
  }
  runtime.platform.recoverAgentRuns(Date.now() + 16_000);
  expect(runtime.platform.agent(agent_id)).toMatchObject({
    status: 'paused', run_count: 1, next_run_at: null,
    state: { running_run_id: null, last_run_id: 'lost-run', last_error: 'AGENT_RUN_INTERRUPTED' },
  });
  expect(runtime.inbox.store.acquireLease('legacy-worker')).toBe(true);
  const legacy = await createAgent(runtime, 'Summarize shipment emails in a Doc.');
  try {
    runtime.platform.updateAgent(legacy.agent_id, { next_run_at: null, run_count: 1,
      last_run_at: new Date(Date.now() - 60_000).toISOString() });
  } finally {
    runtime.inbox.store.releaseLease('legacy-worker');
  }
  runtime.platform.recoverAgentRuns();
  expect(runtime.platform.agent(legacy.agent_id)).toMatchObject({ status: 'paused', state: { last_error: 'AGENT_RUN_INTERRUPTED' } });
}));

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

const generic = (runtime: Runtime, agentId: string) => runtime.platform.agent(agentId)!;
const sheetRows = (runtime: Runtime, title: string) => {
  const row = runtime.platform.artifacts(user).find((item) => item.title === title)!;
  return (runtime.inbox.store.entity('sandbox', 'workspace', row.logical_key) as { tabs: { headers: string[]; rows: unknown[][] }[] }).tabs[0];
};

it('composes any request offline into a general program across Gmail, Sheets, labels, and Calendar', () => runtimeTest(async (runtime) => {
  const { agent_id, plan_summary } = await createAgent(runtime,
    'Find emails about the launch, put them in a tracker sheet, label them, and remind me of any deadlines on my calendar.');
  expect(plan_summary).toMatchObject({ template: 'generic', planner: 'deterministic-intent-compiler' });
  const agent = await until(() => generic(runtime, agent_id), (entry) => entry.status === 'completed');
  expect(agent.workflow_plan.params.program!.map((entry) => entry.op)).toEqual(['mail.search', 'sheets.append', 'mail.label', 'calendar.reminders']);
  const tab = sheetRows(runtime, 'Siftvane - Launch');
  expect(tab.headers).toEqual(['Date', 'From', 'Subject', 'Deadline', 'Source ID']);
  expect(tab.rows.map((row) => row[3]).sort()).toEqual(['2026-12-10', '2026-12-11']);
  for (const id of ['deadline-a', 'deadline-b']) {
    expect((runtime.inbox.store.entity('sandbox', 'mail', id) as { labels: string[] }).labels).toContain('SIFTVANE_LAUNCH');
  }
  const reminders = runtime.inbox.store.entities<{ id: string; start: string }>('sandbox', 'calendar').filter((event) => event.id.startsWith('siftvane-reminder-'));
  expect(reminders.map((event) => event.start).sort()).toEqual(['2026-12-10T09:00:00.000Z', '2026-12-11T09:00:00.000Z']);
  const logs = runtime.platform.logs(user, { agentId: agent_id });
  expect(new Set(logs.map((entry) => entry.service))).toEqual(new Set(['system', 'gmail', 'sheets', 'calendar']));
}), 60_000);

it('drafts replies for a free-form request and holds every draft for approval', () => runtimeTest(async (runtime) => {
  const { agent_id } = await createAgent(runtime, 'Draft replies to everyone who emailed me about meetings.');
  const agent = await until(() => generic(runtime, agent_id), (entry) => entry.status === 'input_required');
  const drafts = agent.state.pending_approvals.map((id) => runtime.inbox.store.approval(id)!);
  expect(drafts.map((item) => item.proposed_action.effectiveContact).sort()).toEqual(['new@outside.example', 'sam@team.example']);
  expect(drafts.every((item) => item.triggered_rule_id === 'AGENT_REPLY_APPROVAL' && item.proposed_action.kind === 'draft')).toBe(true);
  expect(runtime.inbox.store.sqlite.prepare("SELECT count(*) AS n FROM inbox_actions WHERE kind='draft'").get()).toEqual({ n: 0 });
}), 60_000);

it('lets the LLM think: it composes its own program, reviews sanitized results, and adds steps under the same gates', async () => {
  const prompts: string[] = [];
  const replies = [
    JSON.stringify({ reasoning: 'Look for order and delivery mail, track it in a sheet, then tell Sam.', name: 'Order Watch', schedule_mode: 'one_shot',
      program: [
        { id: 'orders', op: 'mail.search', keywords: ['order'] },
        { id: 'sheet', op: 'sheets.append', from: 'orders', title: 'Order Tracker', columns: ['Date', 'Order', 'Status', 'Return by'] },
        { id: 'tell', op: 'mail.send', to: ['sam@team.example', 'attacker@evil.example'], subject: 'Order update', body: '{{count}} order emails tracked.', from: 'orders' },
      ] }),
    JSON.stringify({ reasoning: 'One order has a return deadline; add a reminder.', done: false,
      steps: [{ id: 'returns', op: 'filter', from: 'orders', field: 'return_by', exists: true },
        { id: 'remind', op: 'calendar.reminders', from: 'returns', date_field: 'return_by', title: 'Return window closes for {{order}}' }] }),
    JSON.stringify({ reasoning: 'Everything requested is done.', done: true }),
  ];
  const model: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { prompts.push(JSON.parse(body).prompt); response.end(JSON.stringify({
      response: replies.shift() ?? '{}', model: 'fake-planner', prompt_eval_count: 250, eval_count: 35,
    })); });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  try {
    await runtimeTest(async (runtime) => {
      const { agent_id, plan_summary } = await createAgent(runtime, 'Keep an eye on my orders in a sheet and email sam@team.example an update.');
      expect(plan_summary).toMatchObject({ template: 'generic', planner: 'llm-planner' });
      const agent = await until(() => generic(runtime, agent_id), (entry) => entry.status === 'completed');
      // The model-injected recipient never reaches the plan.
      expect(agent.workflow_plan.params.program!.find((entry) => entry.op === 'mail.send')).toMatchObject({ to: ['sam@team.example'] });
      expect(agent.workflow_plan.params.program!.map((entry) => entry.id)).toEqual(['orders', 'sheet', 'tell', 'returns', 'remind']);
      expect(sheetRows(runtime, 'Order Tracker').rows.map((row) => row[2]).sort()).toEqual(['confirmed', 'delivered', 'shipped']);
      const reminder = runtime.inbox.store.entities<{ id: string; title: string; start: string }>('sandbox', 'calendar').find((event) => event.id.startsWith('siftvane-reminder-'))!;
      expect(reminder).toMatchObject({ title: 'Return window closes for ORDER-500', start: '2026-12-21T09:00:00.000Z' });
      // sam@team.example is allowlisted, so the update was sent autonomously with disclosure.
      const sent = runtime.inbox.store.entities<{ to: string; headers: Record<string, string> }>('sandbox', 'review').filter((entry) => entry?.headers);
      expect(sent).toEqual([expect.objectContaining({ to: 'sam@team.example', headers: { 'X-Agent-Automated': 'true' } })]);
      const reviews = runtime.platform.logs(user, { agentId: agent_id, service: 'system' }).filter((entry) => entry.action_name === 'llm_review');
      expect(reviews.map((entry) => entry.output_summary)).toEqual(['Everything requested is done. → done', 'One order has a return deadline; add a reminder. → 2 more step(s)']);
      const liveRun = runtime.inbox.store.run(agent.state.last_run_id!)!;
      expect(liveRun.model_usage).toMatchObject({ provider: 'ollama', prompt_tokens: 750, completion_tokens: 105, estimated_usd: 0 });
      expect(runtime.inbox.store.trace(liveRun.id).steps.filter((step) => step.detail.event === 'AGENT_MODEL_CALL')
        .map((step) => step.detail.phase)).toEqual(['planning', 'review', 'review']);
      // Review prompts carry sanitized observations, not raw email bodies.
      expect(prompts[1]).toContain('"step":"orders"');
      expect(prompts[1]).not.toContain('Return by: 2026-12-21\\nStatus');
    }, { mode: 'llm', provider: 'ollama', model: 'fake-planner', endpoint: 'http://127.0.0.1:' + (model.address() as { port: number }).port,
      timeoutMs: 5000, rates: { input: 0, output: 0 } });
  } finally {
    model.close();
  }
}, 60_000);

it('validates the full plan before review can execute a new step', async () => {
  const program = [{ id: 'orders', op: 'mail.search', keywords: ['order'] },
    ...Array.from({ length: 14 }, (_, index) => ({ id: 'filter_' + index, op: 'filter', from: 'orders', field: 'subject', exists: true }))];
  const replies = [
    { reasoning: 'Check the order messages.', program },
    { reasoning: 'Create another folder.', done: false, steps: [{ id: 'output', op: 'drive.folder', path: ['Overflow'] }] },
  ];
  const model = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.end(JSON.stringify({ response: JSON.stringify(replies.shift()) })));
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  try {
    await runtimeTest(async (runtime) => {
      const { agent_id } = await createAgent(runtime, 'Check order emails.');
      const agent = await until(() => generic(runtime, agent_id), (entry) => entry.status === 'completed');
      expect(agent.workflow_plan.params.program).toHaveLength(15);
      expect(runtime.platform.artifacts(user, agent_id)).toHaveLength(0);
      expect(runtime.platform.logs(user, { agentId: agent_id }).find((entry) => entry.action_name === 'llm_review')?.output_summary)
        .toContain('combined plan failed validation or exceeded the step limit');
    }, { mode: 'llm', provider: 'ollama', model: 'fake-planner', endpoint: 'http://127.0.0.1:' + (model.address() as { port: number }).port,
      timeoutMs: 5000, rates: { input: 0, output: 0 } });
  } finally { model.close(); }
});

it('keeps model review steps inside the originating MCP token scopes', async () => {
  const replies = [
    { reasoning: 'Find orders first.', program: [{ id: 'orders', op: 'mail.search', keywords: ['order'] }] },
    { reasoning: 'Label the matching mail and count the items.', done: false, steps: [
      { id: 'label', op: 'mail.label', from: 'orders', label: 'SIFTVANE_ORDERS' },
      { id: 'summary', op: 'summarize', from: 'orders' },
    ] },
    { reasoning: 'Review finished.', done: true },
  ];
  const model = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.end(JSON.stringify({ response: JSON.stringify(replies.shift()) })));
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  try {
    await runtimeTest(async (runtime, base) => {
      const scopes = ['agent:manage', 'mail:read'];
      const minted = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox', scopes } });
      expect(minted.statusCode).toBe(200);
      const client = new Client({ name: 'cline', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + minted.json().token } },
      }));
      try {
        const result = payload(await client.callTool({ name: 'provision_and_run_agent', arguments: {
          user_instruction: 'Summarize order emails', wait_seconds: 15,
        } }));
        expect(result).toMatchObject({ status: 'completed', plan_summary: { planner: 'llm-planner' } });
        const agent = generic(runtime, result.agent_id);
        expect(agent.workflow_plan.params.mcp_scopes).toEqual(expect.arrayContaining(scopes));
        expect(agent.workflow_plan.params.program!.map((step) => step.id)).toEqual(['orders', 'summary']);
        const log = runtime.platform.logs(user, { agentId: agent.id, service: 'policy' });
        expect(log).toContainEqual(expect.objectContaining({ action_name: 'review_step_rejected', policy_rule_id: 'MCP_SCOPE_REQUIRED' }));
        expect(runtime.inbox.store.sqlite.prepare("SELECT count(*) AS n FROM inbox_actions WHERE kind='mail'").get()).toEqual({ n: 0 });
      } finally {
        await client.close();
      }
    }, { mode: 'llm', provider: 'ollama', model: 'fake-planner', endpoint: 'http://127.0.0.1:' + (model.address() as { port: number }).port,
      timeoutMs: 5000, rates: { input: 0, output: 0 } });
  } finally {
    model.close();
  }
}, 60_000);

it('repairs real model mistakes and drops ungrounded senders, time windows, and placeholder recipients', async () => {
  const { repairProgram } = await import('../apps/server/src/platform/generic.js');
  // Verbatim shapes produced by qwen2.5:7b during evaluation.
  const { steps, issues } = repairProgram([
    { id: 'search_emails', op: 'mail.search', keywords: ['order', 'delivery'], from_contains: 'example.com', newer_than_days: 30, include_attachments: false, limit: 100 },
    { id: 'create_tracker_sheet', op: 'sheets.append', from: 'search_emails', title: 'Tracker', tab: true, columns: ['From', 'Subject', 'Date', 'Deadline'] },
    { id: 'label_emails', op: 'mail.label', from: 'search_emails', label: 'SIFTVANE_UPPER_SNAKE' },
    { id: 'add_calendar_reminders', op: 'calendar.reminders', from: 'search_emails', date_field: 'Deadline', title: 'Due', time_utc: true },
    { id: 'write_doc', op: 'docs.write', title: 'Summary', heading: 'Summary', content: '{{summary}}', folder: 'Summary Docs', mode: 'overwrite' },
    { id: 'send_email', op: 'mail.send', to: ['sam@team.example', 'user_email'], subject: 'Summary', body: 'Done', from: 'siftvane@example.com' },
    { id: 'approval', op: 'mail.send', to: ['user_email'], subject: 'x', body: 'y' },
    { id: 'mystery', op: 'shell.exec', command: 'rm -rf /' },
  ], 'Summarize my order and delivery emails into a doc, track them, and email sam@team.example');
  expect(steps.find((step) => step.op === 'mail.search')).toEqual({ id: 'search_emails', op: 'mail.search', keywords: ['order', 'delivery'],
    include_attachments: false, limit: 50 });
  expect(steps.find((step) => step.op === 'sheets.append')).toMatchObject({ tab: 'Rows' });
  expect(steps.find((step) => step.op === 'mail.label')).toMatchObject({ label: 'SIFTVANE_ORDER' });
  expect(steps.find((step) => step.op === 'calendar.reminders')).toMatchObject({ date_field: 'deadline', time_utc: '09:00' });
  expect(steps.find((step) => step.op === 'docs.write')).toMatchObject({ folder: ['Summary Docs'], mode: 'replace_section' });
  expect(steps.filter((step) => step.op === 'mail.send')).toEqual([{ id: 'send_email', op: 'mail.send', to: ['sam@team.example'], subject: 'Summary', body: 'Done' }]);
  expect(issues).toEqual(['step "approval": mail.send needs a recipient the user wrote; removed', 'step 8: unknown op "shell.exec"']);
});

it('repairs data flow: recipients are not senders, attachments come from mail, and {{summary}} gets a summarize step', async () => {
  const { repairProgram } = await import('../apps/server/src/platform/generic.js');
  // Verbatim shapes from the second qwen2.5:7b evaluation.
  const { steps } = repairProgram([
    { id: 'search_orders', op: 'mail.search', keywords: ['order'], from_contains: 'sam@team.example' },
    { id: 'search_emails', op: 'mail.search', keywords: ['billing', 'invoice'], include_attachments: true },
    { id: 'extract_pdfs', op: 'photos.extract', category: 'DOCUMENTS' },
    { id: 'save_attachments', op: 'drive.save_attachments', from: 'extract_pdfs', folder: ['Invoices'] },
    { id: 'send_summary', op: 'mail.send', to: ['sam@team.example'], subject: 'Summary', body: '{{summary}}' },
  ], 'Make a doc summarizing my order emails, save invoice PDFs, then email it to sam@team.example');
  expect(steps.find((step) => step.id === 'search_orders')).not.toHaveProperty('from_contains');
  expect(steps.find((step) => step.id === 'save_attachments')).toMatchObject({ from: 'search_emails' });
  expect(steps.map((step) => step.id)).toEqual(['search_orders', 'search_emails', 'extract_pdfs', 'save_attachments', 'summary_for_send_summary', 'send_summary']);
  expect(repairProgram([{ id: 'a', op: 'mail.search', keywords: ['x'], from_contains: 'billing@aws.example' }],
    'Track invoices from billing@aws.example').steps[0]).toMatchObject({ from_contains: 'billing@aws.example' });
});
