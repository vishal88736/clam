export const podInboxSeed = [
  { id: 'sandbox', email: 'sandbox@siftvane.local', role: 'Primary inbox' },
  { id: 'triage', email: 'triage@siftvane.local', role: 'Triage agent' },
  { id: 'executor', email: 'executor@siftvane.local', role: 'Executor agent' },
] as const;

export const handoffSchema = `
CREATE TABLE IF NOT EXISTS agent_pods (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);
INSERT OR IGNORE INTO agent_pods VALUES ('sandbox-pod','Local sandbox Pod');
CREATE TABLE IF NOT EXISTS pod_inboxes (
  id TEXT PRIMARY KEY, pod_id TEXT NOT NULL REFERENCES agent_pods(id), email TEXT NOT NULL UNIQUE, role TEXT NOT NULL
);
INSERT OR IGNORE INTO pod_inboxes VALUES ${podInboxSeed.map((entry) => "('" + entry.id + "','sandbox-pod','" + entry.email + "','" + entry.role + "')").join(',')};
UPDATE pod_inboxes AS legacy SET email=id || '@siftvane.local'
  WHERE pod_id='sandbox-pod' AND email=id || '@clam.local'
  AND NOT EXISTS (SELECT 1 FROM pod_inboxes AS current WHERE current.email=legacy.id || '@siftvane.local');
CREATE TABLE IF NOT EXISTS pod_mcp_tokens (
  token_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL UNIQUE, inbox_id TEXT NOT NULL REFERENCES pod_inboxes(id),
  scopes TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY, pod_id TEXT NOT NULL REFERENCES agent_pods(id), thread_id TEXT NOT NULL,
  from_inbox_id TEXT NOT NULL REFERENCES pod_inboxes(id), to_inbox_id TEXT NOT NULL REFERENCES pod_inboxes(id),
  hop_count INTEGER NOT NULL CHECK(hop_count BETWEEN 0 AND 6), max_hops INTEGER NOT NULL CHECK(max_hops BETWEEN 1 AND 6),
  task_summary TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DELIVERED','COMPLETED','LOOP_HALTED','REJECTED')),
  trace_step_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_handoffs_thread ON agent_handoffs(pod_id,thread_id);
CREATE TABLE IF NOT EXISTS agent_handoff_resets (
  approval_id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, thread_id TEXT NOT NULL, after_row INTEGER NOT NULL,
  trace_step_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_consumptions (
  message_id TEXT NOT NULL, token_id TEXT NOT NULL, inbox_id TEXT NOT NULL, expected_sender_domain TEXT NOT NULL, consumed_at TEXT NOT NULL,
  PRIMARY KEY(inbox_id,message_id)
);
CREATE TABLE IF NOT EXISTS inbox_capability_events (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, capability TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS handoff_delivery_guard BEFORE INSERT ON agent_handoffs
WHEN NEW.status='DELIVERED' BEGIN
  SELECT RAISE(ABORT,'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
  SELECT RAISE(ABORT,'HANDOFF_NOT_RESERVED') WHERE NOT EXISTS (
    SELECT 1 FROM inbox_actions WHERE mode='sandbox' AND kind='handoff' AND target=NEW.id AND status='CLAIMED'
  );
END;
CREATE TRIGGER IF NOT EXISTS handoff_completion_guard BEFORE UPDATE OF status ON agent_handoffs
WHEN NEW.status='COMPLETED' BEGIN
  SELECT RAISE(ABORT,'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
END;
CREATE TRIGGER IF NOT EXISTS verification_consumption_guard BEFORE INSERT ON verification_consumptions BEGIN
  SELECT RAISE(ABORT,'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
END;
`;
