import { z } from 'zod';
import { mcpScopes } from '../auth/google.js';
import { sandboxVendors } from '../sandbox/seed.js';
import { composeProgram, describeStep, genericProgramSchema, opService, type GenericStep } from './generic.js';

const serviceEnum = z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'photos', 'policy', 'system']);
export const templates = ['invoice_ledger', 'vendor_rfq', 'photo_receipts', 'inbox_digest', 'generic', 'interactive'] as const;

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
    quote_wait_hours: z.number().min(0).max(336).optional(),
    program: genericProgramSchema.optional(),
    mcp_scopes: z.array(z.enum(mcpScopes)).max(mcpScopes.length).optional(),
    reasoning: z.string().max(1200).optional(),
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
export const emailsIn = (text: string) => [...new Set([...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()))];

/** What a planner (deterministic or LLM) decides. It is data only; `planFromChoice` turns it into a validated DAG. */
export const plannerChoiceSchema = z.object({
  template: z.enum(['vendor_rfq', 'invoice_ledger', 'photo_receipts', 'inbox_digest']),
  schedule_mode: z.enum(['one_shot', 'continuous', 'daily', 'weekly']),
  name: z.string().trim().max(80).optional(),
  vendors: z.array(z.string().email().max(254)).max(10).optional(),
  item: z.string().trim().max(80).optional(),
  quantity: z.number().int().min(1).max(10_000_000).optional(),
  book: z.boolean().optional(),
  quote_wait_hours: z.number().min(0).max(336).optional(),
  include_photos: z.boolean().optional(),
  calendar_reminders: z.boolean().optional(),
  wants_sheet: z.boolean().optional(),
  wants_folder: z.boolean().optional(),
  keywords: z.array(z.string().trim().min(2).max(40)).max(10).optional(),
}).strict();
export type PlannerChoice = z.infer<typeof plannerChoiceSchema>;

/** Deterministic, $0, offline intent classifier. */
export function deterministicChoice(instruction: string, options: CompileOptions): PlannerChoice {
  const text = instruction.toLowerCase();
  const requested = new Set((options.services ?? []).map((value) => value.toLowerCase()));
  const schedule_mode = has(text, /\b(?:every day|daily|each day|each morning|every morning)\b/) ? 'daily'
    : has(text, /\b(?:every week|weekly)\b/) ? 'weekly'
      : has(text, /\b(?:keep watching|keep (?:a )?(?:log|track|record)|every [a-z ]{1,40}?(?:i|we) (?:get|receive)|continuous(?:ly)?|monitor|whenever|as they arrive|every time|each time|any time|anytime|when(?:ever)? (?:i|we) (?:get|receive)|when (?:a |an )?new|(?:all|any) new|24\/7)(?![a-z])/) ? 'continuous' : 'one_shot';
  const wantsPhotos = requested.has('photos') || has(text, /\b(?:photo|photos|picture|image|screenshot)s?\b/);
  const wantsCalendar = requested.has('calendar') || has(text, /\b(?:remind|reminder|calendar|due date)\b/);
  const wait = /\bwait(?:ing)?\s+(?:up to\s+)?(\d{1,3})\s*(hours?|hrs?|days?)\b/.exec(text);
  const quote_wait_hours = wait ? Number(wait[1]) * (wait[2].startsWith('d') ? 24 : 1) : undefined;

  // Outreach needs an explicit ask for quotes or to contact vendors; "add the vendor and amount" from an invoice is bookkeeping, not an RFQ.
  const asksQuotes = has(text, /\b(?:quote|quotes|rfq|rfqs|bid|bids)\b/) && has(text, /\b(?:email|ask|request|contact|send|reach out|ping|get|collect)\b/);
  const contactsVendors = has(text, /\b(?:email|ask|contact|reach out to|ping|message|write to)\s+(?:\d+\s+|a few\s+|some\s+|several\s+|the\s+|my\s+|these\s+)?(?:vendors?|suppliers?)\b/);
  if (asksQuotes || contactsVendors) {
    const phrase = /\b(?:for|on)\s+(\d{1,7}\s+[a-z][a-z -]{2,60}?)(?:[,.]|\s+and\b|\s+then\b|$)/i.exec(instruction)?.[1]?.trim();
    // Quantity comes from the item phrase ("500 custom boxes"), never from the vendor count ("4 vendors").
    const quantity = Number(/^(\d{1,7})/.exec(phrase ?? '')?.[1] ??
      /\b(\d{1,7})\s+(?!vendors?\b|suppliers?\b|quotes?\b|days?\b|hours?\b)[a-z]/.exec(text)?.[1] ?? 0) || undefined;
    return { template: 'vendor_rfq', schedule_mode: 'continuous', vendors: emailsIn(instruction).slice(0, 10), item: phrase, quantity,
      book: has(text, /\b(?:book|order|purchase|buy|confirm|go with)\b/), quote_wait_hours };
  }
  if (has(text, /\b(?:invoice|invoices|bill|bills|receipt|receipts|subscription|subscriptions|expense|expenses)\b/) &&
      !(wantsPhotos && !has(text, /\b(?:email|emails|inbox|gmail|invoice|invoices|bill|bills)\b/))) {
    return { template: 'invoice_ledger', schedule_mode, include_photos: wantsPhotos };
  }
  if (wantsPhotos) return { template: 'photo_receipts', schedule_mode, calendar_reminders: wantsCalendar };
  const keywords = [...new Set(text.match(/\b[a-z]{4,}\b/g) ?? [])].filter((word) =>
    !['please', 'every', 'email', 'emails', 'inbox', 'with', 'from', 'that', 'this', 'into', 'make', 'create', 'google', 'about', 'them', 'their', 'what', 'have', 'sheet', 'summary', 'summarize', 'track', 'doc', 'document'].includes(word)).slice(0, 6);
  return { template: 'inbox_digest', schedule_mode, keywords,
    wants_sheet: requested.has('sheets') || has(text, /\b(?:sheet|spreadsheet|tracker|table|log)\b/),
    wants_folder: requested.has('drive') || has(text, /\b(?:drive|folder)\b/) };
}

