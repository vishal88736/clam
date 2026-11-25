import { z } from 'zod';

export const inboxStages = ['TRIGGER', 'PLAN', 'POLICY', 'ACT', 'CHECK', 'REPORT'] as const;
export type InboxStage = (typeof inboxStages)[number];
export const inboxIntentKinds = [
  'flight_update', 'meeting_request', 'bill_invoice', 'subscription_notice',
  'commitment_deadline', 'delivery_update', 'otp_ephemeral', 'newsletter_promo',
  'cold_outreach', 'hostile_suspected',
] as const;

export const inboxIntentSchema = z.object({
  kind: z.enum(inboxIntentKinds),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  sender: z.string(),
  receivedAt: z.string().datetime({ offset: true }),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(240),
  fields: z.record(z.string()),
  taintedTargets: z.array(z.string()),
  ruleIds: z.array(z.string()),
}).strict();
export type InboxIntent = z.infer<typeof inboxIntentSchema>;

export const inboxPolicySchema = z.object({
  confidenceThreshold: z.number().min(0).max(1),
  allowlist: z.array(z.string().email()).max(100),
  contacts: z.array(z.string().email()).max(500),
  vips: z.array(z.string().email()).max(100),
  trustedAirlines: z.array(z.string().regex(/^[a-z\d.-]+\.[a-z]+$/i)).max(100),
  timeZone: z.string().min(1).max(80).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Enter a valid IANA time zone.').default('UTC'),
  workStart: z.number().int().min(0).max(23),
  workEnd: z.number().int().min(1).max(24),
  maxMeetingMinutes: z.number().int().min(15).max(480),
  outboundBudget: z.number().int().min(0).max(3),
  calendarBudget: z.number().int().min(0).max(6),
  toolBudget: z.number().int().min(1).max(200),
}).strict().refine((value) => value.workStart < value.workEnd, 'Working hours must have a start before their end.');
export type InboxPolicy = z.infer<typeof inboxPolicySchema>;

export const inboxCalendarSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(140),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  kind: z.enum(['flight', 'focus', 'meeting', 'reminder', 'buffer']),
  guests: z.array(z.string()),
  flexible: z.boolean(),
  bookingRef: z.string().optional(),
  domain: z.string().optional(),
  dossier: z.array(z.string()).optional(),
  etag: z.string().optional(),
}).strict();
export type InboxCalendarEvent = z.infer<typeof inboxCalendarSchema>;

export const inboxScheduleSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'interval']),
  intervalMinutes: z.number().int().min(1).max(10080),
  nextAt: z.string().datetime().optional(),
}).strict();
export type InboxSchedule = z.infer<typeof inboxScheduleSchema>;
