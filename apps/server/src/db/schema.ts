import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Zero-Retention Schema:
 * Strictly stores agent definitions, compiled Policy IR, hashed MCP tokens,
 * encrypted OAuth/channel vault blobs, HITL approval metadata (no email body),
 * and metadata-only audit logs.
 */

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  traceId: text('trace_id').notNull().default(''),
  runId: text('run_id'),
  timestamp: text('timestamp').notNull(),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull(),
  mcpTool: text('mcp_tool').notNull(),
  decision: text('decision').notNull(),
  matchedRuleId: text('matched_rule_id'),
  ruleCitation: text('rule_citation').notNull(),
  semanticCategory: text('semantic_category'),
  confidence: real('confidence'),
  injectionRiskScore: real('injection_risk_score').notNull().default(0),
  injectionSignalsJson: text('injection_signals_json').notNull().default('[]'),
  approvalId: text('approval_id'),
  messageIdHash: text('message_id_hash'),
  latencyMs: integer('latency_ms').notNull(),
});

export const killSwitchState = sqliteTable('kill_switch_state', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('ARMED'),
  triggerMode: text('trigger_mode'),
  engagedAt: text('engaged_at'),
  engagedBy: text('engaged_by'),
  reason: text('reason'),
  haltedAgentsJson: text('halted_agents_json').notNull().default('[]'),
  abortedInflightCount: integer('aborted_inflight_count').notNull().default(0),
  circuitBreakerJson: text('circuit_breaker_json').notNull().default('{}'),
  updatedAt: text('updated_at').notNull(),
});

