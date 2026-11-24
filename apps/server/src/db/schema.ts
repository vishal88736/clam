import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Zero-Retention Schema:
 * Strictly stores agent definitions, compiled Policy IR, hashed MCP tokens,
 * encrypted OAuth/channel vault blobs, HITL approval metadata (no email body),
 * and metadata-only audit logs.
 */

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  rawRules: text('raw_rules').notNull(),
  policyIrJson: text('policy_ir_json').notNull(),
  status: text('status').notNull().default('active'),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentTokens = sqliteTable('agent_tokens', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  tokenHash: text('token_hash').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull(),
  mcpTool: text('mcp_tool').notNull(),
  matchedRuleId: text('matched_rule_id'),
  ruleCitation: text('rule_citation').notNull(),
  status: text('status').notNull(), // PENDING | APPROVED | REJECTED | EXPIRED
  deliveryStatusJson: text('delivery_status_json').notNull(),
  payloadHash: text('payload_hash').notNull(),
  payloadWiped: integer('payload_wiped').notNull().default(0),
  resolvedBy: text('resolved_by'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull(),
  mcpTool: text('mcp_tool').notNull(),
  decision: text('decision').notNull(),
  matchedRuleId: text('matched_rule_id'),
  ruleCitation: text('rule_citation').notNull(),
  semanticCategory: text('semantic_category'),
  confidence: real('confidence'),
  approvalId: text('approval_id'),
  messageIdHash: text('message_id_hash'),
  latencyMs: integer('latency_ms').notNull(),
});

export const vaultSecrets = sqliteTable('vault_secrets', {
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  updatedAt: text('updated_at').notNull(),
});
