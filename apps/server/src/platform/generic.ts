import { z } from 'zod';
import type { mcpScopes } from '../auth/google.js';

/**
 * General-purpose workflow language. Any request is compiled into a short program of typed operations over the
 * user's mail, Drive, Docs, Sheets, Calendar, and Photos. Steps pass rows to later steps through `from`.
 * Operations are executed by Siftvane's own handlers under the policy engine — a planner can compose them freely but
 * can never call an unlisted tool, write code, or invent an outbound recipient.
 */
const id = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const from = id;
const segment = z.string().trim().min(1).max(60).regex(/^[^/\\\0\r\n]+$/);
const folder = z.array(segment).min(1).max(4);
const text = (max: number) => z.string().trim().min(1).max(max);
const template = z.string().max(1500);

export const genericStepSchema = z.discriminatedUnion('op', [
  z.object({ id, op: z.literal('mail.search'), keywords: z.array(z.string().trim().min(2).max(40)).max(6).default([]),
    from_contains: z.string().trim().min(1).max(80).optional(), subject_contains: z.string().trim().min(1).max(80).optional(),
    newer_than_days: z.number().int().min(1).max(365).optional(),
    include_attachments: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(25) }).strict(),
  z.object({ id, op: z.literal('photos.extract'), category: z.enum(['RECEIPTS', 'DOCUMENTS', 'SCREENSHOTS']).default('RECEIPTS'),
    limit: z.number().int().min(1).max(20).default(10) }).strict(),
  z.object({ id, op: z.literal('filter'), from, field: z.string().trim().min(1).max(40), contains: z.string().trim().max(80).optional(),
    exists: z.boolean().optional() }).strict(),
  z.object({ id, op: z.literal('summarize'), from, heading: text(120).optional() }).strict(),
  z.object({ id, op: z.literal('drive.folder'), path: folder }).strict(),
  z.object({ id, op: z.literal('drive.save_attachments'), from, folder }).strict(),
  z.object({ id, op: z.literal('drive.save_text'), folder, name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,80}\.(?:txt|md|csv)$/),
    content: template, from: from.optional() }).strict(),
  z.object({ id, op: z.literal('sheets.append'), from, title: text(100), tab: segment.default('Rows'), columns: z.array(text(40)).min(1).max(12),
    folder: folder.optional() }).strict(),
  z.object({ id, op: z.literal('docs.write'), title: text(100), heading: text(120), content: template.optional(), from: from.optional(),
    folder: folder.optional(), mode: z.enum(['append', 'replace_section']).default('replace_section') }).strict(),
  z.object({ id, op: z.literal('calendar.reminders'), from, date_field: z.string().trim().min(1).max(40), title: text(120),
    time_utc: z.string().regex(/^\d{2}:\d{2}$/).default('09:00') }).strict(),
  z.object({ id, op: z.literal('mail.label'), from, label: z.string().regex(/^(?:SIFTVANE|CLAM)_[A-Z][A-Z0-9_]{1,30}$/) }).strict(),
  z.object({ id, op: z.literal('mail.draft_replies'), from, subject: text(150), body: template }).strict(),
  z.object({ id, op: z.literal('mail.send'), to: z.array(z.string().email().max(254)).min(1).max(5), subject: text(150), body: template,
    from: from.optional() }).strict(),
]);
export type GenericStep = z.infer<typeof genericStepSchema>;
export const genericProgramSchema = z.array(genericStepSchema).min(1).max(15).superRefine((steps, context) => {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PROGRAM_DUPLICATE_STEP' });
    if ('from' in step && step.from && !seen.has(step.from)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'PROGRAM_DEPENDENCY_INVALID' });
    seen.add(step.id);
  }
});

export const opService: Record<GenericStep['op'], 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'photos' | 'system'> = {
  'mail.search': 'gmail', 'photos.extract': 'photos', filter: 'system', summarize: 'system', 'drive.folder': 'drive',
  'drive.save_attachments': 'drive', 'drive.save_text': 'drive', 'sheets.append': 'sheets', 'docs.write': 'docs',
  'calendar.reminders': 'calendar', 'mail.label': 'gmail', 'mail.draft_replies': 'gmail', 'mail.send': 'gmail',
};

