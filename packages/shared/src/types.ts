import { z } from 'zod';

export const AgentActionSchema = z.enum([
  'list',
  'read',
  'draft',
  'send',
  'archive',
  'label',
  'delete',
  'write_artifact',
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const McpToolNameSchema = z.enum([
  'list_emails',
  'search_emails',
  'read_email',
  'create_draft',
  'send_email',
  'archive_email',
  'apply_label',
  'delete_email',
  'save_itinerary_artifact',
]);
export type McpToolName = z.infer<typeof McpToolNameSchema>;

export const SensitiveCategorySchema = z.enum([
  'password_resets',
  'otp_2fa',
  'bank_security_alerts',
  'medical_records',
  'legal_confidential',
  'crypto_seed_recovery',
]);
export type SensitiveCategory = z.infer<typeof SensitiveCategorySchema>;

export const DEFAULT_SENSITIVE_CATEGORIES: SensitiveCategory[] = [
  'password_resets',
  'otp_2fa',
  'bank_security_alerts',
  'medical_records',
  'legal_confidential',
  'crypto_seed_recovery',
];

export const SENSITIVE_CATEGORY_META: Record<
  SensitiveCategory,
  { label: string; description: string }
> = {
  password_resets: {
    label: 'Password Resets',
    description: 'Account password reset links and recovery emails',
  },
  otp_2fa: {
    label: 'OTPs & 2FA Codes',
    description: 'One-time passcodes, login codes, and multi-factor tokens',
  },
  bank_security_alerts: {
    label: 'Bank Security Alerts',
    description: 'Fraud warnings, wire confirmations, and card lock notices',
  },
  medical_records: {
    label: 'Medical Records',
    description: 'Lab results, patient portal notices, and health records',
  },
  legal_confidential: {
    label: 'Legal & Privileged',
    description: 'Attorney-client privileged emails, NDAs, and legal notices',
  },
  crypto_seed_recovery: {
    label: 'Crypto Seed Recovery',
    description: 'Wallet recovery phrases, hardware key backups, and custody resets',
  },
};

export const SemanticScopeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  examples: z.array(z.string()).default([]),
  source_clause_id: z.string().optional(),
});
export type SemanticScope = z.infer<typeof SemanticScopeSchema>;

export const ConditionalAskRuleSchema = z.object({
  id: z.string().min(1),
  action: AgentActionSchema,
  condition_type: z.enum(['always', 'external_domain', 'keyword_match', 'new_recipient']),
  condition_value: z.string().optional(),
  description: z.string().min(1),
  source_clause: z.string().min(1),
});
export type ConditionalAskRule = z.infer<typeof ConditionalAskRuleSchema>;

export const PolicyClauseSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  effect: z.enum(['allow', 'ask_first', 'hard_deny', 'scope', 'sensitive_override']),
  summary: z.string().min(1),
});
export type PolicyClause = z.infer<typeof PolicyClauseSchema>;

export const CompilerModeSchema = z.enum([
  'deterministic_heuristic',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
]);
export type CompilerMode = z.infer<typeof CompilerModeSchema>;

export const PolicyIRSchema = z.object({
  version: z.literal(1),
  compiled_at: z.string(),
  compiler_mode: CompilerModeSchema,
  raw_rules: z.string(),
  allowed_actions: z.array(AgentActionSchema),
  hard_denied_actions: z.array(AgentActionSchema),
  ask_first_actions: z.array(AgentActionSchema),
  conditional_ask_rules: z.array(ConditionalAskRuleSchema),
  semantic_allow_scopes: z.array(SemanticScopeSchema),
  sensitive_denylist: z.array(SensitiveCategorySchema),
  overridden_sensitive_categories: z.array(SensitiveCategorySchema).default([]),
  rule_clauses: z.array(PolicyClauseSchema),
  warnings: z.array(z.string()).default([]),
});
export type PolicyIR = z.infer<typeof PolicyIRSchema>;

export const PolicyDecisionSchema = z.enum(['ALLOW', 'DENY', 'PENDING_APPROVAL']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

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

export const SemanticClassificationResultSchema = z.object({
  matched_scope: z.string().nullable(),
  sensitive_flag: SensitiveCategorySchema.nullable(),
  decision: z.enum(['ALLOW', 'DENY']),
  confidence: z.number().min(0).max(1),
  reasoning_code: z.string().min(1),
});
export type SemanticClassificationResult = z.infer<typeof SemanticClassificationResultSchema>;

export const PolicyEvaluationTraceSchema = z.object({
  decision: PolicyDecisionSchema,
  stage: z.enum(['STAGE_A_DETERMINISTIC', 'STAGE_B_SEMANTIC', 'STAGE_C_HITL']),
  matched_rule_id: z.string().nullable(),
  rule_citation: z.string(),
  semantic_category: z.string().nullable(),
  sensitive_flag: SensitiveCategorySchema.nullable(),
  confidence: z.number().min(0).max(1),
  injection_risk_score: z.number().min(0).max(1).default(0),
  injection_signals: z.array(z.string()).default([]),
  reasoning_code: z.string(),
  latency_ms: z.number(),
  approval_id: z.string().nullable().optional(),
  stage_details: z.object({
    stage_a_passed: z.boolean(),
    stage_a_reason: z.string(),
    stage_b_executed: z.boolean(),
    stage_b_reason: z.string().nullable(),
    stage_c_triggered: z.boolean(),
    stage_c_reason: z.string().nullable(),
  }),
});
export type PolicyEvaluationTrace = z.infer<typeof PolicyEvaluationTraceSchema>;

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

export interface SafeEmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  hasAttachments: boolean;
  semanticCategory: string | null;
}

