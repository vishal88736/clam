import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClamApp } from '../apps/server/src/app.js';
import { loadConfig, workspaceRoot } from '../apps/server/src/config.js';
import { renderTrapReport, runInboxTrapPack } from '../apps/server/src/inbox/trapHarness.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

const [command, value, ...rest] = process.argv.slice(2);
const config = loadConfig();
const base = config.publicUrl.replace(/\/$/, '');
const headers = {
  'Content-Type': 'application/json',
  ...(config.operatorToken ? { 'X-Clam-Operator-Token': config.operatorToken } : {}),
};

async function api(url: string, payload?: unknown) {
  const response = await fetch(base + url, {
    method: payload === undefined ? 'GET' : 'POST', headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const parsed = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(parsed.error ?? response.status));
  return parsed;
}

async function watch() {
  const response = await fetch(base + '/api/inbox/events', { headers });
  if (!response.ok || !response.body) throw new Error('Could not start watch (HTTP ' + response.status + ')');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buffer += chunk;
    for (const frame of buffer.split('\n\n').slice(0, -1)) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) console.log(event, data);
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + (buffer.includes('\n\n') ? 2 : 1));
  }
}

async function sandboxRun() {
  const runtime = await createClamApp();
  try {
    if (runtime.inbox.activeMode() !== 'sandbox') throw new Error('Use agent run for the connected live mode.');
    const run = await runtime.inbox.start('cli').done;
    console.log(JSON.stringify({ run, briefing: runtime.inbox.briefing(run.id) }, null, 2));
    if (run.status !== 'COMPLETED') process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

async function main() {
  switch (command) {
    case 'verify-trace': {
      if (!value) throw new Error('Usage: pnpm agent verify-trace <path>');
      const trace: unknown = JSON.parse(await readFile(value, 'utf8'));
      if (!verifyTrace(trace)) throw new Error('Trace integrity check failed.');
      console.log(`Verified ${trace.step_count} steps · ${trace.head_hash}`);
      return;
    }
    case 'run-trap-pack': {
      const report = await runInboxTrapPack();
      const formatted = renderTrapReport(report);
      await writeFile(path.join(workspaceRoot, 'tests', 'trap_pack_report.md'), formatted, 'utf8');
      console.log(formatted);
      if (!report.passed) process.exitCode = 1;
      return;
    }
    case 'watch': return watch();
    case 'sandbox': return sandboxRun();
    case 'run':
    case 'rollback': {
      if (command === 'rollback' && !value) throw new Error('Usage: pnpm agent rollback <run_id>');
      const endpoint = command === 'run' ? '/api/inbox/runs' :
        '/api/inbox/runs/' + encodeURIComponent(value) + '/rollback';
      const result = await api(endpoint, { wait: true }) as { run: { status: string } } | never;
      console.log(JSON.stringify(result, null, 2));
      if (result.run.status !== 'COMPLETED') process.exitCode = 1;
      return;
    }
    case 'halt':
    case 'resume': {
      const reason = [value, ...rest].filter(Boolean).join(' ').trim();
      if (!reason) throw new Error('Provide an operator reason.');
      try {
        console.log(JSON.stringify(await api('/api/kill-switch', { active: command === 'halt', reason }), null, 2));
      } catch (error) {
        if (!(error instanceof TypeError) || command !== 'halt' || config.databasePath === ':memory:') throw error;
        await mkdir(path.dirname(config.lockfile), { recursive: true });
        await writeFile(config.lockfile, reason + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ halted: true, source: 'local lockfile' }));
      }
      return;
    }
    default: throw new Error('Usage: pnpm agent <sandbox|run|watch|halt|resume|rollback|verify-trace|run-trap-pack>');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Inbox command failed.');
  process.exitCode = 1;
});