/**
 * Turns a planner choice into a validated DAG of Siftvane actions. Every step is executed by a typed handler under the
 * policy engine; no planner can produce arbitrary tool calls or code. Outbound recipients must appear verbatim in the
 * user's own instruction (an LLM cannot invent or inject a vendor address).
 */
export function planFromChoice(choice: PlannerChoice, instruction: string, options: CompileOptions,
  planner: WorkflowPlan['planner']): CompiledIntent {
  const typed = new Set(emailsIn(instruction));
  if (choice.template === 'vendor_rfq') {
    const named = (choice.vendors ?? []).map((vendor) => vendor.toLowerCase()).filter((vendor) => typed.has(vendor));
    const vendors = named.length ? named.slice(0, 10) : options.mode === 'sandbox' ? sandboxVendors : [];
    const item = choice.item || (choice.quantity ? `${choice.quantity} units` : 'requested items');
    const plan: WorkflowPlan = {
      version: 1, planner, template: 'vendor_rfq', matched_playbooks: ['vendor_rfq_outreach', 'quote_comparison', 'tier2_financial_gate'],
      services: ['gmail', 'sheets', 'docs'], params: { vendors, item, quantity: choice.quantity, quote_wait_hours: choice.quote_wait_hours,
        sheet_title: `Vendor Quotes - ${item}`, doc_title: `Vendor Quote Comparison - ${item}` },
      steps: [
        step('rfq_batch', 'gmail', 'queue_rfq_batch', `Email ${vendors.length} vendors a request for quote with automated disclosure`, [], 2),
        step('collect_quotes', 'gmail', 'collect_vendor_quotes', 'Parse unit price, lead time, and terms from replies and PDF quotes', ['rfq_batch']),
        step('comparison_sheet', 'sheets', 'write_comparison_matrix', 'Write a sanitized side-by-side comparison matrix', ['collect_quotes']),
        step('flag_winner', 'sheets', 'update_winner_flag', 'Mark the lowest-cost vendor in the status column', ['comparison_sheet']),
        step('comparison_doc', 'docs', 'write_comparison_memo', 'Write the comparison memo and recommendation', ['comparison_sheet']),
        ...(choice.book ? [step('booking', 'gmail', 'queue_booking_confirmation', 'Queue the purchase confirmation for operator approval', ['flag_winner', 'comparison_doc'], 2)] : []),
      ],
    };
    return { name: (choice.name || `Vendor Quote Agent · ${titleCase(item)}`).slice(0, 80), plan: workflowPlanSchema.parse(plan), services: plan.services,
      scheduleMode: 'continuous' };
  }
  if (choice.template === 'invoice_ledger') {
    const photos = Boolean(choice.include_photos);
    const services: WorkflowPlan['services'] = ['gmail', 'drive', 'sheets', 'docs', ...(photos ? ['photos' as const] : [])];
    const plan: WorkflowPlan = {
      version: 1, planner, template: 'invoice_ledger', matched_playbooks: ['bills_trials_spoof_guard', 'invoice_ledger'],
      services, params: { include_photos: photos, folder_path: ['Siftvane', 'Invoices'], sheet_title: 'Siftvane Invoice Ledger', doc_title: 'Siftvane Invoice Summary' },
      steps: [
        step('scan_mail', 'gmail', 'scan_invoices', 'Scan email for daily invoices and recurring bills'),
        ...(photos ? [step('scan_photos', 'photos', 'search_receipt_photos', 'Search receipt photos and extract details', ['scan_mail'])] : []),
        step('folders', 'drive', 'ensure_folder_path', 'Ensure Drive folder Siftvane / Invoices / YYYY-MM', ['scan_mail']),
        step('save_pdfs', 'drive', 'save_attachments', 'Save screened PDF invoices into the dated folder', ['folders']),
        step('ledger', 'sheets', 'append_invoice_rows', 'Append deduplicated rows to the invoice ledger', ['save_pdfs']),
        step('summary', 'docs', 'update_summary_doc', 'Update the daily summary in a Google Doc', ['ledger']),
        step('flags', 'policy', 'flag_duplicates', 'Send duplicate or spoofed invoices to the Approval Inbox', ['scan_mail'], 2),
      ],
    };
    return { name: (choice.name || (photos ? 'Invoice & Receipt Ledger Agent' : 'Invoice Ledger Agent')).slice(0, 80), plan: workflowPlanSchema.parse(plan),
      services, scheduleMode: choice.schedule_mode };
  }
  if (choice.template === 'photo_receipts') {
    const reminders = Boolean(choice.calendar_reminders);
    const services: WorkflowPlan['services'] = ['photos', 'sheets', ...(reminders ? ['calendar' as const] : [])];
    const plan: WorkflowPlan = {
      version: 1, planner, template: 'photo_receipts', matched_playbooks: ['photo_receipt_extraction'],
      services, params: { calendar_reminders: reminders, sheet_title: 'Siftvane Receipts' },
      steps: [
        step('search', 'photos', 'search_receipt_photos', 'Search recent receipt and ticket photos (read-only)'),
        step('extract', 'photos', 'extract_photo_details', 'Extract merchant, date, amount, and due date in the quarantined parser', ['search']),
        step('sheet', 'sheets', 'append_receipt_rows', 'Append structured receipt rows to a Google Sheet', ['extract']),
        ...(reminders ? [step('reminders', 'calendar', 'add_payment_reminders', 'Add calendar reminders for payment due dates', ['extract'])] : []),
      ],
    };
    return { name: (choice.name || 'Receipt Photos Agent').slice(0, 80), plan: workflowPlanSchema.parse(plan), services, scheduleMode: choice.schedule_mode };
  }
  // Any other request: a safe, read-mostly digest that touches only the services the request names.
  const short = instruction.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  const services: WorkflowPlan['services'] = ['gmail', 'docs', ...(choice.wants_sheet ? ['sheets' as const] : []), ...(choice.wants_folder ? ['drive' as const] : [])];
  const plan: WorkflowPlan = {
    version: 1, planner, template: 'inbox_digest', matched_playbooks: ['inbox_digest'],
    services, params: { keywords: (choice.keywords ?? []).map((word) => word.toLowerCase()), doc_title: `Siftvane Digest - ${titleCase(short)}`.slice(0, 120),
      sheet_title: choice.wants_sheet ? `Siftvane Tracker - ${titleCase(short)}`.slice(0, 120) : undefined,
      folder_path: choice.wants_folder ? ['Siftvane', 'Digests'] : undefined },
    steps: [
      step('scan_mail', 'gmail', 'scan_inbox', 'Read recent mail through the untrusted-data boundary'),
      ...(choice.wants_folder ? [step('folder', 'drive', 'ensure_folder_path', 'Ensure Drive folder Siftvane / Digests', ['scan_mail'])] : []),
      ...(choice.wants_sheet ? [step('tracker', 'sheets', 'append_tracker_rows', 'Append matching messages to a tracker sheet', ['scan_mail'])] : []),
      step('digest', 'docs', 'write_digest', 'Write a sanitized digest section', ['scan_mail']),
    ],
  };
  return { name: (choice.name || `Agent · ${titleCase(short)}`).slice(0, 80), plan: workflowPlanSchema.parse(plan), services, scheduleMode: choice.schedule_mode };
}

