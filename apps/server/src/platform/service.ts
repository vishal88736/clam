import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { connectedServices, sandboxMcpOwner } from '../auth/google.js';
import type { InboxStore } from '../inbox/store.js';
import type { WorkspaceRegistry } from '../workspace/registry.js';
import type { PlannerCall } from './llmPlanner.js';
import type { WorkflowPlan } from './planner.js';

export const services = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'] as const;
export type Service = (typeof services)[number];
export type LogService = Service | 'policy' | 'system';
export const sourceClis = ['codex-cli', 'claude-code', 'cursor', 'cline', 'web', 'other_mcp'] as const;
export type SourceCli = (typeof sourceClis)[number];
export type ScheduleMode = 'one_shot' | 'continuous' | 'daily' | 'weekly';
export type AgentStatus = 'active' | 'input_required' | 'paused' | 'completed' | 'halted' | 'archived';
export type PolicyVerdictLabel = 'ALLOW_TIER_0' | 'ALLOW_TIER_1' | 'GATE_TIER_2' | 'BLOCKED';
export type SwitchedBy = 'cli_auto' | 'cli_manual' | 'web_ui';

export interface AgentState {
  phase: string;
  pending_approvals: string[];
  phase_started_at?: string;
  notes?: string[];
  last_error?: string | null;
  last_run_id?: string | null;
  running_run_id?: string | null;
  planning_calls?: PlannerCall[];
  interactive?: boolean;
  picker_uri?: string | null;
  /** What the trigger search saw on the last run; recipes are learned and backtested against it. */
  observed?: { step: string; message_ids: string[]; fields: string[] };
}

export interface AgentRecord {
  id: string;
  user_id: string;
  inbox_id: string;
  name: string;
  goal_prompt: string;
  source_cli: SourceCli;
  allowed_services: Service[];
  workflow_plan: WorkflowPlan;
  schedule_mode: ScheduleMode;
  interval_seconds: number | null;
  status: AgentStatus;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  state: AgentState;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  id: string;
  user_id: string;
  agent_id: string;
  mission_run_id: string | null;
  step_index: number;
  service: LogService;
  action_name: string;
  input_summary: string;
  output_summary: string;
  artifact_id: string | null;
  policy_verdict: PolicyVerdictLabel;
  policy_rule_id: string;
  verified: boolean;
  trace_step_hash: string | null;
  created_at: string;
}

export interface PlatformEvent {
  type: 'agent.created' | 'agent.switched' | 'agent.updated' | 'log.appended' | 'artifact.updated' | 'recipe.updated';
  user_id: string;
  data: unknown;
}

const now = () => new Date().toISOString();
type AgentPatch = Partial<Pick<AgentRecord, 'status' | 'next_run_at' | 'last_run_at' | 'run_count' | 'state'>>;
const clip = (value: string, max = 280) => value.length > max ? value.slice(0, max - 1) + '…' : value;

function decodeAgent(row: Record<string, unknown>): AgentRecord {
  const { allowed_services_json, workflow_plan_json, state_json, ...rest } = row;
  return {
    ...(rest as unknown as Omit<AgentRecord, 'allowed_services' | 'workflow_plan' | 'state'>),
    allowed_services: JSON.parse(String(allowed_services_json)) as Service[],
    workflow_plan: JSON.parse(String(workflow_plan_json)) as WorkflowPlan,
    state: JSON.parse(String(state_json)) as AgentState,
  };
}

