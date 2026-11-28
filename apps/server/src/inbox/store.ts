import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inboxPolicySchema, type InboxPolicy } from '@siftvane/shared';
import { livePolicy, sandboxDriveFiles, sandboxReplyHistory, sandboxEvents, sandboxHistory, sandboxMessages, sandboxPolicy } from '../sandbox/seed.js';
import type { ActionKind, Attention, Claim, Mode, RunRecord, RunTrace, Snapshot, TraceStep } from './contracts.js';
import { genesisHash } from './trace.js';
import { handoffSchema } from '../handoffs/schema.js';
import { platformSchema } from '../platform/schema.js';
import { sandboxPhotos, workspaceMessages } from '../sandbox/seed.js';

const ddl = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS system_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  kill_switch_active INTEGER NOT NULL CHECK (kill_switch_active IN (0, 1))
);
INSERT OR IGNORE INTO system_state VALUES (1, 0);
CREATE TABLE IF NOT EXISTS inbox_policies (
  mode TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (mode, version)
);
CREATE TABLE IF NOT EXISTS inbox_runs (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, body TEXT NOT NULL,
  outbound_limit INTEGER NOT NULL, calendar_limit INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_runner_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_steps (
  run_id TEXT NOT NULL REFERENCES inbox_runs(id), ordinal INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY (run_id, ordinal)
);
CREATE TABLE IF NOT EXISTS inbox_actions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES inbox_runs(id), ordinal INTEGER NOT NULL,
  mode TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
  body TEXT NOT NULL, UNIQUE(run_id, ordinal)
);
CREATE INDEX IF NOT EXISTS inbox_actions_run ON inbox_actions(run_id, kind);
CREATE TABLE IF NOT EXISTS inbox_approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES inbox_runs(id), status TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_sandbox_messages (id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox_entities (
  mode TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (mode, kind, id)
);
CREATE TABLE IF NOT EXISTS inbox_state (key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox_changes (
  run_id TEXT NOT NULL REFERENCES inbox_runs(id), ordinal INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(run_id, ordinal)
);
DROP TRIGGER IF EXISTS inbox_actions_guard_insert;
DROP TRIGGER IF EXISTS inbox_actions_guard_update;
CREATE TRIGGER inbox_actions_guard_insert BEFORE INSERT ON inbox_actions BEGIN
  SELECT RAISE(ABORT, 'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
  SELECT RAISE(ABORT, 'INBOX_BUDGET_EXCEEDED') WHERE
    (NEW.kind IN ('send','draft','handoff') AND (SELECT count(*) FROM inbox_actions WHERE run_id=NEW.run_id AND kind IN ('send','draft','handoff'))
      >= (SELECT outbound_limit FROM inbox_runs WHERE id=NEW.run_id))
    OR (NEW.kind='calendar' AND (SELECT count(*) FROM inbox_actions WHERE run_id=NEW.run_id AND kind='calendar')
      >= (SELECT calendar_limit FROM inbox_runs WHERE id=NEW.run_id));
END;
CREATE TRIGGER inbox_actions_guard_update BEFORE UPDATE ON inbox_actions BEGIN
  SELECT RAISE(ABORT, 'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
  SELECT RAISE(ABORT, 'INBOX_ACTION_IDENTITY_IMMUTABLE') WHERE NEW.id!=OLD.id OR NEW.run_id!=OLD.run_id
    OR NEW.kind!=OLD.kind OR NEW.target!=OLD.target OR NEW.mode!=OLD.mode OR NEW.ordinal!=OLD.ordinal;
  SELECT RAISE(ABORT, 'INBOX_BUDGET_EXCEEDED') WHERE
    (NEW.kind IN ('send','draft','handoff') AND (SELECT count(*) FROM inbox_actions WHERE run_id=NEW.run_id AND kind IN ('send','draft','handoff'))
      > (SELECT outbound_limit FROM inbox_runs WHERE id=NEW.run_id))
    OR (NEW.kind='calendar' AND (SELECT count(*) FROM inbox_actions WHERE run_id=NEW.run_id AND kind='calendar')
      > (SELECT calendar_limit FROM inbox_runs WHERE id=NEW.run_id));
END;
${handoffSchema}
${platformSchema}
COMMIT;
`;

type BodyRow = { body: string };
const decode = <T>(row: unknown): T => JSON.parse((row as BodyRow).body) as T;
const rows = <T>(values: unknown[]): T[] => values.map((value) => decode<T>(value));

export class InboxStore {
  readonly sqlite: DatabaseSync;
  readonly filename: string;
  private readonly temporaryDirectory: string | null;

  constructor(filename: string) {
    this.temporaryDirectory = filename === ':memory:' ? mkdtempSync(path.join(tmpdir(), 'siftvane-inbox-')) : null;
    this.filename = this.temporaryDirectory ? path.join(this.temporaryDirectory, 'inbox.db') : filename;
    mkdirSync(path.dirname(this.filename), { recursive: true });
    this.sqlite = new DatabaseSync(this.filename);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.sqlite.exec(ddl);
    this.transaction(() => {
      const at = new Date().toISOString();
      for (const [mode, policy] of [['sandbox', sandboxPolicy], ['live', livePolicy]] as const) {
        this.sqlite.prepare('INSERT OR IGNORE INTO inbox_policies VALUES (?, 1, ?, ?)').run(mode, JSON.stringify(policy), at);
      }
      if (!this.state('seed-v1')) {
        for (const [scope, fixtures] of [['inbox', sandboxMessages]] as const) {
          for (const message of fixtures) {
            this.sqlite.prepare('INSERT INTO inbox_sandbox_messages VALUES (?, ?, ?)').run(message.id, scope, JSON.stringify(message));
            this.setEntity('sandbox', 'mail', message.id, { labels: message.labels });
          }
        }
        for (const event of sandboxEvents) this.setEntity('sandbox', 'calendar', event.id, event);
        this.setState('seed-v1', true);
      }
      if (!this.state('seed-v2')) {
        for (const message of sandboxMessages.filter(({ id }) =>
          ['flight-delay', 'meeting-team', 'newsletter-news', 'stale-nudge'].includes(id))) {
          this.sqlite.prepare("UPDATE inbox_sandbox_messages SET body=? WHERE id=? AND scope='inbox'")
            .run(JSON.stringify(message), message.id);
        }
        for (const message of sandboxHistory) {
          this.sqlite.prepare('INSERT OR IGNORE INTO inbox_sandbox_messages VALUES (?, ?, ?)').run(message.id, 'history', JSON.stringify(message));
          this.setEntity('sandbox', 'mail', message.id, { labels: message.labels });
        }
        this.setState('seed-v2', true);
      }
      if (!this.state('seed-v3-workspace')) {
        for (const [scope, fixtures] of [['workspace', workspaceMessages]] as const) {
          for (const message of fixtures) {
            this.sqlite.prepare('INSERT OR IGNORE INTO inbox_sandbox_messages VALUES (?, ?, ?)').run(message.id, scope, JSON.stringify(message));
          }
        }
        for (const photo of sandboxPhotos) {
          this.sqlite.prepare('INSERT OR IGNORE INTO sandbox_photos VALUES (?, ?)').run(photo.id, JSON.stringify(photo));
        }
        this.setState('seed-v3-workspace', true);
      }
      if (!this.state('seed-v5-drive')) {
        this.sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_sandbox_blobs (key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL)');
        for (const file of sandboxDriveFiles) {
          const bytes = file.blob?.data.length ?? 0;
          if (!this.entity('sandbox', 'workspace', file.key)) this.setEntity('sandbox', 'workspace', file.key, { ...file.state, ...(file.blob ? { bytes } : {}) } as Snapshot);
          if (file.blob) this.sqlite.prepare('INSERT OR REPLACE INTO workspace_sandbox_blobs VALUES (?, ?, ?)').run(file.key, file.blob.mime, file.blob.data);
        }
        this.setState('seed-v5-drive', true);
      }
      if (!this.state('seed-v6-replies')) {
        for (const message of sandboxReplyHistory) {
          this.sqlite.prepare('INSERT OR IGNORE INTO inbox_sandbox_messages VALUES (?, ?, ?)').run(message.id, 'replies', JSON.stringify(message));
        }
        this.setState('seed-v6-replies', true);
      }
    });
  }

  close() {
    this.sqlite.close();
    if (this.temporaryDirectory) rmSync(this.temporaryDirectory, { recursive: true, force: true });
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.sqlite.exec('COMMIT');
      return value;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  halt(active?: boolean): boolean {
    if (active !== undefined) {
      this.sqlite.prepare('UPDATE system_state SET kill_switch_active=? WHERE singleton=1').run(Number(active));
    }
    return Boolean(this.sqlite.prepare('SELECT kill_switch_active AS active FROM system_state WHERE singleton=1').get()?.active);
  }

  policy(mode: Mode) {
    if (mode.startsWith('live:')) this.sqlite.prepare(
      'INSERT OR IGNORE INTO inbox_policies VALUES (?, 1, ?, ?)',
    ).run(mode, JSON.stringify(livePolicy), new Date().toISOString());
    const row = this.sqlite.prepare('SELECT version,body FROM inbox_policies WHERE mode=? ORDER BY version DESC LIMIT 1').get(mode);
    if (!row) throw new Error('Policy unavailable.');
    return { version: Number(row.version), policy: inboxPolicySchema.parse(decode(row)) };
  }

  savePolicy(mode: Mode, current: number, policy: InboxPolicy) {
    return this.transaction(() => {
      if (this.policy(mode).version !== current) throw new Error('Policy changed. Reload the current version.');
      const version = current + 1;
      this.sqlite.prepare('INSERT INTO inbox_policies VALUES (?, ?, ?, ?)').run(mode, version, JSON.stringify(policy), new Date().toISOString());
      return { version, policy };
    });
  }

  state<T>(key: string): T | null {
    const row = this.sqlite.prepare('SELECT body FROM inbox_state WHERE key=?').get(key);
    return row ? decode<T>(row) : null;
  }

  setState(key: string, data: unknown) {
    this.sqlite.prepare('INSERT INTO inbox_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(data));
  }


  acquireLease(owner: string, now = Date.now()): boolean {
    return Number(this.sqlite.prepare(`
      INSERT INTO inbox_runner_lease VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
      WHERE inbox_runner_lease.owner=excluded.owner OR inbox_runner_lease.expires_at<=?
    `).run(owner, now + 15_000, now).changes) === 1;
  }

  releaseLease(owner: string) {
    this.sqlite.prepare('DELETE FROM inbox_runner_lease WHERE owner=?').run(owner);
  }

  interruptedRuns(): RunRecord[] {
    return rows(this.sqlite.prepare("SELECT body FROM inbox_runs WHERE json_extract(body,'$.status')='RUNNING'").all());
  }

  countChanges(runId: string): number {
    return Number(this.sqlite.prepare('SELECT count(*) AS count FROM inbox_changes WHERE run_id=?').get(runId)?.count ?? 0);
  }

  start(trigger: string, mode: Mode, version: number, policy: InboxPolicy): RunRecord {
    const record: RunRecord = {
      id: randomUUID(), trigger, mode, policyVersion: version, startedAt: new Date().toISOString(),
      completedAt: null, status: 'RUNNING', killSwitchTripped: false, error: null,
      emails: 0, conflicts: 0, threats: 0, steps: 0, outbound: 0, calendar: 0, tokens: 0, usd: 0,
    };
    this.sqlite.prepare('INSERT INTO inbox_runs VALUES (?, ?, ?, ?, ?)').run(record.id, mode, JSON.stringify(record), policy.outboundBudget, policy.calendarBudget);
    return record;
  }

  updateRun(run: RunRecord) {
    this.sqlite.prepare('UPDATE inbox_runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
  }

  run(id: string): RunRecord | null {
    const row = this.sqlite.prepare('SELECT body FROM inbox_runs WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  runs(mode: Mode, includeObservations = true): RunRecord[] {
    return rows(this.sqlite.prepare(`SELECT body FROM inbox_runs WHERE mode=?
      AND (? OR json_extract(body,'$.trigger') NOT LIKE 'mcp.%') ORDER BY rowid DESC LIMIT 100`).all(mode, Number(includeObservations)));
  }

  addStep(step: TraceStep, index: number) {
    this.sqlite.prepare('INSERT INTO inbox_steps VALUES (?, ?, ?)').run(step.run_id, index, JSON.stringify(step));
  }

  trace(runId: string): RunTrace {
    const steps = rows<TraceStep>(this.sqlite.prepare('SELECT body FROM inbox_steps WHERE run_id=? ORDER BY ordinal').all(runId));
    const terminal = steps.at(-1);
    return { run_id: runId, steps, step_count: steps.length, head_hash: terminal?.step_hash ?? genesisHash,
      mode: terminal?.mode, model_usage: terminal?.stage === 'REPORT' ? terminal.model_usage : undefined };
  }

  addChange(runId: string, data: unknown) {
    this.sqlite.prepare(`
      INSERT INTO inbox_changes SELECT ?,coalesce(max(ordinal),0)+1,? FROM inbox_changes WHERE run_id=?
    `).run(runId, JSON.stringify(data), runId);
  }

  changes<T>(runId: string): T[] {
    return rows(this.sqlite.prepare('SELECT body FROM inbox_changes WHERE run_id=? ORDER BY ordinal').all(runId));
  }

  claim(action: Claim): { created: boolean; action: Claim } {
    return this.transaction(() => {
      const existing = this.action(action.id);
      if (existing) return { created: false, action: existing };
      this.sqlite.prepare(`INSERT INTO inbox_actions
        SELECT ?,?,coalesce(max(ordinal),0)+1,?,?,?,?,? FROM inbox_actions WHERE run_id=?
      `).run(action.id, action.runId, action.mode, action.kind, action.target, action.status, JSON.stringify(action), action.runId);
      return { created: true, action };
    });
  }

  action(id: string): Claim | null {
    const row = this.sqlite.prepare('SELECT body FROM inbox_actions WHERE id=?').get(id);
    return row ? decode<Claim>(row) : null;
  }

  updateAction(action: Claim) {
    this.sqlite.prepare('UPDATE inbox_actions SET status=?,body=? WHERE id=?').run(action.status, JSON.stringify(action), action.id);
  }

  unreconciled(mode: Mode): Claim[] {
    return rows(this.sqlite.prepare(
      "SELECT body FROM inbox_actions WHERE mode=? AND status IN ('CLAIMED','APPLIED','REVIEW_REQUIRED') ORDER BY rowid LIMIT 100"
    ).all(mode));
  }

  actions(runId: string): Claim[] {
    return rows(this.sqlite.prepare('SELECT body FROM inbox_actions WHERE run_id=? ORDER BY ordinal').all(runId));
  }

  setEntity(mode: Mode, kind: ActionKind, id: string, body: Snapshot) {
    if (body === null) {
      this.sqlite.prepare('DELETE FROM inbox_entities WHERE mode=? AND kind=? AND id=?').run(mode, kind, id);
    } else {
      this.sqlite.prepare('INSERT INTO inbox_entities VALUES (?, ?, ?, ?) ON CONFLICT(mode,kind,id) DO UPDATE SET body=excluded.body')
        .run(mode, kind, id, JSON.stringify(body));
    }
  }

  entity(mode: Mode, kind: ActionKind, id: string): Snapshot {
    const row = this.sqlite.prepare('SELECT body FROM inbox_entities WHERE mode=? AND kind=? AND id=?').get(mode, kind, id);
    return row ? decode(row) : null;
  }

  entities<T = Snapshot>(mode: Mode, kind: ActionKind): T[] {
    return rows(this.sqlite.prepare('SELECT body FROM inbox_entities WHERE mode=? AND kind=? ORDER BY id').all(mode, kind));
  }

  approval(id: string): Attention | null {
    const row = this.sqlite.prepare('SELECT body FROM inbox_approvals WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  approvals(mode: Mode, runId?: string): Attention[] {
    const result = runId
      ? this.sqlite.prepare('SELECT body FROM inbox_approvals WHERE run_id=? ORDER BY rowid DESC').all(runId)
      : this.sqlite.prepare('SELECT body FROM inbox_approvals ORDER BY rowid DESC LIMIT 200').all();
    return rows<Attention>(result).filter((approval) => approval.mode === mode).map((approval) => {
      if (approval.status === 'PENDING' && Date.parse(approval.expires_at) <= Date.now()) return { ...approval, status: 'EXPIRED' };
      return approval;
    });
  }

  addApproval(approval: Attention) {
    this.sqlite.prepare('INSERT OR IGNORE INTO inbox_approvals VALUES (?, ?, ?, ?)')
      .run(approval.approval_id, approval.run_id, approval.status, JSON.stringify(approval));
  }

  updateApproval(approval: Attention) {
    this.sqlite.prepare('UPDATE inbox_approvals SET body=?,status=? WHERE id=?')
      .run(JSON.stringify(approval), approval.status, approval.approval_id);
  }
}
