import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InboxEngine } from '../apps/server/src/inbox/engine.js';
import { evaluateSafeAction, outboundPayload } from '../apps/server/src/inbox/policy.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';
import type { SafeAction } from '../apps/server/src/inbox/contracts.js';
import { sandboxPolicy } from '../apps/server/src/sandbox/seed.js';

async function withInbox(work: (engine: InboxEngine, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'siftvane-kernel-'));
  const engine = new InboxEngine({ databasePath: ':memory:', tracesDir: directory, lockfile: path.join(directory, '.killswitch') });
  try { await work(engine, directory); }
  finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('Agentic Inbox safety kernel', () => {
  it('enforces provenance and tiers and adds the Tier 1 disclosure at transport', () => {
    const send: SafeAction = {
      playbook: 'commitment_radar_and_chaser', kind: 'send', target: 'target', version: 'v1',
      sourceId: 'm1', requestedTier: 1, effectiveContact: 'sam@team.example', confidence: 0.94,
      after: { subject: 'Meeting confirmation', text: 'See you tomorrow.' },
    };
    expect(evaluateSafeAction(send, sandboxPolicy)).toMatchObject({ tier: 1, decision: 'AUTONOMOUS' });
    expect(evaluateSafeAction({ ...send, confidence: 0.4 }, sandboxPolicy)).toMatchObject({ tier: 2, ruleId: 'LOW_CONFIDENCE' });
    expect(evaluateSafeAction({ ...send, effectiveContact: 'director@partner.example' }, sandboxPolicy).ruleId).toBe('VIP_RECIPIENT');
    expect(evaluateSafeAction({ ...send, effectiveContact: 'out@other.example', bodyOnlyRecipient: true }, sandboxPolicy).decision).toBe('BLOCKED');
    expect(outboundPayload(send, 1)).toMatchObject({ headers: { 'X-Agent-Automated': 'true' } });
    expect(outboundPayload(send, 1).body).toContain('automatically by Siftvane');
    expect(() => outboundPayload({ ...send, after: { subject: 'Unsafe\r\nSubject', text: 'p' } }, 1)).toThrow('INVALID_OUTBOUND');
  });

  it('applies agent actions with read-back verification, skips repeats, and rolls back in reverse order', () => withInbox(async (engine, directory) => {
    const doc = (title: string, text: string) => ({ type: 'google_doc', title, folder: null, sections: [{ heading: 'Notes', text }] });
    const write = (key: string, after: Record<string, unknown>, version: string) => ({ kind: 'workspace' as const, target: key, sourceId: 'kernel-test',
      playbook: 'kernel_test', version, confidence: 1, requestedTier: 0 as const, after, workspaceOwner: { userId: 'owner', agentId: null } });
    const run = await engine.mission('kernel-test', 'sandbox', async (context) => {
      const created = await context.execute(write('owner/doc:Plan', doc('Plan', 'first'), 'v1'));
      expect(created.verified).toBe(true);
      expect((await context.execute(write('owner/doc:Plan', doc('Plan', 'second'), 'v2'))).verified).toBe(true);
    }).done;
    expect(run.status).toBe('COMPLETED');
    expect(engine.store.entity('sandbox', 'workspace', 'owner/doc:Plan')).toMatchObject({ sections: [{ text: 'second' }] });
    const trace = JSON.parse(await readFile(path.join(directory, run.id + '.json'), 'utf8'));
    expect(verifyTrace(trace)).toBe(true);
    trace.steps[1].detail.tampered = true;
    expect(verifyTrace(trace)).toBe(false);

    // The same write again is recognised as already done: nothing new is applied.
    const repeat = await engine.mission('kernel-repeat', 'sandbox', async (context) => {
      await context.execute(write('owner/doc:Plan', doc('Plan', 'second'), 'v2'));
    }).done;
    expect(engine.store.actions(repeat.id).filter((action) => action.status === 'VERIFIED')).toHaveLength(0);

    // Rollback undoes the run's writes newest first: the doc goes back to nothing.
    const rollback = await engine.rollback(run.id).done;
    expect(rollback.status).toBe('COMPLETED');
    expect(engine.store.entity('sandbox', 'workspace', 'owner/doc:Plan')).toBeNull();
  }));

  it('enforces the raw SQLite halt and write budget before mutations, and the out-of-band file', () => withInbox(async (engine, directory) => {
    const scope = engine.store.policy('sandbox');
    const run = engine.store.start('db-guard', 'sandbox', 1, { ...scope.policy, outboundBudget: 0 });
    const direct = engine.store.sqlite.prepare('INSERT INTO inbox_actions VALUES (?,?,?,?,?,?,?,?)');
    expect(() => direct.run('bad', run.id, 1, 'sandbox', 'send', 'mail', 'CLAIMED', '{}')).toThrow('INBOX_BUDGET_EXCEEDED');
    const readonly = new DatabaseSync(engine.store.filename, { readOnly: true });
    expect(() => readonly.exec('DELETE FROM inbox_sandbox_messages')).toThrow(/readonly/i);
    readonly.close();
    engine.latch(true);
    expect(() => direct.run('bad', run.id, 1, 'sandbox', 'mail', 'item', 'CLAIMED', '{}')).toThrow('INBOX_HALTED');
    expect(() => engine.mission('halted', 'sandbox', async () => undefined)).toThrow('INBOX_HALTED');
    engine.latch(false);
    await writeFile(path.join(directory, '.killswitch'), 'operator');
    expect(() => engine.mission('halted-file', 'sandbox', async () => undefined)).toThrow('INBOX_HALTED');
  }));
});

it('marks a run interrupted by a crashed process as failed, with a valid trace', () => withInbox(async (engine) => {
  const settings = engine.store.policy('sandbox');
  const orphan = engine.store.start('interrupted', 'sandbox', settings.version, settings.policy);
  engine.store.acquireLease('exited-process', Date.now() - 20_000);
  engine.startScheduler();
  expect(engine.store.run(orphan.id)).toMatchObject({ status: 'FAILED', error: 'PROCESS_INTERRUPTED' });
  expect(verifyTrace(engine.store.trace(orphan.id))).toBe(true);
}));