/** System of record for users, persistent agents, agent switches, execution logs, and Workspace artifacts. */
export class PlatformService extends EventEmitter {
  constructor(private readonly store: InboxStore, private readonly users: DatabaseSync, readonly registry: WorkspaceRegistry) {
    super();
    this.setMaxListeners(100);
    const columns = new Set((users.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((column) => column.name));
    for (const [name, type] of [['active_agent_id', 'TEXT'], ['default_inbox_id', "TEXT NOT NULL DEFAULT 'sandbox'"], ['created_at', 'TEXT'], ['last_seen_at', 'TEXT']]) {
      if (!columns.has(name)) users.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
    this.ensureUser(sandboxMcpOwner);
  }

  publish(event: PlatformEvent) {
    this.emit('event', event);
  }

  ensureUser(userId: string, defaultInbox?: string) {
    const at = now();
    if (userId === sandboxMcpOwner) {
      this.users.prepare("INSERT OR IGNORE INTO users (id,google_sub,email,name,updated_at) VALUES (?,?,'sandbox@siftvane.local','Local sandbox operator',?)")
        .run(sandboxMcpOwner, 'local:' + sandboxMcpOwner, at);
    }
    this.users.prepare('UPDATE users SET created_at=coalesce(created_at,?), last_seen_at=?, default_inbox_id=coalesce(?,default_inbox_id) WHERE id=?')
      .run(at, at, defaultInbox ?? null, userId);
  }

  profile(userId: string, inboxId: string) {
    this.ensureUser(userId);
    const user = this.users.prepare('SELECT * FROM users WHERE id=?').get(userId) as Record<string, string | null> | undefined;
    if (!user) throw new Error('USER_NOT_AVAILABLE');
    const connection = inboxId === 'sandbox' ? null : this.users.prepare('SELECT granted_scopes,status FROM oauth_connections WHERE inbox_id=?')
      .get(inboxId) as { granted_scopes: string; status: string } | undefined;
    const active = user.active_agent_id ? this.agent(String(user.active_agent_id)) : null;
    return {
      id: user.id, google_sub: String(user.google_sub).startsWith('local:') ? null : user.google_sub, email: user.email,
      display_name: user.name, avatar_url: user.picture ?? null, active_agent_id: active?.id ?? null,
      default_inbox_id: user.default_inbox_id ?? 'sandbox', created_at: user.created_at, last_seen_at: user.last_seen_at,
      inbox_id: inboxId, mode: inboxId === 'sandbox' ? 'sandbox' : 'live',
      // The $0 sandbox emulates every service locally; live services reflect the scopes Google actually granted.
      services: inboxId === 'sandbox' ? [...services] : connection?.status === 'active' ? connectedServices(JSON.parse(connection.granted_scopes)) : [],
      active_agent: active,
    };
  }

  /** The mailbox owner's business profile: facts agents may use when writing replies ('' when not set). */
  businessProfile(inboxId: string) {
    const row = this.store.sqlite.prepare('SELECT body, updated_at FROM business_profiles WHERE inbox_id=?').get(inboxId) as
      { body: string; updated_at: string } | undefined;
    return { inbox_id: inboxId, text: row?.body ?? '', updated_at: row?.updated_at ?? null };
  }

  setBusinessProfile(inboxId: string, text: string) {
    const body = text.replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!body) this.store.sqlite.prepare('DELETE FROM business_profiles WHERE inbox_id=?').run(inboxId);
    else this.store.sqlite.prepare('INSERT INTO business_profiles VALUES (?,?,?) ON CONFLICT(inbox_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at')
      .run(inboxId, body, now());
    return this.businessProfile(inboxId);
  }

  createAgent(input: {
    userId: string; inboxId: string; name: string; goal: string; sourceCli: SourceCli; services: Service[]; plan: WorkflowPlan;
    scheduleMode: ScheduleMode; intervalSeconds: number | null; state?: Partial<AgentState>; startNow?: boolean;
  }): AgentRecord {
    const id = randomUUID();
    const at = now();
    this.ensureUser(input.userId, input.inboxId);
    this.store.sqlite.prepare(`INSERT INTO user_agents (id,user_id,inbox_id,name,goal_prompt,source_cli,allowed_services_json,workflow_plan_json,
      schedule_mode,interval_seconds,status,run_count,last_run_at,next_run_at,state_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',0,NULL,?,?,?,?)`).run(
      id, input.userId, input.inboxId, clip(input.name, 80), input.goal.slice(0, 4000), input.sourceCli, JSON.stringify(input.services),
      JSON.stringify(input.plan), input.scheduleMode, input.intervalSeconds, input.startNow === false ? null : at,
      JSON.stringify({ phase: 'start', pending_approvals: [], ...input.state }), at, at);
    const agent = this.agent(id)!;
    this.publish({ type: 'agent.created', user_id: input.userId, data: agent });
    return agent;
  }

  agent(id: string): AgentRecord | null {
    const row = this.store.sqlite.prepare('SELECT * FROM user_agents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? decodeAgent(row) : null;
  }

  ownedAgent(userId: string, id: string) {
    const agent = this.agent(id);
    if (!agent || agent.user_id !== userId) throw new Error('AGENT_NOT_AVAILABLE');
    return agent;
  }

  agents(userId: string): AgentRecord[] {
    return (this.store.sqlite.prepare("SELECT * FROM user_agents WHERE user_id=? AND status!='archived' ORDER BY created_at DESC, rowid DESC LIMIT 200")
      .all(userId) as Record<string, unknown>[]).map(decodeAgent);
  }

  private changeAgent(id: string, change: (current: AgentRecord) => AgentPatch | null) {
    const updated = this.store.transaction(() => {
      const current = this.agent(id);
      if (!current) throw new Error('AGENT_NOT_AVAILABLE');
      const patch = change(current);
      if (!patch) return null;
      const next = { ...current, ...patch, updated_at: now() };
      this.store.sqlite.prepare(`UPDATE user_agents SET status=?, next_run_at=?, last_run_at=?, run_count=?, state_json=?, updated_at=? WHERE id=?`)
        .run(next.status, next.next_run_at, next.last_run_at, next.run_count, JSON.stringify(next.state), next.updated_at, id);
      return next;
    });
    if (updated) this.publish({ type: 'agent.updated', user_id: updated.user_id, data: updated });
    return updated;
  }

  updateAgent(id: string, patch: AgentPatch) {
    return this.changeAgent(id, () => patch)!;
  }

  updateAgentIfStatus(id: string, status: AgentStatus, change: (current: AgentRecord) => AgentPatch) {
    return this.changeAgent(id, (current) => current.status === status ? change(current) : null);
  }

  claimDueAgent(id: string, runId: string) {
    const at = now();
    return this.changeAgent(id, (current) => current.status === 'active' && !current.state.running_run_id &&
      current.next_run_at !== null && current.next_run_at <= at ? {
        next_run_at: null, last_run_at: at, run_count: current.run_count + 1,
        state: { ...current.state, running_run_id: runId, last_error: null },
      } : null);
  }

  finishAgentRun(id: string, runId: string, finish: (current: AgentRecord) => AgentPatch) {
    return this.changeAgent(id, (current) => {
      if (current.state.running_run_id !== runId) return null;
      const result = finish(current);
      const patch = current.status === 'active' ? result : current.status === 'paused' && result.state?.pending_approvals.length ? {
        state: { ...current.state, phase: result.state.phase, pending_approvals: result.state.pending_approvals },
      } : {};
      return { ...patch, state: { ...current.state, ...patch.state, running_run_id: null, last_run_id: runId, planning_calls: undefined } };
    });
  }

  recoverAgentRuns(at = Date.now()) {
    const old = new Date(at - 15_000).toISOString();
    const rows = this.store.sqlite.prepare(`SELECT a.id, a.last_run_at, json_extract(a.state_json,'$.running_run_id') AS claimed_run,
      r.id AS ledger_run, r.body
      FROM user_agents a
      LEFT JOIN inbox_runs r ON r.id=coalesce(json_extract(a.state_json,'$.running_run_id'), (
        SELECT id FROM inbox_runs WHERE json_extract(body,'$.trigger')='agent:'||a.id ORDER BY rowid DESC LIMIT 1
      ))
      WHERE (json_extract(a.state_json,'$.running_run_id') IS NOT NULL OR (
          a.status='active' AND a.next_run_at IS NULL AND a.run_count>0 AND coalesce(json_extract(a.state_json,'$.interactive'),0)=0
        ))
        AND a.last_run_at<=?
        AND NOT EXISTS (SELECT 1 FROM inbox_runner_lease WHERE expires_at>?)
        AND (r.id IS NULL OR json_extract(r.body,'$.status')!='RUNNING')
        AND (r.id IS NULL OR json_extract(r.body,'$.completedAt')<=?)`).all(old, at, old) as
      { id: string; last_run_at: string; claimed_run: string | null; ledger_run: string | null; body: string | null }[];
    for (const row of rows) {
      const error = row.body ? JSON.parse(row.body).error as string | null : null;
      const recovery = (current: AgentRecord): AgentPatch => ({
        status: 'paused', next_run_at: null, state: {
          ...current.state, last_error: error ?? 'AGENT_RUN_INTERRUPTED', last_run_id: row.ledger_run ?? row.claimed_run,
        },
      });
      if (row.claimed_run) this.finishAgentRun(row.id, row.claimed_run, recovery);
      else this.changeAgent(row.id, (current) => current.status === 'active' && !current.next_run_at &&
        !current.state.running_run_id && current.last_run_at === row.last_run_at ? recovery(current) : null);
    }
  }

  /** Records follow-up steps the LLM added while reviewing its own progress. */
  updatePlan(id: string, plan: WorkflowPlan, runId: string) {
    const changed = this.store.sqlite.prepare(`UPDATE user_agents SET workflow_plan_json=?,
      allowed_services_json=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(allowed_services_json) UNION SELECT value FROM json_each(?))),
      updated_at=? WHERE id=? AND status='active' AND json_extract(state_json,'$.running_run_id')=?`)
      .run(JSON.stringify(plan), JSON.stringify(plan.services), now(), id, runId);
    if (!Number(changed.changes)) return null;
    const agent = this.agent(id)!;
    this.publish({ type: 'agent.updated', user_id: agent.user_id, data: agent });
    return agent;
  }

  dueAgents(at = now()): AgentRecord[] {
    return (this.store.sqlite.prepare("SELECT * FROM user_agents WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 5")
      .all(at) as Record<string, unknown>[]).map(decodeAgent);
  }

  waitingAgents(): AgentRecord[] {
    return (this.store.sqlite.prepare("SELECT * FROM user_agents WHERE status='input_required' ORDER BY updated_at LIMIT 50")
      .all() as Record<string, unknown>[]).map(decodeAgent);
  }

  /** Kill switch: every running or waiting agent becomes halted; the SQLite trigger blocks reactivation while latched. */
  haltAll(reason: string) {
    const rows = this.store.sqlite.prepare("SELECT id FROM user_agents WHERE status IN ('active','input_required')").all() as { id: string }[];
    for (const { id } of rows) {
      const agent = this.agent(id)!;
      this.updateAgent(id, { status: 'halted', state: { ...agent.state, last_error: reason } });
      this.log({ userId: agent.user_id, agentId: id, runId: null, service: 'system', action: 'kill_switch_halt',
        input: reason, output: 'Agent halted by the out-of-band kill switch.', verdict: 'BLOCKED', ruleId: 'KILL_SWITCH', verified: true });
    }
    // Saved recipes stop too; switching one back on is blocked by a trigger while the latch is set.
    const recipes = this.store.sqlite.prepare("SELECT id, user_id FROM agent_recipes WHERE status='enabled'").all() as { id: string; user_id: string }[];
    this.store.sqlite.prepare("UPDATE agent_recipes SET status='paused', next_run_at=NULL, updated_at=? WHERE status='enabled'").run(now());
    for (const recipe of recipes) this.publish({ type: 'recipe.updated', user_id: recipe.user_id, data: { id: recipe.id } });
    return rows.length;
  }

  activeAgentId(userId: string) {
    const row = this.users.prepare('SELECT active_agent_id FROM users WHERE id=?').get(userId) as { active_agent_id: string | null } | undefined;
    return row?.active_agent_id ?? null;
  }

  switchAgent(userId: string, toId: string, switchedBy: SwitchedBy, reason: string) {
    const target = this.ownedAgent(userId, toId);
    const from = this.activeAgentId(userId);
    const entry = { id: randomUUID(), user_id: userId, from_agent_id: from, to_agent_id: target.id, switched_by: switchedBy,
      reason: clip(reason || 'Switched active agent', 300), created_at: now() };
    this.store.sqlite.prepare('INSERT INTO agent_switch_history VALUES (?,?,?,?,?,?,?)')
      .run(entry.id, entry.user_id, entry.from_agent_id, entry.to_agent_id, entry.switched_by, entry.reason, entry.created_at);
    this.users.prepare('UPDATE users SET active_agent_id=?, last_seen_at=? WHERE id=?').run(target.id, entry.created_at, userId);
    this.publish({ type: 'agent.switched', user_id: userId, data: { ...entry, to_agent_name: target.name } });
    return { ...entry, switched: from !== target.id };
  }

  switches(userId: string, limit = 50) {
    return this.store.sqlite.prepare(`SELECT s.*, t.name AS to_agent_name, f.name AS from_agent_name FROM agent_switch_history s
      JOIN user_agents t ON t.id=s.to_agent_id LEFT JOIN user_agents f ON f.id=s.from_agent_id
      WHERE s.user_id=? ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`).all(userId, limit);
  }

  nextStepIndex(agentId: string) {
    const row = this.store.sqlite.prepare('SELECT coalesce(max(step_index),0)+1 AS next FROM agent_execution_logs WHERE agent_id=?').get(agentId) as { next: number };
    return Number(row.next);
  }

  log(input: {
    userId: string; agentId: string; runId: string | null; service: LogService; action: string; input: string; output: string;
    verdict: PolicyVerdictLabel; ruleId: string; verified: boolean; artifactId?: string | null; traceStepHash?: string | null;
  }): LogEntry {
    const entry: LogEntry = {
      id: randomUUID(), user_id: input.userId, agent_id: input.agentId, mission_run_id: input.runId, step_index: this.nextStepIndex(input.agentId),
      service: input.service, action_name: input.action, input_summary: clip(input.input), output_summary: clip(input.output, 700),
      artifact_id: input.artifactId ?? null, policy_verdict: input.verdict, policy_rule_id: input.ruleId, verified: input.verified,
      trace_step_hash: input.traceStepHash ?? null, created_at: now(),
    };
    this.store.sqlite.prepare('INSERT INTO agent_execution_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      entry.id, entry.user_id, entry.agent_id, entry.mission_run_id, entry.step_index, entry.service, entry.action_name,
      entry.input_summary, entry.output_summary, entry.artifact_id, entry.policy_verdict, entry.policy_rule_id,
      Number(entry.verified), entry.trace_step_hash, entry.created_at);
    this.publish({ type: 'log.appended', user_id: input.userId, data: entry });
    return entry;
  }

  logs(userId: string, filter: { agentId?: string; service?: string; limit?: number } = {}): LogEntry[] {
    return (this.store.sqlite.prepare(`SELECT l.*, a.name AS agent_name FROM agent_execution_logs l JOIN user_agents a ON a.id=l.agent_id
      WHERE l.user_id=? AND (? IS NULL OR l.agent_id=?) AND (? IS NULL OR l.service=?) ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`)
      .all(userId, filter.agentId ?? null, filter.agentId ?? null, filter.service ?? null, filter.service ?? null, Math.min(filter.limit ?? 100, 500)) as
      Array<Record<string, unknown>>).map((row) => ({ ...row, verified: Boolean(row.verified) }) as unknown as LogEntry);
  }

  artifacts(userId: string, agentId?: string) {
    return this.registry.list(userId, { agentId });
  }

  artifactChanged(userId: string, artifactId: string | null) {
    if (!artifactId) return;
    const row = this.registry.byId(artifactId);
    if (row) this.publish({ type: 'artifact.updated', user_id: userId, data: row });
  }
}
