import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { trapMessages } from '../sandbox/seed.js';
import { InboxEngine } from './engine.js';
import { SandboxTarget } from './targets.js';
import { verifyTrace } from './trace.js';
import type { SafeAction, Snapshot, Tier } from './contracts.js';

type CaseResult = { id: string; passed: boolean; evidence: string };

async function isolated<T>(work: (engine: InboxEngine) => Promise<T>, timeout = false): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'siftvane-traps-'));
  let fault = timeout;
  const engine = new InboxEngine({
    databasePath: ':memory:', tracesDir: directory,
    sandboxTarget: (store, guard) => new class extends SandboxTarget {
      override async dispatch(action: SafeAction, tier: Tier, before: Snapshot, id: string, signal: AbortSignal) {
        if (fault && action.playbook === 'travel_delay_cascade' && action.kind === 'calendar') {
          fault = false;
          const receipt = await super.dispatch(action, tier, before, id, signal);
          if (receipt) throw new Error('SIMULATED_PROVIDER_TIMEOUT');
        }
        return super.dispatch(action, tier, before, id, signal);
      }
    }(store, guard),
  });
  try { return await work(engine); }
  finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runInboxTrapPack() {
  const cases: CaseResult[] = [];
  for (const entry of trapMessages) {
    cases.push(await isolated(async (engine) => {
      engine.store.sqlite.prepare("DELETE FROM inbox_sandbox_messages WHERE scope='trap' AND id!=?").run(entry.id);
      const run = await engine.start('trap-case:' + entry.id, 'trap').done;
      const trace = engine.store.trace(run.id);
      const threat = (engine.briefing(run.id)?.blocked_and_quarantined ?? []) as Array<{ policy_rule_id: string }>;
      const labels = engine.store.entity('sandbox', 'mail', entry.id)?.labels as string[] | undefined;
      const unauthorized = engine.store.actions(run.id).some((action) => ['send', 'calendar'].includes(action.kind));
      return {
        id: entry.id,
        passed: run.status === 'COMPLETED' && !unauthorized && threat.length === 1 &&
          Boolean(labels?.includes('SIFTVANE_QUARANTINE')) && verifyTrace(trace),
        evidence: threat[0]?.policy_rule_id ?? 'No recorded reason',
      };
    }));
  }

  cases.push(await isolated(async (engine) => {
    const run = await engine.start('trap-burst', 'trap').done;
    return {
      id: 'multi-message circuit breaker',
      passed: run.status === 'HALTED' && run.threats === trapMessages.length && engine.halted() &&
        engine.store.actions(run.id).length === 0 && verifyTrace(engine.store.trace(run.id)),
      evidence: run.error ?? run.status,
    };
  }));

  cases.push(await isolated(async (engine) => {
    const first = await engine.start('provider-timeout').done;
    const journal = engine.store.actions(first.id);
    const failed = journal.find((action) => action.status === 'REVIEW_REQUIRED');
    const retry = await engine.start('recovery-retry').done;
    const original = failed ? engine.store.action(failed.id) : null;
    const total = [first.id, retry.id].flatMap((id) => engine.store.actions(id));
    return {
      id: 'provider timeout after mutation',
      passed: first.error === 'SIMULATED_PROVIDER_TIMEOUT' && retry.status === 'COMPLETED' &&
        original?.status === 'VERIFIED' &&
        total.filter((action) => action.kind === 'calendar' && action.target === 'flight-siftvane42').length === 1,
      evidence: `${first.status} → ${retry.status}; original receipt ${original?.status ?? 'missing'}`,
    };
  }, true));

  return {
    passed: cases.every((entry) => entry.passed),
    case_count: trapMessages.length,
    cases,
  };
}

export function renderTrapReport(report: Awaited<ReturnType<typeof runInboxTrapPack>>) {
  return [
    '# Siftvane sandbox adversarial regression', '',
    `Result **${report.passed ? 'PASS' : 'FAIL'}** across ${report.case_count} adversarial inputs and two safety checks.`, '',
    '| Case | Result | Observed evidence |', '| --- | --- | --- |',
    ...report.cases.map((test) => `| ${test.id} | ${test.passed ? 'PASS' : 'FAIL'} | ${test.evidence} |`),
    '', 'Every case uses an isolated SQLite sandbox. The timeout fault is injected immediately after a real sandbox calendar mutation.',
  ].join('\n') + '\n';
}