export function genericStepScopes(step: GenericStep): (typeof mcpScopes)[number][] {
  switch (step.op) {
    case 'mail.search': return step.include_attachments ? ['mail:read', 'attachment:extract'] : ['mail:read'];
    case 'mail.send': return ['mail:read', 'mail:send'];
    case 'mail.draft_replies': return ['mail:read', 'mail:draft'];
    case 'mail.label': return ['mail:read', 'mail:label'];
    case 'photos.extract': return ['photos:read'];
    case 'calendar.reminders': return ['calendar:propose'];
    case 'drive.save_attachments': return ['mail:read', 'attachment:extract', 'workspace:write'];
    case 'drive.folder': case 'drive.save_text': case 'sheets.append': case 'docs.write': return ['workspace:write'];
    case 'filter': case 'summarize': return [];
  }
}

export function describeStep(step: GenericStep): string {
  switch (step.op) {
    case 'mail.search': return `Search mail${step.keywords.length ? ' for ' + step.keywords.join(', ') : ''}${step.from_contains ? ' from ' + step.from_contains : ''}`;
    case 'photos.extract': return `Read ${step.category.toLowerCase()} photos and extract details`;
    case 'filter': return `Keep rows where ${step.field}${step.contains ? ' contains "' + step.contains + '"' : ' is present'}`;
    case 'summarize': return 'Summarize the matching items';
    case 'drive.folder': return `Ensure Drive folder ${step.path.join(' / ')}`;
    case 'drive.save_attachments': return `Save screened attachments to ${step.folder.join(' / ')}`;
    case 'drive.save_text': return `Save ${step.name} to ${step.folder.join(' / ')}`;
    case 'sheets.append': return `Append rows to sheet "${step.title}" (${step.columns.join(', ')})`;
    case 'docs.write': return `Write "${step.heading}" in doc "${step.title}"`;
    case 'calendar.reminders': return `Add calendar reminders on each ${step.date_field}`;
    case 'mail.label': return `Label matching mail ${step.label}`;
    case 'mail.draft_replies': return 'Draft replies to each sender (Tier 2 approval)';
    case 'mail.send': return `Email ${step.to.join(', ')} (allowlist or Tier 2 approval)`;
  }
}

export const opCatalogForPrompt = [
  'mail.search {keywords[], from_contains?, subject_contains?, newer_than_days?, include_attachments?, limit?} -> rows with date, from, subject, message_id and every "Label: value" field',
  'photos.extract {category: RECEIPTS|DOCUMENTS|SCREENSHOTS, limit?} -> rows with merchant, date, amount, currency, due, reference',
  'filter {from, field, contains? | exists?}',
  'summarize {from, heading?} -> a bullet summary usable as {{summary}} in later content',
  'drive.folder {path[]}', 'drive.save_attachments {from, folder[]}', 'drive.save_text {folder[], name(.md|.txt|.csv), content, from?}',
  'sheets.append {from, title, tab?, columns[]} (column names are matched to row fields, e.g. "Amount", "Due Date", "From")',
  'docs.write {title, heading, content? | from?, folder?, mode?}',
  'calendar.reminders {from, date_field, title, time_utc?}', 'mail.label {from, label: SIFTVANE_UPPER_SNAKE}',
  'mail.draft_replies {from, subject, body} (drafts a reply to each row sender; always needs approval)',
  'mail.send {to[] (only addresses the user wrote), subject, body, from?}',
  'Templates may use {{field}} for row fields, {{count}}, {{date}}, {{rows}} (bulleted list of from), {{summary}} (latest summarize step).',
].join('\n');

const stop = new Set(['please', 'every', 'email', 'emails', 'mail', 'inbox', 'with', 'from', 'that', 'this', 'into', 'make', 'create', 'google',
  'about', 'them', 'their', 'what', 'have', 'sheet', 'sheets', 'spreadsheet', 'summary', 'summarize', 'track', 'tracker', 'document', 'docs', 'drive',
  'folder', 'calendar', 'remind', 'reminder', 'reminders', 'label', 'labels', 'draft', 'drafts', 'reply', 'replies', 'find', 'list', 'save', 'keep',
  'messages', 'message', 'anything', 'everything', 'everyone', 'someone', 'should', 'would', 'could', 'then', 'also', 'when', 'were', 'there', 'which',
  'those', 'these', 'other', 'some', 'only', 'just', 'mine', 'need', 'want', 'like', 'more', 'most', 'last', 'past', 'week', 'days', 'today', 'table',
  'report', 'notes', 'note', 'write', 'writes', 'up', 'put', 'add', 'log', 'logs', 'deadline', 'deadlines', 'dates', 'date', 'attachments', 'attachment',
  'pdfs', 'send', 'sent', 'tell', 'give', 'show', 'each', 'all', 'and', 'the', 'for', 'any', 'via', 'who', 'whom', 'emailed', 'doc', 'digest', 'overview',
  'polite', 'politely', 'asked', 'asking', 'summarizing', 'summarising', 'summarise', 'tracking', 'quick', 'short', 'brief', 'nice', 'kindly', 'thank',
  'thanks', 'reply', 'responding', 'everybody', 'anyone', 'people', 'person', 'thing', 'things', 'stuff', 'whatever', 'related', 'regarding', 'mailbox',
  'gmail', 'spreadsheets', 'documents', 'files', 'file', 'items', 'item', 'using', 'based', 'make', 'build', 'prepare', 'help', 'look', 'check', 'through',
  'photo', 'photos', 'receipt', 'receipts', 'screenshot', 'screenshots', 'image', 'images', 'picture', 'pictures', 'before', 'after', 'anything', 'is', 'due']);
