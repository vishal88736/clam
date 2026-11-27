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
  const directory = await mkdtemp(path.join(tmpdir(), 'siftvane-kernel-'));
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
    expect(outboundPayload(send, 1).body).toContain('automatically by Siftvane');
    expect(() => outboundPayload({ ...send, after: { subject: 'Unsafe\r\nSubject', text: 'p' } }, 1)).toThrow('INVALID_OUTBOUND');
  });

  it('runs the seeded inbox with verified writes, deduplicates repeats and rolls back in reverse order', () => withInbox(async (engine, directory) => {
    expect(engine.store.entities('sandbox', 'calendar')).toHaveLength(8);
    const first = engine.start();
    expect(() => engine.start()).toThrow('RUN_ALREADY_ACTIVE');
    const run = await first.done;
    expect(run).toMatchObject({ status: 'COMPLETED', emails: 20, outbound: 3, calendar: 6, conflicts: 2 });
    expect(engine.store.entity('sandbox', 'calendar', 'flight-siftvane42')?.start).toBe('2026-12-07T16:45:00.000Z');
    expect(engine.store.entity('sandbox', 'mail', 'password-alert')?.labels).toEqual(['INBOX']);
    expect(engine.store.entity('sandbox', 'mail', 'otp-one')?.labels).not.toContain('INBOX');
    expect(engine.store.entities('sandbox', 'calendar').some((event) => Array.isArray(event?.dossier))).toBe(true);
    expect(engine.store.entities('sandbox', 'review').every((mail) =>
      (mail?.headers as Record<string, string>)['X-Agent-Automated'] === 'true' && String(mail?.body).includes('automatically by Siftvane'))).toBe(true);
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
    expect(engine.store.entity('sandbox', 'calendar', 'flight-siftvane42')?.start).toBe('2026-12-07T14:20:00Z');
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
    const parsed = parseMessage({ ...sandboxMessages[0], text: 'Booking: SIFTVANE42' }, sandboxPolicy);
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

it('gets verified receipts for all nine playbooks and yields the three disjoint autonomy counts', () => withInbox(async (engine) => {
  const run = await engine.start().done;
  expect(run.status).toBe('COMPLETED');
  expect(run.emails).toBe(20);
  expect(run.autonomy).toMatchObject({ gated_for_approval: 6, blocked_quarantined: 1 });
  const trace = engine.store.trace(run.id);
  const plan = trace.steps.find((step) => step.stage === 'PLAN')!;
  expect(plan.detail.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ msg_id: 'flight-delay', context_ids: ['flight-original'] }),
    expect.objectContaining({ msg_id: 'meeting-team', context_ids: ['meeting-original'] }),
    expect.objectContaining({ msg_id: 'stale-nudge', context_ids: ['launch-notes-initial'] }),
  ]));
  const verified = trace.steps.filter((step) => step.detail.outcome === 'VERIFIED');
  const playbooks = new Set(verified.flatMap((step) => step.detail.playbook_ids as string[]));
  expect(playbooks.size).toBe(9);
  expect(run.autonomy?.autonomous_verified).toBe(verified.length - 1);
  expect(trace.mode).toBe('offline-smoke');
  expect(trace.steps.at(-1)?.detail.autonomy).toEqual(run.autonomy);
}));

it('cancels a stale follow-up on a verified related reply in a different thread', () => withInbox(async (engine) => {
  const returned = {
    id: 'reply-in-other-thread', threadId: 'different-thread', from: 'priya@team.example',
    subject: 'A different subject', receivedAt: '2026-12-06T10:00:00.000Z',
    text: 'I reviewed the notes yesterday.', labels: ['ARCHIVED'], verifiedSender: true,
    references: ['<launch-followup@siftvane.example>'],
  };
  engine.store.sqlite.prepare('INSERT INTO inbox_sandbox_messages VALUES (?, ?, ?)').run(returned.id, 'history', JSON.stringify(returned));
  engine.store.setEntity('sandbox', 'mail', returned.id, { labels: returned.labels });
  const run = await engine.start().done;
  expect(run.status).toBe('COMPLETED');
  const actions = engine.store.actions(run.id);
  expect(actions.some((action) => action.plan.playbook === 'commitment_radar_and_chaser' && action.kind === 'send')).toBe(false);
  expect(actions.find((action) => action.kind === 'commitment')?.after).toMatchObject({ replied: true });
}));

it('trips the live executor circuit breaker when its SQLite outbound budget is exhausted', () => withInbox(async (engine) => {
  const { version, policy } = engine.store.policy('sandbox');
  engine.store.savePolicy('sandbox', version, { ...policy, outboundBudget: 0 });
  const run = await engine.start('budget-audit').done;
  expect(run).toMatchObject({ status: 'HALTED', error: 'INBOX_BUDGET_EXCEEDED', outbound: 0, killSwitchTripped: true });
  expect(engine.halted()).toBe(true);
  expect(engine.store.entities('sandbox', 'send')).toHaveLength(0);
}));

it('previews a blocked ingress decision apart from its allowed quarantine write', () => withInbox(async (engine) => {
  const { policy } = engine.store.policy('sandbox');
  const result = await engine.preview({ ...policy, trustedAirlines: [], confidenceThreshold: 0.97 });
  expect(result.messages_scanned).toBe(20);
  expect(result.rows.find((row) => row.id === 'flight-delay/ingress')).toMatchObject({
    before: { decision: 'AUTONOMOUS' }, after: { decision: 'BLOCKED', ruleId: 'UNTRUSTED_SENDER' }, changed: true,
  });
  expect(result.rows.some((row) => row.before?.decision === 'AUTONOMOUS' && row.after?.decision === 'APPROVAL_REQUIRED')).toBe(true);
}));
