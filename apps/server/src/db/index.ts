import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';

export type ClamDatabase = SqliteRemoteDatabase<typeof schema>;

export interface DbHandle {
  db: ClamDatabase;
  sqlite: DatabaseSync;
  close(): void;
}

const CREATE_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  raw_rules TEXT NOT NULL,
  policy_ir_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mcp_tool TEXT NOT NULL,
  matched_rule_id TEXT,
  rule_citation TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_status_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_wiped INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mcp_tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  matched_rule_id TEXT,
  rule_citation TEXT NOT NULL,
  semantic_category TEXT,
  confidence REAL,
  approval_id TEXT,
  message_id_hash TEXT,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent ON audit_logs(agent_id);

CREATE TABLE IF NOT EXISTS vault_secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function createDatabase(databasePath: string): DbHandle {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec(CREATE_TABLES_SQL);

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
