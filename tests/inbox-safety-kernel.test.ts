import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InboxEngine } from '../apps/server/src/inbox/engine.js';
import { evaluateSafeAction, outboundPayload } from '../apps/server/src/inbox/policy.js';
import { parseMessage } from '../apps/server/src/inbox/reader.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';
import type { SafeAction } from '../apps/server/src/inbox/contracts.js';
import { sandboxMessages, sandboxPolicy } from '../apps/server/src/sandbox/seed.js';

async function withInbox(work: (engine: InboxEngine, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'clam-kernel-'));
  const engine = new InboxEngine({ databasePath: ':memory:', tracesDir: directory, lockfile: path.join(directory, '.killswitch') });
  try { await work(engine, directory); }
  finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
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
    expect(outboundPayload(send, 1).body).toContain('automatically by Clam');
    expect(() => outboundPayload({ ...send, after: { subject: 'Unsafe\r\nSubject', text: 'p' } }, 1)).toThrow('INVALID_OUTBOUND');
  });

  it('runs the seeded inbox with verified writes, deduplicates repeats and rolls back in reverse order', () => withInbox(async (engine, directory) => {
    expect(engine.store.entities('sandbox', 'calendar')).toHaveLength(8);
    const first = engine.start();
    expect(() => engine.start()).toThrow('RUN_ALREADY_ACTIVE');
    const run = await first.done;
    expect(run).toMatchObject({ status: 'COMPLETED', emails: 20, outbound: 3, calendar: 6, conflicts: 2 });
    expect(engine.store.entity('sandbox', 'calendar', 'flight-clam42')?.start).toBe('2026-12-07T16:45:00.000Z');
    expect(engine.store.entity('sandbox', 'mail', 'password-alert')?.labels).toEqual(['INBOX']);
    expect(engine.store.entity('sandbox', 'mail', 'otp-one')?.labels).not.toContain('INBOX');
    expect(engine.store.entities('sandbox', 'calendar').some((event) => Array.isArray(event?.dossier))).toBe(true);
    expect(engine.store.entities('sandbox', 'review').every((mail) =>
      (mail?.headers as Record<string, string>)['X-Agent-Automated'] === 'true' && String(mail?.body).includes('automatically by Clam'))).toBe(true);
    const trace = JSON.parse(await readFile(path.join(directory, run.id + '.json'), 'utf8'));
    expect(verifyTrace(trace)).toBe(true);
    trace.steps[1].detail.actions = 777;
    expect(verifyTrace(trace)).toBe(false);

    const second = await engine.start().done;
    expect(second).toMatchObject({ status: 'COMPLETED', outbound: 0, calendar: 0 });
    expect(engine.store.entities('sandbox', 'send')).toHaveLength(3);
    const rollback = await engine.rollback(run.id).done;
    expect(rollback.status).toBe('COMPLETED');
    expect(engine.store.entities('sandbox', 'calendar')).toHaveLength(8);
    expect(engine.store.entity('sandbox', 'calendar', 'flight-clam42')?.start).toBe('2026-12-07T14:20:00Z');
    expect(engine.store.entity('sandbox', 'mail', 'otp-one')?.labels).toContain('INBOX');
    expect(engine.store.trace(rollback.id).steps.some((step) => step.detail.outcome === 'SENT_MAIL_CANNOT_BE_RECALLED')).toBe(true);
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
    expect(() => direct.run('bad', run.id, 1, 'sandbox', 'bill', 'item', 'CLAIMED', '{}')).toThrow('INBOX_HALTED');
    expect(() => engine.start()).toThrow('INBOX_HALTED');
    engine.latch(false);
    await writeFile(path.join(directory, '.killswitch'), 'operator');
    expect(() => engine.start()).toThrow('INBOX_HALTED');
  }));

  it('produces evidence and a read-only policy diff across all 20 inbox messages', () => withInbox(async (engine) => {
    const parsed = parseMessage({ ...sandboxMessages[0], text: 'Booking: CLAM42' }, sandboxPolicy);
    expect(parsed?.confidence).toBeLessThan(sandboxPolicy.confidenceThreshold);
    expect(parsed?.evidence).toBeTruthy();
    const candidate = { ...sandboxPolicy, allowlist: [], confidenceThreshold: 0.99 };
    const diff = await engine.preview(candidate);
    expect(diff.messages_scanned).toBe(20);
    expect(diff.rows.some((row) => row.before?.decision === 'AUTONOMOUS' && row.after?.decision === 'APPROVAL_REQUIRED')).toBe(true);
    expect(engine.store.runs('sandbox')).toHaveLength(0);
  }));
});

it('recovers an interrupted run and executes one due schedule using the persistent lease', () => withInbox(async (engine) => {
  const settings = engine.store.policy('sandbox');
  const orphan = engine.store.start('interrupted', 'sandbox', settings.version, settings.policy);
  engine.store.acquireLease('exited-process', Date.now() - 20_000);
  engine.startScheduler();
  expect(engine.store.run(orphan.id)).toMatchObject({ status: 'FAILED', error: 'PROCESS_INTERRUPTED' });
  expect(verifyTrace(engine.store.trace(orphan.id))).toBe(true);
  engine.setSchedule({ enabled: true, frequency: 'daily', intervalMinutes: 1440, nextAt: new Date(Date.now() - 1000).toISOString() });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Scheduled run did not finish')), 4000);
    engine.on('state', (change: { id?: string }) => {
      if (!change.id || engine.store.run(change.id)?.trigger !== 'scheduled') return;
      clearTimeout(timeout);
      resolve();
    });
  });
  expect(engine.store.runs('sandbox').filter((run) => run.trigger === 'scheduled')).toHaveLength(1);
  expect(Date.parse(engine.store.schedule().nextAt!)).toBeGreaterThan(Date.now());
}));
