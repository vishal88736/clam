import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';
import { fakeModel } from './support/fakeModel.js';

// What the AI plans for each request in this walkthrough (a fake model returns them in order).
const plans = [
  { reasoning: 'File invoice PDFs, log them, and summarize.', name: 'Invoice Filing', schedule_mode: 'daily', program: [
    { id: 'invoices', op: 'mail.search', keywords: ['invoice'], include_attachments: true },
    { id: 'folder', op: 'drive.folder', path: ['Siftvane', 'Invoices'] },
    { id: 'pdfs', op: 'drive.save_attachments', from: 'invoices', folder: 'folder' },
    { id: 'log', op: 'sheets.append', from: 'invoices', title: 'Invoice Log', columns: ['Date', 'From', 'Subject'] },
    { id: 'summary', op: 'summarize', from: 'invoices' },
    { id: 'doc', op: 'docs.write', title: 'Invoice Summary', content: '{{summary}}' }] },
  { reasoning: 'Read receipt photos into a sheet.', name: 'Receipt Photos', schedule_mode: 'one_shot', program: [
    { id: 'photos', op: 'photos.extract', category: 'RECEIPTS' },
    { id: 'sheet', op: 'sheets.append', from: 'photos', title: 'Receipts', columns: ['Merchant', 'Date', 'Amount'] }] },
  { reasoning: 'Track billing mail with amount and due date, and label it.', name: 'Billing Tracker', schedule_mode: 'one_shot', program: [
    { id: 'mail', op: 'mail.search', keywords: ['billing'] },
    { id: 'sheet', op: 'sheets.append', from: 'mail', title: 'Billing Tracker', columns: ['Date', 'From', 'Subject', 'Amount', 'Due'] },
    { id: 'label', op: 'mail.label', from: 'mail', label: 'SIFTVANE_BILLING' }] },
];

