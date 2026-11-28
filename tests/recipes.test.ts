import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import type { AgentConfig } from '../apps/server/src/inbox/agentConfig.js';
import { fakeModel } from './support/fakeModel.js';

/** The program an AI writes for "track billing emails with amount and due date in a sheet, and label them". */
const billingPlan = { reasoning: 'Find billing mail, log amount and due date, and label it.', name: 'Billing Tracker', schedule_mode: 'one_shot', program: [
  { id: 'mail', op: 'mail.search', keywords: ['billing'] },
  { id: 'sheet', op: 'sheets.append', from: 'mail', title: 'Billing Tracker', columns: ['Date', 'From', 'Subject', 'Amount', 'Due'] },
  { id: 'label', op: 'mail.label', from: 'mail', label: 'SIFTVANE_BILLING' },
] };

async function withAi(plan: unknown, work: (runtime: Runtime, base: string) => Promise<void>) {
  const model = await fakeModel(plan);
  try { await runtimeTest(work, model.agent); } finally { await model.close(); }
}
import { sandboxMcpOwner as user } from '../apps/server/src/auth/google.js';
import { genericProgramSchema } from '../apps/server/src/platform/generic.js';
import { analyzeBindings, decide, evaluateFormula, parseFormula } from '../apps/server/src/platform/recipes.js';

type Runtime = Awaited<ReturnType<typeof createSiftvaneApp>>;
const payload = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);

