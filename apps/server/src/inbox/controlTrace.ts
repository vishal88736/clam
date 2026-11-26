import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TraceStep } from './contracts.js';
import { genesisHash, hashStep } from './trace.js';

export async function writeControlTrace(tracesDir: string, trigger: string, inboxId: string, facts: Record<string, string | boolean>) {
  const run = randomUUID();
  const timestamp = new Date().toISOString();
  const budgets = { outbound: 0, calendar: 0, steps: 0, tokens: 0, usd: 0 };
  const steps: TraceStep[] = [];
  for (const stage of ['TRIGGER', 'REPORT'] as const) {
    const step = { id: run + ':' + (steps.length + 1), run_id: run, stage, timestamp, budgets,
      prev_hash: steps.at(-1)?.step_hash ?? genesisHash,
      detail: stage === 'TRIGGER' ? { trigger, inbox_id: inboxId } : facts };
    steps.push({ ...step, step_hash: hashStep(step) });
  }
  const trace = { run_id: run, step_count: steps.length, head_hash: steps.at(-1)!.step_hash, steps };
  await mkdir(tracesDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(tracesDir, run + '.json'), JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 }),
    writeFile(path.join(tracesDir, run + '.md'), '# ' + trigger + '\n\nInbox ' + inboxId + '\n\n' +
      Object.entries(facts).map(([key, value]) => '- ' + key + ' = ' + value).join('\n') + '\n', { mode: 0o600 }),
  ]);
  return run;
}
