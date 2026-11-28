/**
 * Durable platform state: persistent CLI/Web agents, agent switches, per-step execution logs,
 * and every Workspace artifact Siftvane created or updated. Lives in the inbox SQLite file so that the
 * same `system_state.kill_switch_active` latch guards it through triggers.
 */
export const platformSchema = `
CREATE TABLE IF NOT EXISTS user_agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal_prompt TEXT NOT NULL,
  source_cli TEXT NOT NULL CHECK (source_cli IN ('codex-cli','claude-code','cursor','cline','web','other_mcp')),
  allowed_services_json TEXT NOT NULL,
  workflow_plan_json TEXT NOT NULL,
  schedule_mode TEXT NOT NULL CHECK (schedule_mode IN ('one_shot','continuous','daily','weekly')),
  interval_seconds INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','input_required','paused','completed','halted','archived')),
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_agents_user ON user_agents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_agents_due ON user_agents(status, next_run_at);

-- What agents may say about the user's business when writing replies (one free-text profile per mailbox).
CREATE TABLE IF NOT EXISTS business_profiles (
  inbox_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_switch_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_agent_id TEXT REFERENCES user_agents(id),
  to_agent_id TEXT NOT NULL REFERENCES user_agents(id),
  switched_by TEXT NOT NULL CHECK (switched_by IN ('cli_auto','cli_manual','web_ui')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_switch_user ON agent_switch_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES user_agents(id),
  mission_run_id TEXT,
  step_index INTEGER NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('gmail','calendar','drive','docs','sheets','photos','policy','system')),
  action_name TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  output_summary TEXT NOT NULL,
  artifact_id TEXT,
  policy_verdict TEXT NOT NULL CHECK (policy_verdict IN ('ALLOW_TIER_0','ALLOW_TIER_1','GATE_TIER_2','BLOCKED')),
  policy_rule_id TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  trace_step_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_logs_user ON agent_execution_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_logs_agent ON agent_execution_logs(agent_id, step_index);

CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT REFERENCES user_agents(id),
  inbox_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('drive_folder','drive_file','google_doc','google_sheet','google_photo')),
  logical_key TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  parent_folder_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  last_updated_by_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (inbox_id, logical_key)
);
CREATE INDEX IF NOT EXISTS workspace_artifacts_user ON workspace_artifacts(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_photos (id TEXT PRIMARY KEY, body TEXT NOT NULL);

-- Previous bytes of a Drive file Siftvane overwrote, keyed by content hash, so rollback can restore it.
CREATE TABLE IF NOT EXISTS workspace_file_backups (
  inbox_id TEXT NOT NULL, logical_key TEXT NOT NULL, md5 TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, logical_key, md5)
);

-- Google Photos Picker sessions: the user chooses receipts in Google's own UI; Siftvane only reads what was picked.
CREATE TABLE IF NOT EXISTS photo_picker_sessions (
  inbox_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, picker_uri TEXT NOT NULL, created_at TEXT NOT NULL, expire_time TEXT
);

-- Saved recipes ("muscle memory"): an agent's verified program with argument provenance, rules, and a backtest.
CREATE TABLE IF NOT EXISTS agent_recipes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL REFERENCES user_agents(id),
  name TEXT NOT NULL,
  goal_prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','enabled','paused','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  backtest_json TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_recipes_user ON agent_recipes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_recipes_due ON agent_recipes(status, next_run_at);

-- One row per email a recipe has decided on, so every request is handled exactly once.
CREATE TABLE IF NOT EXISTS recipe_items (
  recipe_id TEXT NOT NULL REFERENCES agent_recipes(id),
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done','awaiting_approval','declined','escalated','skipped')),
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  approval_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, message_id)
);

CREATE TABLE IF NOT EXISTS recipe_runs (
  run_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES agent_recipes(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  handled INTEGER NOT NULL,
  held INTEGER NOT NULL,
  escalated INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_runs_recipe ON recipe_runs(recipe_id, created_at DESC);

DROP TRIGGER IF EXISTS agent_recipes_halt;
CREATE TRIGGER agent_recipes_halt BEFORE UPDATE OF status ON agent_recipes
  WHEN NEW.status = 'enabled' AND OLD.status <> 'enabled' BEGIN
  SELECT RAISE(ABORT, 'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
END;
DROP TRIGGER IF EXISTS recipe_runs_append_only;
CREATE TRIGGER recipe_runs_append_only BEFORE UPDATE ON recipe_runs BEGIN
  SELECT RAISE(ABORT, 'RECIPE_RUN_IMMUTABLE');
END;

DROP TRIGGER IF EXISTS agent_logs_append_only_update;
DROP TRIGGER IF EXISTS agent_logs_append_only_delete;
DROP TRIGGER IF EXISTS agent_switch_append_only;
DROP TRIGGER IF EXISTS workspace_artifacts_halt;
DROP TRIGGER IF EXISTS user_agents_halt;
CREATE TRIGGER agent_logs_append_only_update BEFORE UPDATE ON agent_execution_logs BEGIN
  SELECT RAISE(ABORT, 'AGENT_LOG_IMMUTABLE');
END;
CREATE TRIGGER agent_logs_append_only_delete BEFORE DELETE ON agent_execution_logs BEGIN
  SELECT RAISE(ABORT, 'AGENT_LOG_IMMUTABLE');
END;
CREATE TRIGGER agent_switch_append_only BEFORE UPDATE ON agent_switch_history BEGIN
  SELECT RAISE(ABORT, 'AGENT_SWITCH_IMMUTABLE');
END;
CREATE TRIGGER workspace_artifacts_halt BEFORE INSERT ON workspace_artifacts BEGIN
  SELECT RAISE(ABORT, 'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
END;
CREATE TRIGGER user_agents_halt BEFORE UPDATE OF status ON user_agents
  WHEN NEW.status IN ('active','input_required') AND OLD.status NOT IN ('active','input_required') BEGIN
  SELECT RAISE(ABORT, 'INBOX_HALTED') WHERE (SELECT kill_switch_active FROM system_state WHERE singleton=1)=1;
END;
`;
