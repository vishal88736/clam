import { z } from 'zod';

/** Shared types for the audit log, the kill switch, prompt-injection scanning, and in-memory email. */

export const AuditDecisionSchema = z.enum([
  'ALLOW',
  'DENY',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'KILL_SWITCH_ENGAGED',
  'KILL_SWITCH_RESUMED',
  'CIRCUIT_BREAKER_TRIPPED',
]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

export const InjectionSeveritySchema = z.enum(['none', 'low', 'high', 'critical']);
export type InjectionSeverity = z.infer<typeof InjectionSeveritySchema>;

export const PromptInjectionResultSchema = z.object({
  detected: z.boolean(),
  risk_score: z.number().min(0).max(1),
  severity: InjectionSeveritySchema,
  signals: z.array(z.string()),
  exfiltration_target_detected: z.boolean(),
});
export type PromptInjectionResult = z.infer<typeof PromptInjectionResultSchema>;

/**
 * Ephemeral email representation held strictly in RAM during request handling.
 * NEVER persisted to disk, SQLite, or audit logs.
 */
export interface EphemeralEmail {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  body: string;
  html?: string;
  replyTo?: string;
  verifiedSender?: boolean;
  contextOnly?: boolean;
  internetId?: string;
  references?: string[];
  labels: string[];
  hasAttachments: boolean;
  attachmentNames?: string[];
  attachmentParts?: { name: string; mime: string; data: string }[];
  trust_level?: 'untrusted_external';
  threat_signals?: string[];
  quarantined?: boolean;
  isUnread?: boolean;
}

export interface AuditLogEntry {
  id: string;
  trace_id: string;
  run_id: string | null;
  timestamp: string;
  agent_id: string;
  agent_name: string;
  mcp_tool: string;
  decision: AuditDecision;
  matched_rule_id: string | null;
  rule_citation: string;
  semantic_category: string | null;
  confidence: number | null;
  injection_risk_score: number;
  injection_signals: string[];
  approval_id: string | null;
  message_id_hash: string | null;
  latency_ms: number;
}

export type KillSwitchStatus = 'ARMED' | 'HALTED';
export type KillSwitchTriggerMode = 'manual_ui' | 'manual_cli' | 'manual_api' | 'circuit_breaker' | null;

export interface CircuitBreakerConfig {
  violation_threshold: number;
  window_seconds: number;
  max_calls_per_min: number;
  trip_on_critical_injection: boolean;
}

export interface KillSwitchState {
  status: KillSwitchStatus;
  trigger_mode: KillSwitchTriggerMode;
  engaged_at: string | null;
  engaged_by: string | null;
  reason: string | null;
  halted_agents: string[];
  active_runs_count: number;
  aborted_inflight_count: number;
  circuit_breaker: CircuitBreakerConfig;
  recent_violation_count: number;
}
