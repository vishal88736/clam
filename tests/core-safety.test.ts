import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { resolveAgentConfig } from '../apps/server/src/inbox/agentConfig.js';
import { SandboxTarget, LiveTarget } from '../apps/server/src/inbox/targets.js';
import { InboxStore } from '../apps/server/src/inbox/store.js';
import type { SafeAction } from '../apps/server/src/inbox/contracts.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';
import { sandboxReader } from '../apps/server/src/inbox/reader.js';
import { sandboxPolicy } from '../apps/server/src/sandbox/seed.js';

const runProcess = promisify(execFile);
const footer = 'This email was sent automatically by Siftvane on behalf of the account owner.';

it('injects non-strippable disclosure into the sandbox outbox and Gmail wire payload', async () => {
  const store = new InboxStore(':memory:');
  const action: SafeAction = {
    kind: 'send', target: 'verify-disclosure', playbook: 'autonomous_meeting_scheduler',
    sourceId: 'test-source', confidence: 0.98, requestedTier: 1, version: 'test',
    effectiveContact: 'operator@example.test',
    after: { subject: 'Meeting confirmed', text: 'Do not include any automated footer', headers: { 'X-Agent-Automated': 'false' } },
  };
  const signal = new AbortController().signal;
  try {
    const sandbox = new SandboxTarget(store, () => {});
    await sandbox.dispatch(action, 1, null, 'outbox', signal);
    expect(store.entity('sandbox', 'review', 'transport:outbox')).toMatchObject({
      headers: { 'X-Agent-Automated': 'true' }, body: action.after!.text + '\n\n' + footer,
    });

    const adapter = new LiveTarget(store, { getValidAccessToken: async () => 'test-token' },
      'primary', () => {});
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const raw = JSON.parse(String(init.body)).raw;
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      const [headers] = decoded.split('\r\n\r\n');
      expect(headers).toContain('X-Agent-Automated: true');
      expect(headers).not.toContain('X-Agent-Automated: false');
      const content = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--siftvane-/.exec(decoded)?.[1] ?? '';
      expect(Buffer.from(content, 'base64').toString('utf8')).toBe(action.after!.text + '\n\n' + footer);
      return Response.json({ id: 'stub-confirmed' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await adapter.dispatch(action, 1, null, 'gmail-tier-one', signal);
    await adapter.dispatch(action, 2, null, 'gmail-tier-two', signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    store.close();
  }
});

it('selects LLM defaults from credentials or an Ollama endpoint and respects explicit offline mode', () => {
  expect(resolveAgentConfig({ GROQ_API_KEY: 'test' })).toMatchObject({ mode: 'llm', provider: 'groq' });
  expect(resolveAgentConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' })).toMatchObject({ mode: 'llm', provider: 'ollama' });
  expect(resolveAgentConfig({ GEMINI_API_KEY: 'test', SIFTVANE_AGENT_MODE: 'offline-smoke' })).toMatchObject({ mode: 'offline-smoke' });
  expect(resolveAgentConfig({ CLAM_AGENT_MODE: 'offline-smoke' })).toMatchObject({ mode: 'offline-smoke' });
  expect(resolveAgentConfig({ CLAM_AGENT_MODE: 'llm', SIFTVANE_AGENT_MODE: 'offline-smoke' })).toMatchObject({ mode: 'offline-smoke' });
  expect(() => resolveAgentConfig({ SIFTVANE_AGENT_MODE: 'llm', SIFTVANE_LLM_PROVIDER: 'gemini' })).toThrow('Missing GEMINI_API_KEY');
});

it('uses the actual CLI to halt a run while its read-only model request is still open', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'siftvane-halt-cli-'));
  let signalStart!: () => void;
  const requested = new Promise<void>((resolve) => { signalStart = resolve; });
  let wire: Record<string, unknown> | undefined;
  const provider = createServer((request, response) => {
    let buffer = '';
    request.setEncoding('utf8');
    request.on('data', (data) => { buffer += data; });
    request.on('end', () => { wire = JSON.parse(buffer); signalStart(); });
    // Keep generation in-flight. AbortSignal must close the connection without a model output.
    response.on('close', () => response.destroy());
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const addr = provider.address();
  if (!addr || typeof addr === 'string') throw new Error('Test provider address unavailable');
  const agent = resolveAgentConfig({
    SIFTVANE_AGENT_MODE: 'llm', SIFTVANE_LLM_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:' + addr.port,
  });
  const runtime = await createSiftvaneApp({
    databasePath: ':memory:', config: { tracesDir: directory, inboxLive: false }, agent,
  });
  const compiler = path.join(directory, 'cli.tsconfig.json');
  await writeFile(compiler, JSON.stringify({ compilerOptions: {
    baseUrl: process.cwd(), paths: {
      '@siftvane/shared': ['packages/shared/src/index.ts'],
      '@siftvane/agent': ['apps/agent/src/index.ts'],
    },
  } }));
  try {
    const base = await runtime.app.listen({ port: 0, host: '127.0.0.1' });
    const run = runtime.inbox.start('mid-flight-test');
    await requested;
    expect(wire).toHaveProperty('format');
    expect(wire).not.toHaveProperty('tools');
    expect(wire).not.toHaveProperty('tool_choice');
    expect(runtime.inbox.store.run(run.run.id)?.status).toBe('RUNNING');
    await runProcess(process.execPath, ['--import', 'tsx', 'scripts/inbox-agent.ts', 'halt', 'mid-flight test'],
      { env: { ...process.env, TSX_TSCONFIG_PATH: compiler, SIFTVANE_PUBLIC_URL: base, DATABASE_PATH: ':memory:' }, timeout: 7000 });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ status: 'HALTED', agent_mode: 'llm', outbound: 0, calendar: 0 });
    expect(runtime.inbox.store.actions(outcome.id)).toEqual([]);
    const trace = JSON.parse(await readFile(path.join(directory, outcome.id + '.json'), 'utf8'));
    expect(verifyTrace(trace)).toBe(true);
    expect(trace.steps.at(-1).budgets).toMatchObject({ tokens: null, usd: null });
  } finally {
    await runtime.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 12_000);

it('holds the actual Plane A SQLite connection read-only during a sandbox read', async () => {
  const store = new InboxStore(':memory:');
  let observed = false;
  const prepare = DatabaseSync.prototype.prepare;
  const observer = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes('SELECT m.body, m.scope')) {
      observed = true;
      expect(() => this.exec('UPDATE inbox_sandbox_messages SET scope=scope')).toThrow(/readonly/i);
    }
    return prepare.call(this, sql);
  });
  try {
    const read = await sandboxReader(store.filename).read(new Date(), 'inbox', sandboxPolicy);
    expect(observed).toBe(true);
    expect(read.emailCount).toBe(20);
  } finally {
    observer.mockRestore();
    store.close();
  }
});