const chromium = process.env.SIFTVANE_CHROMIUM ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((file) => existsSync(file));
const payload = (result: { content: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly errors: string[] = [];
  constructor(private readonly socket: WebSocket, private sessionId?: string) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
        return;
      }
      const params = message.params ?? {};
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push('exception: ' + JSON.stringify((params.exceptionDetails as { exception?: { description?: string }; text?: string })?.exception?.description ?? params));
      }
      if (message.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        this.errors.push('console.error: ' + JSON.stringify((params.args as { value?: unknown; description?: string }[]).map((arg) => arg.value ?? arg.description)));
      }
      if (message.method === 'Log.entryAdded' && (params.entry as { level: string }).level === 'error') {
        this.errors.push('log: ' + (params.entry as { text: string; url?: string }).text + ' ' + ((params.entry as { url?: string }).url ?? ''));
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new Cdp(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params, ...(this.sessionId && !method.startsWith('Target.') ? { sessionId: this.sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
  }

  async attach(url: string) {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Evaluation failed: ' + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function until<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  let value: T;
  for (;;) {
    value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  // Wait for the process to release its files before the profile directory is removed.
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
}

it.skipIf(!chromium)('streams CLI agent creation, switches, live logs, and artifact previews to the website in headless Chromium with zero console errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'siftvane-web-e2e-'));
  const model = await fakeModel(plans);
  const runtime = await createSiftvaneApp({ databasePath: ':memory:', agent: model.agent, config: {
    inboxLive: false, tracesDir: path.join(dir, 'traces'), mailAttachmentsDir: path.join(dir, 'workspace', 'mail-attachments'),
  } });
  let web: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  let client: Client | undefined;
  try {
    const base = await runtime.app.listen({ port: 0, host: '127.0.0.1' });
    const webPort = await freePort();
    const origin = `http://127.0.0.1:${webPort}`;
    web = spawn(path.resolve('node_modules/.bin/pnpm'), ['--filter', '@siftvane/web', 'exec', 'next', 'dev', '-p', String(webPort), '-H', '127.0.0.1'], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SIFTVANE_INBOX_API_ORIGIN: base, SIFTVANE_NEXT_DIST_DIR: '.next-e2e', NEXT_TELEMETRY_DISABLED: '1', PORT: String(webPort) },
    });
    let webLog = '';
    web.stdout?.on('data', (chunk) => { webLog += chunk; });
    web.stderr?.on('data', (chunk) => { webLog += chunk; });
    await until('Next dev server', async () => {
      if (web?.exitCode !== null) throw new Error('next dev exited: ' + webLog.slice(-2000));
      return fetch(origin + '/', { signal: AbortSignal.timeout(60_000) }).then((response) => response.status).catch(() => 0);
    }, (status) => status === 200, 150_000);
    // Warm the proxy routes once so the first browser paint is not racing route compilation.
    await fetch(origin + '/api/inbox/platform/me').then((response) => response.text());

    const profile = path.join(dir, 'chromium');
    browser = spawn(chromium!, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--user-data-dir=' + profile, 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let text = '';
      browser!.stderr!.on('data', (chunk) => {
        text += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (match) resolve(match[1]);
      });
      browser!.once('exit', () => reject(new Error('Chromium exited: ' + text)));
      setTimeout(() => reject(new Error('Chromium did not start: ' + text)), 30_000);
    });
    cdp = await Cdp.connect(endpoint);
    await cdp.attach(origin + '/#agents');
    const page = cdp;
    await until('agents view', () => page.evaluate<string>('document.body.innerText'), (text) => text.includes('Create an agent') && text.includes('Active agent'), 90_000);
    await until('Siftvane sidebar brand', () => page.evaluate<boolean>(`(() => {
      const brand = document.querySelector('.inbox-brand');
      return brand?.textContent?.trim() === 'Siftvane' && brand.querySelector('img')?.naturalWidth > 0;
    })()`), Boolean);
    await until('live SSE connection', () => page.evaluate<string>('document.body.innerText'), (text) => /Status\s*Ready/.test(text), 30_000);

    const minted = await runtime.app.inject({ method: 'POST', url: '/api/inbox/mcp-tokens', payload: { inbox_id: 'sandbox',
      scopes: ['mail:read', 'attachment:extract', 'mail:send', 'mail:label', 'calendar:propose', 'agent:manage', 'workspace:write', 'photos:read'] } });
    client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + minted.json().token } } }));

    // 1. CLI provisions an agent; the website shows it, auto-switches the active agent, and streams logs and artifacts.
    const first = payload(await client.callTool({ name: 'provision_and_run_agent', arguments: {
      user_instruction: 'Scan my email for daily invoices, save PDFs to Drive, log them in a Google Sheet, and summarize in a Doc.' } }));
    const view = () => page.evaluate<{ cards: number; active: string; logs: number; artifacts: number; switches: number; text: string; status: string }>(`({
      cards: document.querySelectorAll('[data-testid=agent-card]').length,
      active: document.querySelector('[data-testid=active-agent-select]')?.value ?? '',
      logs: document.querySelectorAll('[data-testid=log-row]').length,
      artifacts: document.querySelectorAll('[data-testid=artifact-card]').length,
      switches: document.querySelectorAll('[data-testid=switch-row]').length,
      status: document.querySelector('[data-testid=active-agent-status]')?.textContent ?? '',
      text: document.body.innerText,
    })`);
    const synced = await until('first agent live sync', view, (state) => state.cards === 1 && state.active === first.agent_id &&
      state.logs >= 6 && state.artifacts >= 5 && state.switches === 1 && state.status === 'Active');
    expect(synced.text).toContain('Claude Code');
    expect(synced.text).toContain('Scan my email for daily invoices');
    expect(synced.text).toContain('Invoice Log');
    expect(synced.text).toMatch(/ALLOW TIER 0/);

    // 2. A second CLI agent and a manual CLI switch update the switcher and timeline in real time.
    const second = payload(await client.callTool({ name: 'provision_and_run_agent', arguments: {
      user_instruction: 'Go through my receipt photos and put them in a spreadsheet', source_cli: 'codex-cli' } }));
    await until('second agent auto-switch', view, (state) => state.cards === 2 && state.active === second.agent_id && state.switches === 2);
    await client.callTool({ name: 'switch_active_agent', arguments: { agent_id: first.agent_id, reason: 'Back to invoices from the CLI' } });
    const switched = await until('CLI manual switch', view, (state) => state.active === first.agent_id && state.switches === 3);
    expect(switched.text).toContain('Cli manual');
    expect(switched.text).toContain('Codex CLI');

    // 3. The interactive Sheet viewer renders the verified rows inside the browser.
    await page.evaluate(`[...document.querySelectorAll('[data-testid=artifact-card][data-service=google_sheet]')]
      .find((card) => card.innerText.includes('Invoice Log')).querySelector('[data-testid=artifact-open]').click()`);
    const preview = await until('sheet preview', () => page.evaluate<{ rows: number; text: string }>(`({
      rows: document.querySelectorAll('[data-testid=artifact-preview] [data-testid=sheet-row]').length,
      text: document.querySelector('[data-testid=artifact-preview]')?.innerText ?? '' })`), (state) => state.rows >= 1);
    expect(preview.text).toContain('Subject');
    await page.evaluate(`document.querySelector('[aria-label="Close preview"]').click()`);
    await page.evaluate(`document.querySelector('[data-testid=artifact-card][data-service=google_doc] [data-testid=artifact-open]').click()`);
    await until('doc preview', () => page.evaluate<number>(`document.querySelectorAll('[data-testid=doc-section]').length`), (count) => count >= 1);

    // 4. Service filter narrows live logs.
    await page.evaluate(`(() => { const select = [...document.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === 'photos'));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'photos');
      select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until('photos log filter', () => page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid=log-row]')].map((row) => row.dataset.service)`),
      (services) => services.length > 0 && services.every((service) => service === 'photos'));

    // 5. Recipes ("muscle memory"): teach from a finished agent, backtest, add a rule, switch on, and approve a held email — all by clicking.
    const shots = process.env.SIFTVANE_E2E_SCREENSHOTS;
    const capture = async (name: string, width = 1440, height = 2400, mobile = false) => {
      if (!shots) return;
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const theme of ['light', 'dark']) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
        const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await writeFile(path.join(shots, `${name}-${theme}.png`), Buffer.from(data, 'base64'));
      }
      await page.send('Emulation.clearDeviceMetricsOverride');
    };
    const click = (selector: string) => page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled) return false; node.click(); return true; })()`);
    const billing = await runtime.app.inject({ method: 'POST', url: '/api/inbox/platform/agents',
      payload: { instruction: 'Find billing emails, put them in a tracker sheet with the amount and due date, and label them.' } });
    const billingId = billing.json().agent_id as string;
    await until('billing agent completes', async () => runtime.platform.agent(billingId)!.status, (status) => status === 'completed');
    await until('Teach as recipe button', () => page.evaluate<boolean>(`Boolean([...document.querySelectorAll('[data-testid=agent-card]')]
      .find((card) => card.dataset.agentId === ${JSON.stringify(billingId)})?.querySelector('[data-testid=teach-from-agent]'))`), Boolean);
    await page.evaluate(`[...document.querySelectorAll('[data-testid=agent-card]')].find((card) => card.dataset.agentId === ${JSON.stringify(billingId)})
      .querySelector('[data-testid=teach-from-agent]').click()`);
    const recipeView = () => page.evaluate<{ hash: string; status: string; bindings: number; text: string; backtest: number; items: string[] }>(`({
      hash: location.hash, status: document.querySelector('[data-testid=recipe-status]')?.textContent ?? '',
      bindings: document.querySelectorAll('[data-testid=recipe-binding]').length,
      backtest: document.querySelectorAll('[data-testid=backtest-row]').length,
      items: [...document.querySelectorAll('[data-testid=recipe-item]')].map((item) => item.dataset.status),
      text: document.querySelector('[data-testid=recipe-detail]')?.innerText ?? '' })`);
    const learnedView = await until('recipe learned and opened', recipeView, (state) => state.hash === '#recipes' && state.status === 'Draft' && state.bindings >= 5);
    expect(learnedView.text).toContain('From the email');
    expect(learnedView.text).toContain('Learned from');
    await capture('recipe-learned');
    expect(await click('[data-testid=recipe-backtest]')).toBe(true);
    await until('backtest rows', recipeView, (state) => state.backtest > 0);
    // Add the suggested approval rule, save it, and backtest the new version.
    // New recipes start with a safe default: unverified senders ask first.
    expect(await page.evaluate<number>(`document.querySelectorAll('[data-testid=recipe-rule]').length`)).toBe(1);
    expect(await click('[data-testid=suggest-rule]')).toBe(true);
    await until('rule row', () => page.evaluate<number>(`document.querySelectorAll('[data-testid=recipe-rule]').length`), (count) => count === 2);
    expect(await click('[data-testid=save-rules]')).toBe(true);
    await until('rules saved as v2', recipeView, (state) => state.text.includes('v2') && state.text.includes('Rules changed'));
    expect(await click('[data-testid=recipe-backtest]')).toBe(true);
    const tested = await until('backtest v2 with a held email', recipeView, (state) => state.text.includes('Asks you first') && !state.text.includes('Rules changed'));
    expect(tested.text).toMatch(/Agrees with .+ on \d+ of \d+ emails/);
    expect(await click('[data-testid=recipe-toggle]')).toBe(true);
    await until('recipe switched on', recipeView, (state) => state.status === 'On');
    await capture('recipe-on');
    // A test email over the limit is held for approval; approving it lets the recipe finish with zero tokens.
    await page.evaluate(`document.querySelector('[data-testid=recipe-test-email] button[type=submit]').click()`);
    await until('test email held', recipeView, (state) => state.items.includes('awaiting_approval'));
    await capture('recipe-waiting');
    expect(await click('[data-testid=approve-item]')).toBe(true);
    const finished = await until('held email handled', recipeView, (state) => !state.items.includes('awaiting_approval') &&
      state.text.includes('Approved by you, then handled'));
    expect(finished.text).toContain('0 tokens');
    await capture('recipe-mobile', 390, 2600, true);

    if (shots) {
      await page.evaluate(`location.hash = 'agents'`);
      await page.evaluate(`document.querySelector('[aria-label="Close preview"]')?.click()`);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 2200, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(() => { const select = [...document.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === 'photos'));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, '');
        select.dispatchEvent(new Event('change', { bubbles: true })); window.scrollTo(0, 0); })()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      for (const theme of ['light', 'dark']) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
        const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(shots, `agents-${theme}.png`), Buffer.from(data, 'base64'));
      }
      await page.evaluate(`[...document.querySelectorAll('[data-testid=artifact-card][data-service=google_sheet]')]
        .find((card) => card.innerText.includes('Vendor') || card.innerText.includes('Siftvane Invoice Ledger')).querySelector('[data-testid=artifact-open]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(shots, 'sheet-preview.png'), Buffer.from(data, 'base64'));
      await page.send('Page.navigate', { url: origin + '/about' });
      await until('Siftvane About hero', () => page.evaluate<boolean>(
        "document.querySelector('.siftvane-hero-mark img')?.naturalWidth > 0"), Boolean);
      for (const [size, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]] as const) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: size === 'mobile' });
        const hero = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(shots, `about-${size}.png`), Buffer.from(hero.data, 'base64'));
      }
    }
    expect(page.errors).toEqual([]);
  } finally {
    await client?.close().catch(() => undefined);
    cdp?.close();
    await stop(browser);
    await stop(web);
    await runtime.close();
    await model.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);