const fieldWords: Record<string, string> = {
  amount: 'Amount', amounts: 'Amount', total: 'Amount', price: 'Amount', prices: 'Amount', cost: 'Amount', costs: 'Amount',
  due: 'Due', deadline: 'Deadline', deadlines: 'Deadline', invoice: 'Invoice', order: 'Order', tracking: 'Tracking',
  status: 'Status', vendor: 'Vendor', project: 'Project',
};

/** Offline composer: turns any request into a generic program using sources and sinks named in the text. */
export function composeProgram(instruction: string, requested: Set<string>): { program: GenericStep[]; title: string } {
  const text = instruction.toLowerCase();
  // Words inside email addresses ("team" in sam@team.example) are recipients, not topics.
  const words = [...new Set(text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ').match(/\b[a-z][a-z0-9-]{3,}\b/g) ?? [])];
  const quoted = [...instruction.matchAll(/"([^"]{2,40})"/g)].map((match) => match[1].toLowerCase());
  // Light stemming so "meetings" also matches "Meeting request".
  const stem = (word: string) => word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  const keywords = (quoted.length ? quoted : [...new Set(words.filter((word) => !stop.has(word) && !fieldWords[word] && !/^\d/.test(word)).map(stem))]).slice(0, 3);
  const sender = requestedMailSender(instruction) ??
    /\bfrom\s+(@?[\w-]{3,})\b/.exec(text)?.[1]?.replace(/^@/, '');
  const days = requestedMailDays(text);
  const subject = requestedMailSubject(instruction);
  const title = 'Siftvane - ' + (keywords.length ? keywords.map((word) => word.replace(/^\w/, (char) => char.toUpperCase())).join(' ') : 'Inbox');
  const photos = requested.has('photos') || /\b(?:photo|photos|picture|pictures|screenshot|screenshots|image|images)\b/.test(text);
  const program: GenericStep[] = [];
  const source = photos ? 'photos' : 'mail';
  if (photos) program.push(genericStepSchema.parse({ id: 'photos', op: 'photos.extract', category: /screenshot/.test(text) ? 'SCREENSHOTS' : /document/.test(text) ? 'DOCUMENTS' : 'RECEIPTS' }));
  else program.push(genericStepSchema.parse({ id: 'mail', op: 'mail.search', keywords: subject ? [] : keywords.filter((word) => word !== sender),
    from_contains: sender, subject_contains: subject, newer_than_days: days, include_attachments: /\b(?:attachment|attachments|pdf|pdfs|files?)\b/.test(text) }));
  // Field words include short ones such as "due", which the 4+ letter topic words above never contain.
  const fields = [...new Set((text.match(/\b[a-z]{3,}\b/g) ?? []).map((word) => fieldWords[word]).filter(Boolean))];
  const wantsFolder = requested.has('drive') || /\b(?:drive|folder|save|attachments?|pdfs?)\b/.test(text);
  const folder = ['Siftvane', title.replace(/^Siftvane - /, '')];
  if (wantsFolder && !photos && /\b(?:attachment|attachments|pdf|pdfs|files?|save)\b/.test(text)) {
    program.push(genericStepSchema.parse({ id: 'files', op: 'drive.save_attachments', from: source, folder }));
  } else if (wantsFolder) program.push(genericStepSchema.parse({ id: 'folder', op: 'drive.folder', path: folder }));
  if (requested.has('sheets') || /\b(?:sheet|spreadsheet|tracker|table|log|track|list)\b/.test(text)) {
    const columns = photos ? ['Date', 'Merchant', 'Amount', 'Currency', 'Due', 'Reference'] : ['Date', 'From', 'Subject', ...fields];
    program.push(genericStepSchema.parse({ id: 'sheet', op: 'sheets.append', from: source, title, columns: [...new Set(columns)].slice(0, 12),
      folder: wantsFolder ? folder : undefined }));
  }
  if (/\b(?:label|tag|mark|flag|categori[sz]e)\b/.test(text) && !photos) {
    program.push(genericStepSchema.parse({ id: 'label', op: 'mail.label', from: source,
      label: ('SIFTVANE_' + (keywords[0] ?? 'AGENT').toUpperCase().replace(/[^A-Z0-9]+/g, '_')).slice(0, 40) }));
  }
  if (requested.has('calendar') || /\b(?:remind|reminder|reminders|calendar|schedule)\b/.test(text)) {
    const dateField = /\bdeadline/.test(text) ? 'deadline' : /\bdue\b/.test(text) || photos ? 'due' : 'date';
    program.push(genericStepSchema.parse({ id: 'reminders', op: 'calendar.reminders', from: source, date_field: dateField,
      title: photos ? 'Pay {{merchant}} {{amount}} {{currency}}' : '{{subject}}' }));
  }
  if (/\b(?:reply|replies|respond|draft|drafts|answer)\b/.test(text) && !photos) {
    program.push(genericStepSchema.parse({ id: 'drafts', op: 'mail.draft_replies', from: source, subject: 'Re: {{subject}}',
      body: 'Hello,\n\nThank you for your message about "{{subject}}". I will follow up shortly.\n\nBest regards' }));
  }
  const recipients = [...new Set([...instruction.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()))]
    .filter((address) => address !== sender && new RegExp('\\b(?:to|email|send|forward|share)\\b[^.]{0,40}' + address.replace(/[.+]/g, '\\$&')).test(text));
  const wantsDoc = requested.has('docs') || /\b(?:doc|document|summary|summarize|summarise|report|digest|notes|overview|write up|brief)\b/.test(text);
  const hasSink = program.length > 1;
  if (wantsDoc || recipients.length || !hasSink) {
    program.push(genericStepSchema.parse({ id: 'summary', op: 'summarize', from: source, heading: title.replace(/^Siftvane - /, '') }));
  }
  if (wantsDoc || !hasSink) {
    program.push(genericStepSchema.parse({ id: 'doc', op: 'docs.write', title, heading: 'Summary - {{date}}', content: '{{summary}}',
      folder: wantsFolder ? folder : undefined }));
  }
  if (recipients.length) {
    program.push(genericStepSchema.parse({ id: 'send', op: 'mail.send', to: recipients.slice(0, 5), subject: title.replace(/^Siftvane - /, 'Update: '),
      body: 'Hello,\n\nHere is the summary you asked for ({{count}} items):\n\n{{summary}}\n\nBest regards' }));
  }
  return { program: genericProgramSchema.parse(program), title };
}

const modeAliases: Record<string, 'append' | 'replace_section'> = {
  append: 'append', add: 'append', insert: 'append', replace: 'replace_section', replace_section: 'replace_section', overwrite: 'replace_section',
  update: 'replace_section', write: 'replace_section',
};
const opAliases: Record<string, GenericStep['op']> = Object.fromEntries((Object.keys(opService) as GenericStep['op'][])
  .flatMap((op) => [[op, op], [op.replace('.', '_'), op], [op.replace('.', ''), op]]));
const allowedKeys: Record<GenericStep['op'], string[]> = {
  'mail.search': ['keywords', 'from_contains', 'subject_contains', 'newer_than_days', 'include_attachments', 'limit'], 'photos.extract': ['category', 'limit'],
  filter: ['from', 'field', 'contains', 'exists'], summarize: ['from', 'heading'], 'drive.folder': ['path'], 'drive.save_attachments': ['from', 'folder'],
  'drive.save_text': ['folder', 'name', 'content', 'from'], 'sheets.append': ['from', 'title', 'tab', 'columns', 'folder'],
  'docs.write': ['title', 'heading', 'content', 'from', 'folder', 'mode'], 'calendar.reminders': ['from', 'date_field', 'title', 'time_utc'],
  'mail.label': ['from', 'label'], 'mail.draft_replies': ['from', 'subject', 'body'], 'mail.send': ['to', 'subject', 'body', 'from'],
};
const clamp = (value: unknown, min: number, max: number) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : undefined;
};

function requestedMailDays(text: string) {
  const range = /\b(?:last|past)\s+(\d{1,3})\s+(days?|weeks?|months?)\b/.exec(text);
  if (range) return clamp(Number(range[1]) * (range[2].startsWith('week') ? 7 : range[2].startsWith('month') ? 30 : 1), 1, 365);
  if (/\b(?:this|past|last)\s+week\b/.test(text)) return 7;
  if (/\b(?:this|past|last)\s+month\b/.test(text)) return 30;
  return /\btoday\b/.test(text) ? 1 : undefined;
}

function requestedMailSubject(instruction: string) {
  return /\bsubject\s+(?:(?:contains?|includes?|is)\s+)?"([^"]{1,80})"/i.exec(instruction)?.[1]?.trim() || undefined;
}

