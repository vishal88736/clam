import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { AuditDecision, AuditLogEntry } from '@clam/shared';
import type { ClamDatabase } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { hashOpaqueId } from '../mail/vault.js';

export type RealtimeEventType =
  | 'audit.entry'
  | 'approval.created'
  | 'approval.resolved'
  | 'approval.expired'
  | 'agent.updated'
  | 'settings.updated';

export interface RealtimeEvent {
  type: RealtimeEventType;
  timestamp: string;
  data: unknown;
}

export class RealtimeEventHub extends EventEmitter {
  publish(type: RealtimeEventType, data: unknown): void {
    const evt: RealtimeEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emit('event', evt);
  }
}

export interface RecordAuditInput {
  agentId: string;
  agentName: string;
  mcpTool: string;
  decision: AuditDecision;
  matchedRuleId: string | null;
  ruleCitation: string;
  semanticCategory: string | null;
  confidence: number | null;
  approvalId?: string | null;
  rawMessageId?: string | null;
  latencyMs: number;
}

export interface AuditQueryFilters {
  agentId?: string;
  decision?: AuditDecision;
  mcpTool?: string;
  fromIso?: string;
  toIso?: string;
  search?: string;
  limit?: number;
}

export class AuditLogger {
  constructor(
    private readonly db: ClamDatabase,
    private readonly hub: RealtimeEventHub
  ) {}

  async record(input: RecordAuditInput): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      timestamp: new Date().toISOString(),
      agent_id: input.agentId,
      agent_name: input.agentName,
      mcp_tool: input.mcpTool,
      decision: input.decision,
      matched_rule_id: input.matchedRuleId,
      rule_citation: input.ruleCitation,
      semantic_category: input.semanticCategory,
      confidence: input.confidence,
      approval_id: input.approvalId ?? null,
      message_id_hash: input.rawMessageId ? hashOpaqueId(input.rawMessageId) : null,
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
    };

    await this.db.insert(auditLogs).values({
      id: entry.id,
      timestamp: entry.timestamp,
      agentId: entry.agent_id,
      agentName: entry.agent_name,
      mcpTool: entry.mcp_tool,
      decision: entry.decision,
      matchedRuleId: entry.matched_rule_id,
      ruleCitation: entry.rule_citation,
      semanticCategory: entry.semantic_category,
      confidence: entry.confidence,
      approvalId: entry.approval_id,
      messageIdHash: entry.message_id_hash,
      latencyMs: entry.latency_ms,
    });

    this.hub.publish('audit.entry', entry);
    return entry;
  }

  async list(filters: AuditQueryFilters = {}): Promise<AuditLogEntry[]> {
    const conditions = [];
    if (filters.agentId) conditions.push(eq(auditLogs.agentId, filters.agentId));
    if (filters.decision) conditions.push(eq(auditLogs.decision, filters.decision));
    if (filters.mcpTool) conditions.push(eq(auditLogs.mcpTool, filters.mcpTool));
    if (filters.fromIso) conditions.push(gte(auditLogs.timestamp, filters.fromIso));
    if (filters.toIso) conditions.push(lte(auditLogs.timestamp, filters.toIso));

    const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .all();

    const mapped: AuditLogEntry[] = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      agent_id: r.agentId,
      agent_name: r.agentName,
      mcp_tool: r.mcpTool,
      decision: r.decision as AuditDecision,
      matched_rule_id: r.matchedRuleId,
      rule_citation: r.ruleCitation,
      semantic_category: r.semanticCategory,
      confidence: r.confidence,
      approval_id: r.approvalId,
      message_id_hash: r.messageIdHash,
      latency_ms: r.latencyMs,
    }));

    if (filters.search?.trim()) {
      const q = filters.search.trim().toLowerCase();
      return mapped.filter(
        (m) =>
          m.agent_name.toLowerCase().includes(q) ||
          m.mcp_tool.toLowerCase().includes(q) ||
          m.rule_citation.toLowerCase().includes(q) ||
          (m.semantic_category ?? '').toLowerCase().includes(q) ||
          (m.message_id_hash ?? '').toLowerCase().includes(q)
      );
    }

    return mapped;
  }

  async getMetrics() {
    const rows = await this.db
      .select({
        decision: auditLogs.decision,
        count: sql<number>`count(*)`,
      })
      .from(auditLogs)
      .groupBy(auditLogs.decision)
      .all();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      counts[r.decision] = Number(r.count);
      total += Number(r.count);
    }

    return {
      total_intercepted: total,
      allowed: (counts.ALLOW ?? 0) + (counts.APPROVED ?? 0),
      blocked: (counts.DENY ?? 0) + (counts.REJECTED ?? 0) + (counts.EXPIRED ?? 0),
      pending_decisions: counts.PENDING_APPROVAL ?? 0,
      breakdown: counts,
    };
  }
}
