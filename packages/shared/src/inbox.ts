import { z } from 'zod';

export const inboxStages = ['TRIGGER', 'PLAN', 'POLICY', 'ACT', 'CHECK', 'REPORT'] as const;
export type InboxStage = (typeof inboxStages)[number];

/** The user's rules every agent action is checked against: who is trusted, and how much an agent may do per run. */
export const inboxPolicySchema = z.object({
  confidenceThreshold: z.number().min(0).max(1),
  allowlist: z.array(z.string().email()).max(100),
  blocklist: z.array(z.string().email()).max(100).default([]),
  contacts: z.array(z.string().email()).max(500),
  vips: z.array(z.string().email()).max(100),
  outboundBudget: z.number().int().min(0).max(3),
  calendarBudget: z.number().int().min(0).max(6),
  toolBudget: z.number().int().min(1).max(200),
});  // unknown keys from older policy versions are dropped, not rejected
export type InboxPolicy = z.infer<typeof inboxPolicySchema>;

/** A calendar event. Fields from older versions (flight booking refs, dossiers) are dropped on read, not rejected. */
export const inboxCalendarSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(140),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  kind: z.string().trim().min(1).max(40).default('event'),
  guests: z.array(z.string()),
  flexible: z.boolean().default(false),
  etag: z.string().optional(),
});
export type InboxCalendarEvent = z.infer<typeof inboxCalendarSchema>;
