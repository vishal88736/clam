import { z } from 'zod';
import { sandboxVendors } from '../sandbox/seed.js';

const serviceEnum = z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos', 'policy', 'system']);
export const templates = ['invoice_ledger', 'vendor_rfq', 'photo_receipts', 'inbox_digest', 'interactive'] as const;
export type Template = (typeof templates)[number];

const stepSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  service: serviceEnum,
  action: z.string().regex(/^[a-z_]{3,48}$/),
  label: z.string().min(1).max(160),
  depends_on: z.array(z.string()).max(8),
  tier_hint: z.union([z.literal(0), z.literal(1), z.literal(2)]),
}).strict();

export const workflowPlanSchema = z.object({
  version: z.literal(1),
  planner: z.enum(['deterministic-intent-compiler', 'llm-planner']),
  template: z.enum(templates),
  matched_playbooks: z.array(z.string()).max(8),
  services: z.array(z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos'])).max(6),
  params: z.object({
    vendors: z.array(z.string().email()).max(10).optional(),
    item: z.string().max(120).optional(),
    quantity: z.number().int().min(1).max(10_000_000).optional(),
    include_photos: z.boolean().optional(),
    calendar_reminders: z.boolean().optional(),
    folder_path: z.array(z.string().min(1).max(80)).max(5).optional(),
    sheet_title: z.string().max(120).optional(),
    doc_title: z.string().max(120).optional(),
    keywords: z.array(z.string().max(40)).max(10).optional(),
  }).strict(),
  steps: z.array(stepSchema).min(1).max(20),
}).strict().superRefine((plan, context) => {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    // Steps must form a DAG in declaration order: every dependency is an earlier step.
    if (step.depends_on.some((dependency) => !ids.has(dependency))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'PLAN_DEPENDENCY_INVALID: ' + step.id });
    }
    ids.add(step.id);
  }
});
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
type Step = WorkflowPlan['steps'][number];

const step = (id: string, service: Step['service'], action: string, label: string, depends: string[] = [], tier: 0 | 1 | 2 = 0): Step =>
  ({ id, service, action, label, depends_on: depends, tier_hint: tier });

export interface CompileOptions {
  services?: string[];
  mode: 'sandbox' | 'live';
}

export interface CompiledIntent {
  name: string;
  plan: WorkflowPlan;
  services: WorkflowPlan['services'];
  scheduleMode: 'one_shot' | 'continuous' | 'daily' | 'weekly';
}

const has = (text: string, pattern: RegExp) => pattern.test(text);
const titleCase = (text: string) => text.replace(/\b\w/g, (char) => char.toUpperCase());

/**
 * Deterministic, $0, offline intent compiler. It maps any natural-language request onto a validated DAG of
 * Clam actions. Every step it emits is executed by a typed handler under the policy engine; the compiler cannot
 * produce arbitrary tool calls, recipients, or code.
 */
