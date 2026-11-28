import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';

export type SiftvaneDatabase = SqliteRemoteDatabase<typeof schema>;

export interface DbHandle {
  db: SiftvaneDatabase;
  sqlite: DatabaseSync;
  close(): void;
}

const CREATE_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mcp_tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  matched_rule_id TEXT,
  rule_citation TEXT NOT NULL,
  semantic_category TEXT,
  confidence REAL,
  injection_risk_score REAL NOT NULL DEFAULT 0,
  injection_signals_json TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  message_id_hash TEXT,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent ON audit_logs(agent_id);

CREATE TABLE IF NOT EXISTS kill_switch_state (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ARMED',
  trigger_mode TEXT,
  engaged_at TEXT,
  engaged_by TEXT,
  reason TEXT,
  halted_agents_json TEXT NOT NULL DEFAULT '[]',
  aborted_inflight_count INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  name TEXT NOT NULL, picture TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inboxes (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), adapter_type TEXT NOT NULL,
  google_sub TEXT, email TEXT NOT NULL, UNIQUE(user_id, google_sub)
);
INSERT OR IGNORE INTO inboxes (id, adapter_type, email) VALUES ('sandbox', 'sandbox', 'sandbox@siftvane.local');
INSERT OR IGNORE INTO inboxes (id, adapter_type, email) VALUES
  ('triage', 'agent_local', 'triage@siftvane.local'), ('executor', 'agent_local', 'executor@siftvane.local');
UPDATE inboxes SET email=id || '@siftvane.local'
  WHERE adapter_type IN ('sandbox','agent_local') AND email=id || '@clam.local';
UPDATE users SET email='sandbox@siftvane.local'
  WHERE google_sub='local:clam-local-sandbox' AND email='sandbox@clam.local';
CREATE TABLE IF NOT EXISTS oauth_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  inbox_id TEXT NOT NULL UNIQUE REFERENCES inboxes(id), google_sub TEXT NOT NULL, email TEXT NOT NULL,
  granted_scopes TEXT NOT NULL, encrypted_access_token TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL,
  iv TEXT NOT NULL, auth_tag TEXT NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','reauth_required','revoked')), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  inbox_id TEXT NOT NULL REFERENCES inboxes(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_oauth_flows (
  id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL,
  intent TEXT NOT NULL, session_hash TEXT, inbox_id TEXT, expires_at INTEGER NOT NULL, expected_sub TEXT
);
CREATE TABLE IF NOT EXISTS inbox_mcp_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  inbox_id TEXT NOT NULL REFERENCES inboxes(id), scopes TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`;

export function createDatabase(databasePath: string): DbHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec(CREATE_TABLES_SQL);

  // Safe additive migration for pre-existing local SQLite databases
  const auditCols = sqlite.prepare(`PRAGMA table_info(audit_logs)`).all() as { name: string }[];
  const colSet = new Set(auditCols.map((c) => c.name));
  if (!colSet.has('trace_id')) {
    sqlite.exec(`ALTER TABLE audit_logs ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!colSet.has('run_id')) {
    sqlite.exec(`ALTER TABLE audit_logs ADD COLUMN run_id TEXT`);
  }
  if (!colSet.has('injection_risk_score')) {
    sqlite.exec(`ALTER TABLE audit_logs ADD COLUMN injection_risk_score REAL NOT NULL DEFAULT 0`);
  }
  if (!colSet.has('injection_signals_json')) {
    sqlite.exec(
      `ALTER TABLE audit_logs ADD COLUMN injection_signals_json TEXT NOT NULL DEFAULT '[]'`
    );
  }

  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      const stmt = sqlite.prepare(sql);
      const normalizedParams = params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === 'boolean') return p ? 1 : 0;
        return p;
      });

      if (method === 'run') {
        stmt.run(...normalizedParams);
        return { rows: [] };
      }

      stmt.setReturnArrays(true);

      if (method === 'get') {
        const row = stmt.get(...normalizedParams) as unknown as unknown[] | undefined;
        return { rows: (row ?? undefined) as unknown as unknown[] };
      }

      const rows = stmt.all(...normalizedParams) as unknown as unknown[][];
      return { rows };
    },
    { schema }
  );

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