async function runtimeTest(work: (runtime: Runtime, base: string) => Promise<void>, agent?: AgentConfig) {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-recipes-'));
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

const api = async (runtime: Runtime, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
  const response = await runtime.app.inject({ method, url: '/api/inbox/platform/' + url, payload: payload as object });
  return { status: response.statusCode, body: response.json() };
};
const sheetRows = (runtime: Runtime, title: string) => {
  const row = runtime.inbox.store.sqlite.prepare("SELECT logical_key FROM workspace_artifacts WHERE service='google_sheet' AND title=?").get(title) as { logical_key: string };
  const sheet = runtime.inbox.store.entity('sandbox', 'workspace', row.logical_key) as { tabs: { headers: string[]; rows: unknown[][] }[] };
  return sheet.tabs[0];
};

it('evaluates recipe formulas and rules without a model', () => {
  const row = { fields: { amount: 120, due: '2026-12-20', vendor: 'Figma', price: '45.00 USD' } as Record<string, string | number> };
  expect(evaluateFormula(parseFormula('round(amount * 0.5, 2)'), row)).toBe(60);
  expect(evaluateFormula(parseFormula('price + 5'), row)).toBe(50);
  expect(evaluateFormula(parseFormula('"Net 30"'), row)).toBe('Net 30');
  expect(evaluateFormula(parseFormula('missing_field * 2'), row)).toBeUndefined();
  expect(() => parseFormula('amount; process.exit()')).toThrow('RECIPE_FORMULA_INVALID');
  expect(() => parseFormula('constructor(1)')).toThrow('RECIPE_FORMULA_INVALID');
  const spec = { computed: [{ name: 'refund', expr: 'amount * 0.5' }], rules: [
    { field: 'refund', op: '>' as const, value: '50', then: 'approve' as const },
    { field: 'vendor', op: 'contains' as const, value: 'spam', then: 'skip' as const },
  ] };
  expect(decide(spec, { fields: { ...row.fields } })).toMatchObject({ decision: 'approve' });
  expect(decide(spec, { fields: { amount: 40, vendor: 'Spam Co' } })).toMatchObject({ decision: 'skip' });
  expect(decide(spec, { fields: { amount: 40, vendor: 'Figma' } })).toMatchObject({ decision: 'run' });
  // A rule that cannot be evaluated never guesses: the email goes to an agent.
  expect(decide(spec, { fields: { vendor: 'Figma' } })).toMatchObject({ decision: 'agent' });
});

it('traces every argument and turns what it cannot prove into a question', () => {
  const program = genericProgramSchema.parse([
    { id: 'mail', op: 'mail.search', keywords: ['refund'] },
    { id: 'sheet', op: 'sheets.append', from: 'mail', title: 'Refunds', columns: ['Date', 'Vendor', 'Refund', 'Status'] },
    { id: 'reply', op: 'mail.draft_replies', from: 'mail', subject: 'Re: {{subject}}', body: 'We refunded {{refund}} on {{date}}.' },
  ]);
  const observed = ['date', 'from', 'subject', 'message_id', 'merchant', 'price'];
  const before = analyzeBindings(program, 'mail', observed, []);
  // No business vocabulary is built in: "Vendor" is not assumed to be the "merchant" field, so the recipe asks.
  expect(before.find((binding) => binding.name === 'vendor')).toMatchObject({ kind: 'ask' });
  expect(before.filter((binding) => binding.kind === 'ask').map((binding) => binding.name).sort()).toEqual(['refund', 'refund', 'status', 'vendor']);
  expect(before.find((binding) => binding.arg === 'to')).toMatchObject({ kind: 'request', field: 'from' });
  const after = analyzeBindings(program, 'mail', observed, [{ name: 'refund', expr: 'price * 0.5' }, { name: 'status', expr: '"Refunded"' },
    { name: 'vendor', expr: 'merchant' }]);
  expect(after.filter((binding) => binding.kind === 'ask')).toEqual([]);
  expect(after.find((binding) => binding.name === 'refund')).toMatchObject({ kind: 'formula', detail: 'Refund = price * 0.5' });
});

it('learns a recipe from an agent, backtests it, gates risky mail for approval, and replays new mail with zero model calls', () => withAi(billingPlan, async (runtime, base) => {
  const created = await api(runtime, 'POST', 'agents', { instruction: 'Find billing emails, put them in a tracker sheet with the amount and due date, and label them.' });
  expect(created.status).toBe(200);
  const agentId = created.body.agent_id as string;
  const agent = await until(() => runtime.platform.agent(agentId)!, (entry) => entry.status === 'completed');
  expect(agent.workflow_plan.params.program!.map((step) => step.op)).toEqual(['mail.search', 'sheets.append', 'mail.label']);
  expect(agent.state.observed?.message_ids.length).toBeGreaterThan(0);
  const sheetTitle = agent.workflow_plan.params.program!.find((step) => step.op === 'sheets.append')!.title as string;
  const before = sheetRows(runtime, sheetTitle).rows.length;

  const learnable = await api(runtime, 'GET', 'recipes');
  expect(learnable.body.learnable.find((entry: { agent_id: string }) => entry.agent_id === agentId)).toMatchObject({ ready: true });
  const learned = await api(runtime, 'POST', 'recipes', { agent_id: agentId, name: 'Billing tracker' });
  expect(learned.status).toBe(200);
  const recipe = learned.body.recipe;
  expect(recipe).toMatchObject({ status: 'draft', ready: false, trigger: { step: 'mail' } });
  // Every argument is traced; amount and due come straight from the email.
  const columns = recipe.steps.find((step: { op: string }) => step.op === 'sheets.append').bindings.filter((binding: { arg: string }) => binding.arg === 'column');
  expect(columns.find((binding: { name: string }) => binding.name === 'amount')).toMatchObject({ kind: 'request', field: 'amount' });
  expect(columns.find((binding: { name: string }) => binding.name === 'due')).toMatchObject({ kind: 'request' });
  expect(recipe.blockers).toContain('Run a backtest on this version');
  // Safe default: emails from senders that fail authentication ask first.
  expect(recipe.rules).toEqual([{ field: 'sender_verified', op: '=', value: 'no', then: 'approve' }]);

  // Enabling before a backtest is refused.
  expect((await api(runtime, 'POST', `recipes/${recipe.id}/enable`)).body.error).toBe('RECIPE_NOT_READY');

  const ruled = await api(runtime, 'PATCH', `recipes/${recipe.id}`, { rules: [...recipe.rules, { field: 'amount', op: '>', value: '100', then: 'approve' }],
    computed: [{ name: 'half', expr: 'round(amount / 2, 2)' }] });
  expect(ruled.status).toBe(200);
  expect(ruled.body.recipe.version).toBe(2);
  expect((await api(runtime, 'PATCH', `recipes/${recipe.id}`, { computed: [{ name: 'x', expr: 'nope * 2' }] })).body.error).toBe('RECIPE_FORMULA_UNKNOWN_FIELD');

  const tested = await api(runtime, 'POST', `recipes/${recipe.id}/backtest`);
  expect(tested.status).toBe(200);
  const backtest = tested.body.recipe.backtest;
  expect(backtest).toMatchObject({ version: 2, tokens: 0 });
  expect(backtest.rows.length).toBeGreaterThan(0);
  expect(backtest.counts.approve).toBeGreaterThan(0);
  expect(backtest.rows.find((row: { decision: string }) => row.decision === 'run').actions.join(' ')).toContain('Label SIFTVANE_BILLING');
  expect(backtest.agreement.agent_handled).toBe(agent.state.observed!.message_ids.length);
  // The look-alike-domain invoice with new bank details is held by the default sender rule.
  expect(backtest.rows.find((row: { subject: string }) => row.subject.includes('updated bank details'))).toMatchObject({ decision: 'approve' });
  expect(backtest.rows.find((row: { subject: string }) => row.subject.includes('updated bank details')).reason).toContain('sender_verified');
  expect(tested.body.recipe.ready).toBe(true);

  const enabled = await api(runtime, 'POST', `recipes/${recipe.id}/enable`);
  expect(enabled.body.recipe.status).toBe('enabled');

  // New mail arrives: one small bill (runs automatically) and one large one (held for approval).
  for (const [subject, amount] of [['Billing: hosting renewal', '12.00'], ['Billing: annual license', '480.00']]) {
    const sent = await api(runtime, 'POST', 'sandbox/messages', { from: 'billing@newvendor.example', subject, text: `Vendor: NewVendor\nAmount: ${amount} USD\nDue: 2026-12-28` });
    expect(sent.status).toBe(200);
  }
  const ran = await api(runtime, 'POST', `recipes/${recipe.id}/run`);
  expect(ran.status).toBe(200);
  expect(ran.body.result).toMatchObject({ handled: 1, waiting_for_approval: 1, tokens: 0, model_calls: 0 });
  expect(runtime.inbox.store.run(ran.body.result.run_id)).toMatchObject({ status: 'COMPLETED', tokens: 0 });
  const rows = sheetRows(runtime, sheetTitle).rows;
  expect(rows.length).toBe(before + 1);
  expect(rows.some((row) => row.includes(12))).toBe(true);
  expect(rows.some((row) => row.includes(480))).toBe(false);

  const held = ran.body.items.find((item: { status: string }) => item.status === 'awaiting_approval');
  expect(held.reason).toContain('amount > 100');
  const approval = runtime.inbox.store.approval(held.approval_id)!;
  expect(approval).toMatchObject({ status: 'PENDING', triggered_rule_id: 'RECIPE_RULE_APPROVAL', proposed_action: { kind: 'review' } });

  // A second run is idempotent: nothing new is handled and the held email stays held.
  const again = await api(runtime, 'POST', `recipes/${recipe.id}/run`);
  expect(again.body.result).toMatchObject({ handled: 0, waiting_for_approval: 1 });

  // The owner approves from the recipe page (same engine call as the Approval Inbox); the recipe finishes the job.
  const decided = await api(runtime, 'POST', `recipes/${recipe.id}/items/${encodeURIComponent(held.message_id)}/approve`);
  expect(decided.status).toBe(200);
  await until(() => sheetRows(runtime, sheetTitle).rows, (value) => value.some((row) => row.includes(480)));
  expect(runtime.inbox.store.approval(held.approval_id)!.status).toBe('APPROVED');
  const finished = await until(() => runtime.missions.recipes.detail(user, recipe.id), (detail) => detail.recipe.stats.handled === 2) as
    ReturnType<Runtime['missions']['recipes']['detail']> & { items: { message_id: string; status: string }[] };
  expect(finished.items.find((item: { message_id: string }) => item.message_id === held.message_id)).toMatchObject({ status: 'done' });
  expect(finished.recipe.stats).toMatchObject({ tokens: 0 });
  expect(finished.recipe.stats.handled).toBe(2);

  // An email the rules cannot evaluate is never guessed at.
  await api(runtime, 'POST', 'sandbox/messages', { from: 'billing@other.example', subject: 'Billing question', text: 'Hi, what do I owe?' });
  const unsure = await api(runtime, 'POST', `recipes/${recipe.id}/run`);
  expect(unsure.body.result).toMatchObject({ escalated: 1, tokens: 0 });

  // The kill switch stops recipes too, and they cannot be switched back on while it is latched.
  runtime.inbox.latch(true);
  await until(() => runtime.missions.recipes.detail(user, recipe.id).recipe.status, (status) => status === 'paused');
  expect((await api(runtime, 'POST', `recipes/${recipe.id}/enable`)).status).toBe(423);
  runtime.inbox.latch(false);
  await api(runtime, 'POST', `recipes/${recipe.id}/enable`);

  // Switched-on recipes are published as MCP tools; tokens cannot approve held mail.
  const minted = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox', scopes: ['agent:manage', 'mail:read', 'mail:label', 'workspace:write'] } });
  const token = minted.json().token as string;
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const name = finished.recipe.tool_name as string;
    expect(tools).toEqual(expect.arrayContaining(['learn_recipe', 'list_recipes', 'backtest_recipe', 'update_recipe', 'set_recipe_enabled', 'run_recipe', name]));
    const listed = payload(await client.callTool({ name: 'list_recipes', arguments: {} }));
    expect(listed.recipes[0]).toMatchObject({ name: 'Billing tracker', status: 'enabled' });
    const replay = payload(await client.callTool({ name, arguments: {} }));
    expect(replay).toMatchObject({ recipe: 'Billing tracker', model_calls: 0, tokens: 0 });
  } finally { await client.close(); }
  const narrow = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox', scopes: ['agent:manage', 'mail:read'] } });
  const limited = new Client({ name: 'codex-cli', version: '1.0.0' });
  await limited.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + narrow.json().token } } }));
  try {
    const denied = await limited.callTool({ name: 'run_recipe', arguments: { recipe_id: recipe.id } });
    expect(denied.isError).toBe(true);
    expect(payload(denied).error).toBe('MCP_SCOPE_REQUIRED');
  } finally { await limited.close(); }
}), 60_000);