export interface SafeEmailDetail extends SafeEmailSummary {
  body: string;
  attachmentNames: string[];
}

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  raw_rules: string;
  policy_ir: PolicyIR;
  status: 'active' | 'paused';
  rate_limit_per_min: number;
  created_at: string;
  updated_at: string;
}

export interface AgentTokenInfo {
  id: string;
  agent_id: string;
  label: string;
  token_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export type ApprovalChannel = 'app' | 'slack' | 'telegram' | 'whatsapp';

export interface EphemeralApprovalPayload {
  tool: McpToolName;
  to?: string;
  subject?: string;
  body?: string;
  threadId?: string;
  messageId?: string;
  label?: string;
}

export interface ChannelDeliveryMap {
  app: { status: 'delivered' | 'skipped'; detail: string };
  slack: { status: 'delivered' | 'not_configured' | 'failed'; detail: string };
  telegram: { status: 'delivered' | 'not_configured' | 'failed'; detail: string };
  whatsapp: { status: 'delivered' | 'not_configured' | 'failed'; detail: string };
}

export interface ApprovalView {
  id: string;
  agent_id: string;
  agent_name: string;
  mcp_tool: McpToolName;
  matched_rule_id: string | null;
  rule_citation: string;
  status: ApprovalStatus;
  delivery_status: ChannelDeliveryMap;
  payload_wiped: boolean;
  resolved_by: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  /** Ephemeral RAM-only preview; strictly null once resolved/expired/wiped */
  ephemeral_preview: EphemeralApprovalPayload | null;
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

export interface AgentRunStep {
  step: number;
  timestamp: string;
  action: string;
  mcp_tool?: string;
  status: 'ok' | 'blocked' | 'aborted' | 'info';
  detail: string;
  latency_ms: number;
}

export interface AgentRunSummary {
  run_id: string;
  agent_id: string;
  agent_name: string;
  status: 'running' | 'completed' | 'aborted' | 'failed';
  started_at: string;
  finished_at: string | null;
  emails_permitted: number;
  emails_stripped_or_blocked: number;
  conflicts_resolved: number;
  artifacts_written: string[];
  drafts_created: number;
  unauthorized_sends_blocked: number;
  estimated_cost_usd: number;
  provider: LlmProvider;
  trace_path: string | null;
  error: string | null;
  steps: AgentRunStep[];
}

export interface TrapPackCaseResult {
  case_id: string;
  title: string;
  attack_vector: string;
  passed: boolean;
  blocked_count: number;
  exfiltration_leaks: number;
  injection_risk_score: number;
  detail: string;
}

export interface TrapPackReport {
  generated_at: string;
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  zero_exfiltration_verified: boolean;
  mission_survived: boolean;
  circuit_breaker_verified: boolean;
  trace_path: string;
  report_path: string;
  cases: TrapPackCaseResult[];
}

export type MailMode = 'sandbox' | 'gmail';
export type LlmProvider = 'local_heuristic' | 'openai' | 'anthropic' | 'gemini' | 'ollama';

export const SIFTVANE_ERROR_CODES = {
  UNAUTHORIZED: 'SIFTVANE_UNAUTHORIZED',
  AGENT_PAUSED: 'SIFTVANE_AGENT_PAUSED',
  KILL_SWITCH_ENGAGED: 'KILL_SWITCH_ENGAGED',
  RATE_LIMITED: 'SIFTVANE_RATE_LIMITED',
  POLICY_DENIED: 'SIFTVANE_POLICY_DENIED',
  PROMPT_INJECTION_BLOCKED: 'PROMPT_INJECTION_BLOCKED',
  CLASSIFIER_FAIL_CLOSED: 'SIFTVANE_CLASSIFIER_FAIL_CLOSED',
  APPROVAL_REQUIRED: 'SIFTVANE_APPROVAL_REQUIRED',
  APPROVAL_EXPIRED: 'SIFTVANE_APPROVAL_EXPIRED',
  NOT_FOUND: 'SIFTVANE_NOT_FOUND',
} as const;