export function compileIntent(instruction: string, options: CompileOptions): CompiledIntent {
  const text = instruction.toLowerCase();
  const requested = new Set((options.services ?? []).map((value) => value.toLowerCase()));
  const scheduleMode = has(text, /\b(?:every day|daily|each day|each morning|every morning)\b/) ? 'daily'
    : has(text, /\b(?:every week|weekly)\b/) ? 'weekly'
      : has(text, /\b(?:keep watching|continuous(?:ly)?|monitor|whenever|as they arrive)\b/) ? 'continuous' : 'one_shot';
  const vendorEmails = [...new Set([...instruction.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()))];
  const wantsPhotos = requested.has('photos') || has(text, /\b(?:photo|photos|picture|image|screenshot)s?\b/);
  const wantsCalendar = requested.has('calendar') || has(text, /\b(?:remind|reminder|calendar|due date)\b/);

  if (has(text, /\b(?:quote|quotes|rfq|vendor|vendors|supplier|suppliers|bid|bids)\b/) && has(text, /\b(?:email|ask|request|contact|send|reach out)\b/)) {
    const phrase = /\b(?:for|on)\s+(\d{1,7}\s+[a-z][a-z -]{2,60}?)(?:[,.]|\s+and\b|\s+then\b|$)/i.exec(instruction)?.[1]?.trim();
    // Quantity comes from the item phrase ("500 custom boxes"), never from the vendor count ("4 vendors").
    const quantity = Number(/^(\d{1,7})/.exec(phrase ?? '')?.[1] ??
      /\b(\d{1,7})\s+(?!vendors?\b|suppliers?\b|quotes?\b|days?\b)[a-z]/.exec(text)?.[1] ?? 0) || undefined;
    const item = phrase ?? (quantity ? `${quantity} units` : 'requested items');
    const vendors = vendorEmails.length ? vendorEmails.slice(0, 10) : options.mode === 'sandbox' ? sandboxVendors : [];
    const book = has(text, /\b(?:book|order|purchase|buy|confirm|go with)\b/);
    const plan: WorkflowPlan = {
      version: 1, planner: 'deterministic-intent-compiler', template: 'vendor_rfq', matched_playbooks: ['vendor_rfq_outreach', 'quote_comparison', 'tier2_financial_gate'],
      services: ['gmail', 'sheets', 'docs'], params: { vendors, item, quantity, sheet_title: `Vendor Quotes - ${item}`, doc_title: `Vendor Quote Comparison - ${item}` },
      steps: [
        step('rfq_batch', 'gmail', 'queue_rfq_batch', `Email ${vendors.length} vendors a request for quote with automated disclosure`, [], 2),
        step('collect_quotes', 'gmail', 'collect_vendor_quotes', 'Parse unit price, lead time, and terms from replies and PDF quotes', ['rfq_batch']),
        step('comparison_sheet', 'sheets', 'write_comparison_matrix', 'Write a sanitized side-by-side comparison matrix', ['collect_quotes']),
        step('flag_winner', 'sheets', 'update_winner_flag', 'Mark the lowest-cost vendor in the status column', ['comparison_sheet']),
        step('comparison_doc', 'docs', 'write_comparison_memo', 'Write the comparison memo and recommendation', ['comparison_sheet']),
        ...(book ? [step('booking', 'gmail', 'queue_booking_confirmation', 'Queue the purchase confirmation for operator approval', ['flag_winner', 'comparison_doc'], 2)] : []),
      ],
    };
    return { name: `Vendor Quote Agent · ${titleCase(item)}`.slice(0, 80), plan: workflowPlanSchema.parse(plan), services: plan.services, scheduleMode: 'continuous' };
  }

  if (has(text, /\b(?:invoice|invoices|bill|bills|receipt|receipts|subscription|subscriptions|expense|expenses)\b/) &&
      !(wantsPhotos && !has(text, /\b(?:email|emails|inbox|gmail|invoice|invoices|bill|bills)\b/))) {
    const services: WorkflowPlan['services'] = ['gmail', 'drive', 'sheets', 'docs', ...(wantsPhotos ? ['photos' as const] : [])];
    const plan: WorkflowPlan = {
      version: 1, planner: 'deterministic-intent-compiler', template: 'invoice_ledger', matched_playbooks: ['bills_trials_spoof_guard', 'invoice_ledger'],
      services, params: { include_photos: wantsPhotos, folder_path: ['Clam', 'Invoices'], sheet_title: 'Clam Invoice Ledger', doc_title: 'Clam Invoice Summary' },
      steps: [
        step('scan_mail', 'gmail', 'scan_invoices', 'Scan email for daily invoices and recurring bills'),
        ...(wantsPhotos ? [step('scan_photos', 'photos', 'search_receipt_photos', 'Search receipt photos and extract details', ['scan_mail'])] : []),
        step('folders', 'drive', 'ensure_folder_path', 'Ensure Drive folder Clam / Invoices / YYYY-MM', ['scan_mail']),
        step('save_pdfs', 'drive', 'save_attachments', 'Save screened PDF invoices into the dated folder', ['folders']),
        step('ledger', 'sheets', 'append_invoice_rows', 'Append deduplicated rows to the invoice ledger', ['save_pdfs']),
        step('summary', 'docs', 'update_summary_doc', 'Update the daily summary in a Google Doc', ['ledger']),
        step('flags', 'policy', 'flag_duplicates', 'Send duplicate or spoofed invoices to the Approval Inbox', ['scan_mail'], 2),
      ],
    };
    return { name: wantsPhotos ? 'Invoice & Receipt Ledger Agent' : 'Invoice Ledger Agent', plan: workflowPlanSchema.parse(plan), services, scheduleMode };
  }

  if (wantsPhotos) {
    const services: WorkflowPlan['services'] = ['photos', 'sheets', ...(wantsCalendar ? ['calendar' as const] : [])];
    const plan: WorkflowPlan = {
      version: 1, planner: 'deterministic-intent-compiler', template: 'photo_receipts', matched_playbooks: ['photo_receipt_extraction'],
      services, params: { calendar_reminders: wantsCalendar, sheet_title: 'Clam Receipts' },
      steps: [
        step('search', 'photos', 'search_receipt_photos', 'Search recent receipt and ticket photos (read-only)'),
        step('extract', 'photos', 'extract_photo_details', 'Extract merchant, date, amount, and due date in the quarantined parser', ['search']),
        step('sheet', 'sheets', 'append_receipt_rows', 'Append structured receipt rows to a Google Sheet', ['extract']),
        ...(wantsCalendar ? [step('reminders', 'calendar', 'add_payment_reminders', 'Add calendar reminders for payment due dates', ['extract'])] : []),
      ],
    };
    return { name: 'Receipt Photos Agent', plan: workflowPlanSchema.parse(plan), services, scheduleMode };
  }

  // Any other request: a safe, read-mostly digest that touches only the services the request names.
  const wantsSheet = requested.has('sheets') || has(text, /\b(?:sheet|spreadsheet|tracker|table|log)\b/);
  const wantsFolder = requested.has('drive') || has(text, /\b(?:drive|folder)\b/);
  const keywords = [...new Set(text.match(/\b[a-z]{4,}\b/g) ?? [])].filter((word) =>
    !['please', 'every', 'email', 'emails', 'inbox', 'with', 'from', 'that', 'this', 'into', 'make', 'create', 'google', 'about', 'them', 'their', 'what', 'have', 'sheet', 'summary', 'summarize', 'track', 'doc', 'document'].includes(word)).slice(0, 6);
  const services: WorkflowPlan['services'] = ['gmail', 'docs', ...(wantsSheet ? ['sheets' as const] : []), ...(wantsFolder ? ['drive' as const] : [])];
  const short = instruction.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  const plan: WorkflowPlan = {
    version: 1, planner: 'deterministic-intent-compiler', template: 'inbox_digest', matched_playbooks: ['inbox_digest'],
    services, params: { keywords, doc_title: `Clam Digest - ${titleCase(short)}`.slice(0, 120), sheet_title: wantsSheet ? `Clam Tracker - ${titleCase(short)}`.slice(0, 120) : undefined,
      folder_path: wantsFolder ? ['Clam', 'Digests'] : undefined },
    steps: [
      step('scan_mail', 'gmail', 'scan_inbox', 'Read recent mail through the untrusted-data boundary'),
      ...(wantsFolder ? [step('folder', 'drive', 'ensure_folder_path', 'Ensure Drive folder Clam / Digests', ['scan_mail'])] : []),
      ...(wantsSheet ? [step('tracker', 'sheets', 'append_tracker_rows', 'Append matching messages to a tracker sheet', ['scan_mail'])] : []),
      step('digest', 'docs', 'write_digest', 'Write a sanitized digest section', ['scan_mail']),
    ],
  };
  return { name: `Agent · ${titleCase(short)}`.slice(0, 80), plan: workflowPlanSchema.parse(plan), services, scheduleMode };
}

export function interactivePlan(): WorkflowPlan {
  return workflowPlanSchema.parse({
    version: 1, planner: 'deterministic-intent-compiler', template: 'interactive', matched_playbooks: [], services: ['drive', 'docs', 'sheets', 'photos'],
    params: {}, steps: [step('interactive', 'system', 'direct_mcp_tools', 'Direct policy-gated MCP Workspace tool calls')],
  });
}
