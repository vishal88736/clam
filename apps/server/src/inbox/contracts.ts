import type { InboxCalendarEvent, InboxStage } from '@siftvane/shared';

import type { AgentMode, ModelUsage } from './agentConfig.js';

export type Mode = 'sandbox' | 'live' | `live:${string}`;
export type Tier = 0 | 1 | 2;
export type Decision = 'AUTONOMOUS' | 'APPROVAL_REQUIRED' | 'BLOCKED';
export type ActionKind = 'calendar' | 'send' | 'draft' | 'mail' | 'review' | 'handoff' | 'workspace';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'HALTED' | 'FAILED';
export type Snapshot = Record<string, unknown> | null;

/** An action an agent wants to take; every one passes policy, then is applied and read back. */
export interface SafeAction {
  playbook: string;
  kind: ActionKind;
  target: string;
  version: string;
  after: Snapshot;
  requestedTier: Tier;
  reason?: string;
  contact?: string;
  sensitiveTarget?: string;
  externalGuests?: boolean;
  expectedBefore?: Snapshot;
  relatedPlaybooks?: string[];
  workspaceOwner?: { userId: string; agentId: string | null; runId?: string | null };
  sourceId: string;
  confidence: number;
  effectiveContact?: string;
  bodyOnlyRecipient?: boolean;
  threadId?: string;
}

export interface PolicyVerdict {
  decision: Decision;
  tier: Tier;
  ruleId: string;
  reason: string;
}

export interface Claim {
  id: string;
  runId: string;
  kind: ActionKind;
  target: string;
  mode: Mode;
  before: Snapshot;
  after: Snapshot;
  plan: SafeAction;
  tier: Tier;
  ruleId: string;
  status: 'CLAIMED' | 'APPLIED' | 'VERIFIED' | 'REVIEW_REQUIRED' | 'ROLLED_BACK' | 'ROLLBACK_PENDING';
  providerId: string | null;
  creationPending?: boolean;
  traceId: string | null;
}

export interface MailSearch {
  keywords: string[];
  from_contains?: string;
  subject_contains?: string;
  newer_than_days?: number;
  limit: number;
}

export interface McpCaller {
  tool: string;
  client: string;
  token_id: string;
  inbox_id: string;
}

export interface RunRecord {
  id: string;
  trigger: string;
  mode: Mode;
  policyVersion: number;
  agent_mode?: AgentMode;
  mcp_caller?: McpCaller;
  model_usage?: ModelUsage;
  autonomy?: { autonomous_verified: number; gated_for_approval: number; blocked_quarantined: number };
  startedAt: string;
  completedAt: string | null;
  status: RunStatus;
  killSwitchTripped: boolean;
  error: string | null;
  emails: number;
  conflicts: number;
  threats: number;
  steps: number;
  outbound: number;
  calendar: number;
  tokens: number;
  usd: number;
}

export interface TraceStep {
  id: string;
  run_id: string;
  stage: InboxStage;
  timestamp: string;
  detail: Record<string, unknown>;
  budgets: { outbound: number; calendar: number; steps: number; tokens: number | null; usd: number | null };
  prev_hash: string;
  step_hash: string;
  mode?: AgentMode;
  model_usage?: ModelUsage;
}

export interface RunTrace {
  run_id: string;
  step_count: number;
  head_hash: string;
  steps: TraceStep[];
  mode?: AgentMode;
  model_usage?: ModelUsage;
}

export interface InboxTarget {
  read(action: Pick<SafeAction, 'kind' | 'target'>, providerId?: string | null): Promise<Snapshot>;
  calendar(): Promise<InboxCalendarEvent[]>;
  all(kind: ActionKind): Snapshot[];
  dispatch(action: SafeAction, tier: Tier, before: Snapshot, id: string, signal: AbortSignal, onCreated?: (providerId: string) => void): Promise<string>;
  restore(claim: Claim, signal: AbortSignal): Promise<void>;
}

export interface Attention {
  approval_id: string;
  run_id: string;
  priority: 'high' | 'medium' | 'low';
  expires_at: string;
  triggered_rule_id: string;
  reason: string;
  proposed_action: SafeAction;
  editable_payload: Snapshot;
  batch_actions?: SafeAction[];
  execution_run_ids?: string[];
  status: 'PENDING' | 'EXECUTING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'FAILED';
  mode: Mode;
}

export interface Change {
  type: string;
  entity: string;
  diff: Record<string, { before: unknown; after: unknown }>;
  source_msg_ids: string[];
  conflict_flag: boolean;
  next_action: string | null;
}
