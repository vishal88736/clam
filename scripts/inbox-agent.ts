import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

const [command, value, ...rest] = process.argv.slice(2);
const config = loadConfig();
const base = (process.env.SIFTVANE_PUBLIC_URL?.trim() || `http://localhost:${config.port}`).replace(/\/$/, '');
const headers = {
  'Content-Type': 'application/json',
  ...(config.operatorToken ? { 'X-Siftvane-Operator-Token': config.operatorToken } : {}),
  ...(process.env.SIFTVANE_INBOX_ID ? { 'X-Siftvane-Inbox-Id': process.env.SIFTVANE_INBOX_ID } : {}),
};

async function api(url: string, payload?: unknown, method = payload === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, {
    method, headers,
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

async function main() {
  switch (command) {
    case 'verify-trace': {
      if (!value) throw new Error('Usage: pnpm agent verify-trace <path>');
      const trace: unknown = JSON.parse(await readFile(value, 'utf8'));
      if (!verifyTrace(trace)) throw new Error('Trace integrity check failed.');
      console.log(`Verified ${trace.step_count} steps · ${trace.head_hash}`);
      return;
    }
    case 'create': {
      const instruction = [value, ...rest].join(' ').trim();
      if (instruction.length < 4) throw new Error('Usage: pnpm agent create "<what the agent should do>"');
      console.log(JSON.stringify(await api('/api/inbox/platform/agents', { instruction }), null, 2));
      return;
    }
    case 'agents': {
      const { agents } = await api('/api/inbox/platform/agents') as { agents: Array<{ id: string; name: string; status: string; schedule_mode: string }> };
      for (const agent of agents.filter((entry) => entry.status !== 'archived')) console.log(`${agent.id}  ${agent.status.padEnd(14)} ${agent.schedule_mode.padEnd(10)} ${agent.name}`);
      return;
    }
    case 'watch': return watch();
    case 'rollback': {
      if (!value) throw new Error('Usage: pnpm agent rollback <run_id>');
      const result = await api('/api/inbox/runs/' + encodeURIComponent(value) + '/rollback', { wait: true }) as { run: { status: string } };
      console.log(JSON.stringify(result, null, 2));
      if (result.run.status !== 'COMPLETED') process.exitCode = 1;
      return;
    }
    case 'halt':
    case 'resume': {
      const reason = [value, ...rest].filter(Boolean).join(' ').trim();
      if (!reason) throw new Error('Provide an operator reason.');
      try {
        console.log(JSON.stringify(await api('/api/inbox/kill-switch', { active: command === 'halt', reason }), null, 2));
      } catch (error) {
        if (!(error instanceof TypeError) || command !== 'halt' || config.databasePath === ':memory:') throw error;
        await mkdir(path.dirname(config.lockfile), { recursive: true });
        await writeFile(config.lockfile, reason + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ halted: true, source: 'local lockfile' }));
      }
      return;
    }
    default: throw new Error('Usage: pnpm agent <create "request"|agents|watch|halt|resume|rollback <run_id>|verify-trace <path>>');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Inbox command failed.');
  process.exitCode = 1;
});