function requestedMailSender(instruction: string) {
  const matches = [...instruction.matchAll(/\b(?:from|sent by)\s+(?:"([^"]{1,80})"|(@?[\w.+-]+(?:@[\w.-]+)?\.[a-z]{2,})\b)/gi)];
  if (matches.length !== 1) return undefined;
  return (matches[0][1] ?? matches[0][2]).trim().toLowerCase().replace(/^@/, '') || undefined;
}
const asFolder = (value: unknown) => {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/\s*[/>›]\s*/) : [];
  const clean = parts.map((part) => part.replace(/[\\\0\r\n]/g, '').trim().slice(0, 60)).filter(Boolean).slice(0, 4);
  return clean.length ? clean : undefined;
};

/**
 * Repairs common model formatting mistakes and removes ungrounded constraints before strict validation:
 * - shape fixes: wrong types, out-of-range limits, folder strings, mode synonyms, unknown keys;
 * - grounding: sender filters and date windows the user never mentioned are dropped, outbound recipients must be
 *   addresses the user wrote, and placeholder labels are replaced. Steps that stay invalid are reported, not run.
 */
export function repairProgram(raw: unknown[], instruction: string, knownIds: string[] = [], knownKinds: Record<string, 'mail' | 'photo' | 'other'> = {}) {
  const text = instruction.toLowerCase();
  const typed = new Set([...instruction.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()));
  const mentionsTime = /\b(?:today|yesterday|week|weeks|month|months|day|days|recent|recently|latest|since|last|past)\b/.test(text);
  const ids = new Set(knownIds);
  const steps: GenericStep[] = [];
  const issues: string[] = [];
  const kinds = new Map<string, 'mail' | 'photo' | 'other'>(Object.entries(knownKinds));
  let summarized = Object.keys(knownKinds).some((name) => name.startsWith('summary'));
  raw.slice(0, 15).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') { issues.push(`step ${index + 1}: not an object`); return; }
    const source = entry as Record<string, unknown>;
    const op = opAliases[String(source.op ?? source.operation ?? '').toLowerCase()];
    if (!op) { issues.push(`step ${index + 1}: unknown op "${String(source.op)}"`); return; }
    const step: Record<string, unknown> = { op };
    for (const name of allowedKeys[op]) if (source[name] !== undefined && source[name] !== null && typeof source[name] !== 'boolean' ||
      (name === 'include_attachments' || name === 'exists') && typeof source[name] === 'boolean') step[name] = source[name];
    let id = String(source.id ?? `${op.split('.').pop()}_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 24) || `step_${index + 1}`;
    const baseId = id;
    for (let suffix = 2; ids.has(id); suffix++) id = baseId.slice(0, 20) + '_' + suffix;
    step.id = id;
    if (typeof step.from === 'string') step.from = String(step.from).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (op === 'mail.search') {
      step.keywords = (Array.isArray(source.keywords) ? source.keywords : typeof source.keywords === 'string' ? [source.keywords] : [])
        .map((word) => String(word).trim().slice(0, 40)).filter((word) => word.length >= 2).slice(0, 6);
      step.limit = clamp(source.limit, 1, 50) ?? 25;
      // A sender filter is grounded only when the user wrote "from X" (not when X is merely a recipient).
      const sender = typeof source.from_contains === 'string' ? source.from_contains.toLowerCase().trim().replace(/^@/, '') : '';
      const explicitSender = requestedMailSender(instruction);
      if (explicitSender) step.from_contains = explicitSender;
      else if (!sender || !new RegExp('\\b(?:from|by|sent by)\\s+@?' + sender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text)) delete step.from_contains;
      const subject = requestedMailSubject(instruction);
      if (subject) {
        step.subject_contains = subject;
        step.keywords = [];
      } else delete step.subject_contains;
      const days = requestedMailDays(text);
      if (days !== undefined) step.newer_than_days = days;
      else if (!mentionsTime) delete step.newer_than_days;
      else if (step.newer_than_days !== undefined) step.newer_than_days = clamp(step.newer_than_days, 1, 365);
    }
    if (op === 'photos.extract') {
      step.limit = clamp(source.limit, 1, 20) ?? 10;
      const category = String(source.category ?? 'RECEIPTS').toUpperCase();
      step.category = ['RECEIPTS', 'DOCUMENTS', 'SCREENSHOTS'].includes(category) ? category : 'RECEIPTS';
    }
    for (const name of ['folder', 'path']) if (step[name] !== undefined) step[name] = asFolder(step[name]);
    if (step.mode !== undefined) step.mode = modeAliases[String(step.mode).toLowerCase()] ?? 'replace_section';
    if (op === 'sheets.append') {
      if (typeof step.tab !== 'string') delete step.tab;
      step.columns = (Array.isArray(source.columns) ? source.columns : []).map((column) => String(column).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
    }
    if (op === 'calendar.reminders') {
      if (typeof step.time_utc !== 'string' || !/^\d{2}:\d{2}$/.test(step.time_utc)) delete step.time_utc;
      if (typeof step.date_field === 'string') step.date_field = step.date_field.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    }
    if (op === 'filter' && typeof step.field === 'string') step.field = step.field.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (op === 'mail.label') {
      const label = String(source.label ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^CLAM_/, 'SIFTVANE_');
      const fallback = 'SIFTVANE_' + (String((steps.find((item) => item.op === 'mail.search') as { keywords?: string[] } | undefined)?.keywords?.[0] ?? 'AGENT'))
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      step.label = (!label || label === 'SIFTVANE_UPPER_SNAKE' ? fallback : label.startsWith('SIFTVANE_') ? label : 'SIFTVANE_' + label).slice(0, 40);
    }
    if (op === 'mail.send') {
      step.to = (Array.isArray(source.to) ? source.to : [source.to]).map((value) => String(value ?? '').toLowerCase().trim()).filter((value) => typed.has(value));
      if (typeof step.from === 'string' && !ids.has(step.from)) delete step.from;
      if (!(step.to as string[]).length) { issues.push(`step "${id}": mail.send needs a recipient the user wrote; removed`); return; }
    }
    if (typeof step.from === 'string' && !ids.has(step.from)) { issues.push(`step "${id}": "from" must name an earlier step`); return; }
    // Data-flow repair: attachment saving, labels, and replies need email rows, not photo or empty rows.
    if (['drive.save_attachments', 'mail.label', 'mail.draft_replies'].includes(op) && kinds.get(String(step.from)) !== 'mail') {
      const mail = [...kinds.entries()].reverse().find(([, kind]) => kind === 'mail')?.[0];
      if (!mail) { issues.push(`step "${id}" (${op}) needs email rows from a mail.search step`); return; }
      step.from = mail;
    }
    // A {{summary}} used before any summarize step gets one inserted automatically.
    const usesSummary = ['content', 'body'].some((name) => typeof step[name] === 'string' && /\{\{\s*summary\s*\}\}/i.test(String(step[name])));
    if (usesSummary && !summarized) {
      const latest = [...kinds.keys()].pop();
      if (latest) {
        const auto = genericStepSchema.parse({ id: ('summary_for_' + id).slice(0, 24), op: 'summarize', from: latest });
        if (!ids.has(auto.id)) { steps.push(auto); ids.add(auto.id); kinds.set(auto.id, kinds.get(latest) ?? 'other'); summarized = true; }
      }
    }
    const parsed = genericStepSchema.safeParse(step);
    if (!parsed.success) {
      issues.push(`step "${id}" (${op}): ` + parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; '));
      return;
    }
    ids.add(parsed.data.id);
    steps.push(parsed.data);
    if (parsed.data.op === 'summarize') summarized = true;
    if (parsed.data.op === 'mail.search') kinds.set(parsed.data.id, 'mail');
    else if (parsed.data.op === 'photos.extract') kinds.set(parsed.data.id, 'photo');
    else if ('from' in parsed.data && parsed.data.from) kinds.set(parsed.data.id, kinds.get(parsed.data.from) ?? 'other');
  });
  return { steps, issues };
}