/**
 * Builds a plan from a free-form program (LLM-composed or offline-composed). Recipient guard: `mail.send` may only
 * target addresses the user typed; anything else is removed before the plan is stored.
 */
export function planFromProgram(input: { program: GenericStep[]; name: string; scheduleMode: CompiledIntent['scheduleMode']; reasoning?: string },
  instruction: string, planner: WorkflowPlan['planner']): CompiledIntent {
  const typed = new Set(emailsIn(instruction));
  const program = input.program.flatMap((entry): GenericStep[] => {
    if (entry.op !== 'mail.send') return [entry];
    const to = entry.to.map((address) => address.toLowerCase()).filter((address) => typed.has(address));
    return to.length ? [{ ...entry, to }] : [];
  });
  const valid = genericProgramSchema.parse(program);
  const services = [...new Set(valid.map((entry) => opService[entry.op]).filter((service) => service !== 'system'))] as WorkflowPlan['services'];
  const plan: WorkflowPlan = {
    version: 1, planner, template: 'generic', matched_playbooks: ['generic_program'], services,
    params: { program: valid, reasoning: input.reasoning?.slice(0, 1200) },
    steps: valid.map((entry) => step(entry.id, opService[entry.op], entry.op.replace('.', '_'), describeStep(entry).slice(0, 160),
      'from' in entry && entry.from ? [entry.from] : [], entry.op === 'mail.draft_replies' || entry.op === 'mail.send' ? 2 : 0)),
  };
  return { name: input.name.slice(0, 80), plan: workflowPlanSchema.parse(plan), services, scheduleMode: input.scheduleMode };
}

/** Offline ($0) planning: specialised workflows when clearly requested, otherwise a composed general program. */
export function compileIntent(instruction: string, options: CompileOptions): CompiledIntent {
  const choice = deterministicChoice(instruction, options);
  if (choice.template !== 'inbox_digest') return planFromChoice(choice, instruction, options, 'deterministic-intent-compiler');
  const composed = composeProgram(instruction, new Set((options.services ?? []).map((value) => value.toLowerCase())));
  const short = instruction.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return planFromProgram({ program: composed.program, name: `Agent · ${titleCase(short)}`, scheduleMode: choice.schedule_mode,
    reasoning: 'Offline composer: no language model configured, so steps were chosen from the sources and outputs named in the request.' },
  instruction, 'deterministic-intent-compiler');
}

export function interactivePlan(): WorkflowPlan {
  return workflowPlanSchema.parse({
    version: 1, planner: 'deterministic-intent-compiler', template: 'interactive', matched_playbooks: [], services: ['drive', 'docs', 'sheets', 'photos'],
    params: {}, steps: [step('interactive', 'system', 'direct_mcp_tools', 'Direct policy-gated MCP Workspace tool calls')],
  });
}