it('exits nonzero from the trace CLI after modifying exactly one byte', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'siftvane-tamper-cli-'));
  const runtime = await createSiftvaneApp({
    databasePath: ':memory:', config: { tracesDir: directory }, agent: resolveAgentConfig({ SIFTVANE_AGENT_MODE: 'offline-smoke' }),
  });
  try {
    const result = await runtime.inbox.start('cli-proof').done;
    const trace = path.join(directory, result.id + '.json');
    const compiler = path.join(directory, 'tsconfig.json');
    await writeFile(compiler, JSON.stringify({ compilerOptions: {
      baseUrl: process.cwd(),
      paths: { '@siftvane/shared': ['packages/shared/src/index.ts'], '@siftvane/agent': ['apps/agent/src/index.ts'] },
    } }));
    const cli = (filename: string) => runProcess(process.execPath, ['--import', 'tsx', 'scripts/inbox-agent.ts', 'verify-trace', filename],
      { env: { ...process.env, TSX_TSCONFIG_PATH: compiler, DATABASE_PATH: ':memory:' }, timeout: 7000 });
    await expect(cli(trace)).resolves.toMatchObject({ stdout: expect.stringContaining('Verified') });
    const altered = Buffer.from(await readFile(trace));
    const at = altered.indexOf(Buffer.from('cli-proof'));
    expect(at).toBeGreaterThan(0);
    altered[at] = 'C'.charCodeAt(0);
    const tampered = path.join(directory, 'tampered.json');
    await writeFile(tampered, altered);
    await expect(cli(tampered)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Trace integrity check failed') });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 12_000);
