import { z } from 'zod';

export const handoffHeaderNames = [
  'X-Clam-Agent-Origin', 'X-Clam-Handoff-Id', 'X-Clam-Hop-Count',
  'X-Clam-Max-Hops', 'X-Clam-Handoff-Sig',
] as const;
export const forgedHandoffRule = 'FORGED_AGENT_HANDOFF_HEADER';
export const handoffDefaults = { maxHops: 4, hardCeiling: 6 } as const;
export const handoffId = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);

export const handoffInputFields = {
  from_inbox_id: handoffId,
  to_inbox_id: handoffId,
  thread_id: handoffId.optional(),
  task_summary: z.string().trim().min(1).max(240),
  structured_payload: z.record(z.unknown()),
  attachment_ids: z.array(handoffId).max(3).default([]),
  max_hops: z.number().int().min(1).max(handoffDefaults.hardCeiling).optional(),
};
export type HandoffInput = z.input<z.ZodObject<typeof handoffInputFields>>;

export interface ThreadReplayHop {
  step_id: string;
  run_id: string;
  timestamp: string;
  inbound?: {
    sender: string;
    received_at: string;
    trust_level: 'untrusted_external' | 'verified_agent_handoff';
    threat_signals: string[];
    hop_count?: number;
    max_hops?: number;
  };
  gate?: {
    rule_id: string;
    tier: number;
    blocked: boolean;
    confidence: number | null;
    taint: string;
    secret_scan: string;
  };
  action?: { tool: string; status: string };
}

export interface ThreadReplay {
  thread_id: string;
  hops: ThreadReplayHop[];
}
