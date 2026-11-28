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
  z.object({ id, op: z.literal('mail.search'), keywords: z.array(z.string().trim().min(2).max(40)).max(6).default([]), about: z.string().trim().min(3).max(200).optional(),
    from_contains: z.string().trim().min(1).max(80).optional(), subject_contains: z.string().trim().min(1).max(80).optional(),
    newer_than_days: z.number().int().min(1).max(365).optional(),
    include_attachments: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(25) }).strict(),
  z.object({ id, op: z.literal('photos.extract'), category: z.enum(['RECEIPTS', 'DOCUMENTS', 'SCREENSHOTS']).default('RECEIPTS'),
    limit: z.number().int().min(1).max(20).default(10) }).strict(),
  z.object({ id, op: z.literal('filter'), from, field: z.string().trim().min(1).max(40), contains: z.string().trim().max(80).optional(),
    exists: z.boolean().optional() }).strict(),
  z.object({ id, op: z.literal('summarize'), from, heading: text(120).optional(), instructions: text(300).optional() }).strict(),
  // AI operations: the model reads each row's source (email, attachment, file, sheet row) as untrusted data.
  z.object({ id, op: z.literal('extract'), from, fields: z.array(text(40)).min(1).max(12), instructions: text(300).optional() }).strict(),
  z.object({ id, op: z.literal('classify'), from, condition: text(200) }).strict(),
  // Read the user's Drive (never modifies it).
  z.object({ id, op: z.literal('drive.find'), query: z.string().trim().max(80).optional(),
    kind: z.enum(['any', 'doc', 'sheet', 'pdf', 'text', 'folder', 'file']).default('any'), limit: z.number().int().min(1).max(25).default(10) }).strict(),
  z.object({ id, op: z.literal('drive.read'), from }).strict(),
  z.object({ id, op: z.literal('sheets.read'), title: text(100).optional(), from: from.optional(), tab: segment.optional(),
    limit: z.number().int().min(1).max(200).default(100) }).strict(),
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
/** What a step's rows come from: emails, photos, Drive files, or anything else (sheet rows, derived rows). */
export type RowKind = 'mail' | 'photo' | 'file' | 'other';
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
  extract: 'system', classify: 'system', 'drive.find': 'drive', 'drive.read': 'drive', 'sheets.read': 'sheets',
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
    case 'drive.find': case 'drive.read': case 'sheets.read': return ['workspace:read'];
    case 'filter': case 'summarize': case 'extract': case 'classify': return [];
  }
}

export function describeStep(step: GenericStep): string {
  switch (step.op) {
    case 'mail.search': return `Search mail${step.about ? ` about "${step.about}"` : step.keywords.length ? ' for ' + step.keywords.join(', ') : ''}${step.from_contains ? ' from ' + step.from_contains : ''}`;
    case 'photos.extract': return `Read the text of ${step.category.toLowerCase()} photos`;
    case 'filter': return `Keep rows where ${step.field}${step.contains ? ' contains "' + step.contains + '"' : ' is present'}`;
    case 'summarize': return step.instructions ? `Summarize: ${step.instructions}` : 'Summarize the matching items';
    case 'extract': return `Read each item and extract ${step.fields.join(', ')}`;
    case 'classify': return `Keep items where: ${step.condition}`;
    case 'drive.find': return `Find ${step.kind === 'any' ? 'files' : step.kind + ' files'} in Drive${step.query ? ` matching "${step.query}"` : ''}`;
    case 'drive.read': return 'Read the found files';
    case 'sheets.read': return `Read rows from sheet${step.title ? ` "${step.title}"` : 's'}${step.tab ? ` / ${step.tab}` : ''}`;
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
  'SOURCES',
  'mail.search {about?, keywords[], from_contains?, subject_contains?, newer_than_days?, include_attachments?, limit?} -> one row per email (date, from, subject, message_id, plus any "Label: value" fields). about = what the emails are about in plain words: the AI reads recent mail and keeps the matching ones (prefer it whenever exact words are uncertain). include_attachments also reads PDF/text attachments',
  'drive.find {query?, kind?: any|doc|sheet|pdf|text|folder|file, limit?} -> one row per file in the user\'s Drive (name, kind, modified, link)',
  'drive.read {from: a drive.find step} -> the same rows with each file\'s text loaded (Docs, PDFs, text files, Sheets as text)',
  'sheets.read {title? | from: a drive.find step, tab?, limit?} -> one row per spreadsheet row of the best-matching sheet, fields named after the header row (snake_case)',
  'photos.extract {category: RECEIPTS|DOCUMENTS|SCREENSHOTS, limit?} -> one row per photo (filename, date, and its text; use extract to pull fields)',
  'UNDERSTANDING (the AI reads each row\'s email/file/row text)',
  'extract {from, fields[], instructions?} -> adds the named fields to every row (whatever the request needs, named in the user\'s own words)',
  'classify {from, condition} -> keeps only rows matching a plain-language condition written from the user\'s request',
  'filter {from, field, contains? | exists?} -> exact text match on a field',
  'summarize {from, heading?, instructions?} -> a written summary usable as {{summary}} later',
  'ACTIONS',
  'sheets.append {from, title, tab?, columns[]} (columns are matched to row fields; missing values are extracted automatically)',
  'docs.write {title, heading, content? | from?, folder?, mode?: append|replace_section}',
  'drive.folder {path[]}', 'drive.save_attachments {from: a mail.search step, folder[]}', 'drive.save_text {folder[], name(.md|.txt|.csv), content, from?}',
  'calendar.reminders {from, date_field, title, time_utc?}', 'mail.label {from, label: SIFTVANE_UPPER_SNAKE}',
  'mail.draft_replies {from, subject, body} (drafts a reply to each row sender; in AI mode each reply is written for its email from the user\'s business profile, with body as guidance; always needs approval)',
  'mail.send {to[] (only addresses the user wrote), subject, body, from?} (sent once per distinct content; non-allowlisted recipients need approval)',
  'Templates may use {{field}} for row fields, {{count}}, {{date}}, {{rows}} (bulleted list), {{summary}} (latest summarize step).',
].join('\n');

const modeAliases: Record<string, 'append' | 'replace_section'> = {
  append: 'append', add: 'append', insert: 'append', replace: 'replace_section', replace_section: 'replace_section', overwrite: 'replace_section',
  update: 'replace_section', write: 'replace_section',
};
const opAliases: Record<string, GenericStep['op']> = Object.fromEntries((Object.keys(opService) as GenericStep['op'][])
  .flatMap((op) => [[op, op], [op.replace('.', '_'), op], [op.replace('.', ''), op]]));
const allowedKeys: Record<GenericStep['op'], string[]> = {
  'mail.search': ['about', 'keywords', 'from_contains', 'subject_contains', 'newer_than_days', 'include_attachments', 'limit'], 'photos.extract': ['category', 'limit'],
  filter: ['from', 'field', 'contains', 'exists'], summarize: ['from', 'heading', 'instructions'],
  extract: ['from', 'fields', 'instructions'], classify: ['from', 'condition'], 'drive.find': ['query', 'kind', 'limit'], 'drive.read': ['from'],
  'sheets.read': ['title', 'from', 'tab', 'limit'], 'drive.folder': ['path'], 'drive.save_attachments': ['from', 'folder'],
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
/**
 * Side effects a plan may only include when the user's own words ask for them (planner and review alike): changing
 * labels in the mailbox and copying content into Drive. Creating Sheets and Docs is left to the model's judgement
 * (reversible outputs in the user's own Drive; reviews still cannot rewrite a sheet already written).
 */
const grounding: Record<string, RegExp> = {
  'drive.save_attachments': /\b(?:drive|folders?|save|saves|store|backup|back up|archive|attachments?|pdfs?|files?|download)\b/,
  'drive.save_text': /\b(?:drive|folders?|save|saves|store|backup|back up|archive|files?|export|txt|csv|markdown)\b/,
  'mail.label': /\b(?:label\w*|tag\w*|mark\w*|organi[sz]\w*|categori[sz]\w*|sort\w*|file them|move them)\b/,
  'mail.draft_replies': /\b(?:repl\w*|respond\w*|answer\w*|drafts?|write back|get back|follow[- ]?up)\b/,
  'calendar.reminders': /\b(?:remind\w*|calendar|schedul\w*|alert\w*|notify|notification|don'?t (?:let me )?(?:forget|miss)|before it|ahead of)\b/,
};

export function repairProgram(raw: unknown[], instruction: string, knownIds: string[] = [], knownKinds: Record<string, RowKind> = {}) {
  const text = instruction.toLowerCase();
  const typed = new Set([...instruction.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0].toLowerCase()));
  const mentionsTime = /\b(?:today|yesterday|week|weeks|month|months|day|days|recent|recently|latest|since|last|past)\b/.test(text);
  const ids = new Set(knownIds);
  const steps: GenericStep[] = [];
  const issues: string[] = [];
  const kinds = new Map<string, RowKind>(Object.entries(knownKinds));
  let summarized = Object.keys(knownKinds).some((name) => name.startsWith('summary'));
  // Extracted values whose name collides with a source's own field ("date" is when the email arrived) get a distinct name;
  // later steps reading through that step use the new name. stepId -> { requested: renamed }.
  const renamed = new Map<string, Record<string, string>>();
  const owned: Record<string, string> = { date: 'mentioned_date' };
  // Fields the AI writes (free text): exact-text filters on them are converted into meaning-based classify steps.
  const aiFields = new Map<string, Set<string>>();
  // Steps dropped as ungrounded; later steps reading from them read from the dropped step's input instead.
  const skipped = new Map<string, string | undefined>();
  const wantsPhotos = /\b(?:photos?|pictures?|pics?|images?|screenshots?|scans?|scanned|camera|google photos)\b/.test(text);
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
      if (typeof source.about !== 'string' || source.about.trim().length < 3) delete step.about;
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
    // Models often point "folder" at an earlier drive.folder step by its id: use that step's path, never a folder named after the id.
    if (typeof step.folder === 'string') {
      const named = steps.find((entry) => entry.op === 'drive.folder' && entry.id === step.folder) as { path?: string[] } | undefined;
      if (named?.path) step.folder = [...named.path];
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
    // A doc without a heading uses its title rather than being dropped.
    if (op === 'docs.write' && typeof step.heading !== 'string' && typeof step.title === 'string') step.heading = step.title;
    if (op === 'extract') {
      const map: Record<string, string> = { ...(typeof step.from === 'string' ? renamed.get(step.from) : undefined) };
      step.fields = (Array.isArray(source.fields) ? source.fields : typeof source.fields === 'string' ? source.fields.split(',') : [])
        .map((field) => String(field).trim().slice(0, 40)).filter(Boolean)
        // The email's own sender and subject are already on every row; asking the AI for them would only rewrite them.
        .filter((field) => !['from', 'sender', 'subject'].includes(field.toLowerCase().replace(/[^a-z0-9]+/g, '_'))).slice(0, 12)
        .map((field) => { const name = field.toLowerCase().replace(/[^a-z0-9]+/g, '_'); if (owned[name]) { map[name] = owned[name]; return owned[name]; } return field; });
      if (Object.keys(map).length) renamed.set(id, map);
      const inherited = typeof step.from === 'string' ? aiFields.get(step.from) : undefined;
      aiFields.set(id, new Set([...(inherited ?? []), ...(step.fields as string[]).map((field) => field.toLowerCase().replace(/[^a-z0-9]+/g, '_'))]));
    } else if (typeof step.from === 'string' && aiFields.has(step.from)) aiFields.set(id, aiFields.get(step.from)!);
    if (op !== 'extract' && typeof step.from === 'string' && renamed.has(step.from)) {
      const map = renamed.get(step.from)!;
      renamed.set(id, map);
      if (op === 'filter' && typeof step.field === 'string' && map[step.field]) step.field = map[step.field];
      if (op === 'calendar.reminders' && typeof step.date_field === 'string' && map[step.date_field.toLowerCase()]) step.date_field = map[step.date_field.toLowerCase()];
    }
    if (op === 'drive.find' && step.kind !== undefined) {
      const kind = String(step.kind).toLowerCase().replace(/s$/, '').replace(/^(?:document|google_doc)$/, 'doc').replace(/^(?:spreadsheet|google_sheet)$/, 'sheet');
      step.kind = ['any', 'doc', 'sheet', 'pdf', 'text', 'folder', 'file'].includes(kind) ? kind : 'any';
    }
    if (op === 'drive.find' && step.limit !== undefined) step.limit = clamp(step.limit, 1, 25);
    // Models sometimes write Drive API syntax ("mimeType='application/pdf' and 'contract' in name"); keep only the words.
    if (op === 'drive.find' && typeof step.query === 'string') {
      step.query = step.query.replace(/mimetype\s*=\s*'[^']*'/gi, ' ').replace(/[='":()]/g, ' ').split(/\s+/)
        .filter((word) => word && !/^(?:and|or|not|in|contains|name|title|filename|fulltext|mimetype|type|kind|file|files|trashed|true|false|application\/\S+)$/i.test(word))
        .join(' ').slice(0, 80) || undefined;
    }
    if (op === 'sheets.read' && step.limit !== undefined) step.limit = clamp(step.limit, 1, 200);
    // File reads need Drive file rows; point them at the latest drive.find when the model wired them elsewhere.
    if ((op === 'drive.read' || op === 'sheets.read' && step.title === undefined) && kinds.get(String(step.from)) !== 'file') {
      const files = [...kinds.entries()].reverse().find(([, kind]) => kind === 'file')?.[0];
      if (!files) { issues.push(`step "${id}" (${op}) needs ${op === 'sheets.read' ? 'a "title" or ' : ''}file rows from a drive.find step`); return; }
      step.from = files;
    }
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
    if (typeof step.from === 'string' && skipped.has(step.from)) {
      const target = skipped.get(step.from);
      if (target) step.from = target; else delete step.from;
    }
    if (op === 'photos.extract' && !wantsPhotos) {
      issues.push(`step "${id}": the user did not ask for photos; removed (use mail.search for emails)`);
      skipped.set(id, [...kinds.keys()].pop());
      return;
    }
    const want = grounding[op];
    if (want && !want.test(text)) {
      issues.push(`step "${id}" (${op}): the user did not ask for this; removed`);
      skipped.set(id, typeof step.from === 'string' ? step.from : [...kinds.keys()].pop());
      return;
    }
    if (op === 'filter' && typeof step.contains === 'string' && step.contains.includes('@') && !text.includes(step.contains.toLowerCase().trim())) {
      issues.push(`step "${id}": filter value "${step.contains}" is not in the user's request; removed (never invent addresses)`);
      skipped.set(id, typeof step.from === 'string' ? step.from : undefined);
      return;
    }
    if (typeof step.from === 'string' && !ids.has(step.from)) { issues.push(`step "${id}": "from" must name an earlier step`); return; }
    // Exact text matching on what the AI wrote is meaningless (its wording varies): judge by meaning instead.
    if (op === 'filter' && typeof step.contains === 'string' && typeof step.field === 'string' && aiFields.get(String(step.from))?.has(step.field)) {
      const condition = `its ${step.field.replace(/_/g, ' ')} is about "${step.contains}"`;
      for (const name of Object.keys(step)) if (!['id', 'from'].includes(name)) delete step[name];
      Object.assign(step, { op: 'classify', condition });
    }
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
    else if (parsed.data.op === 'drive.find') kinds.set(parsed.data.id, 'file');
    else if (parsed.data.op === 'sheets.read') kinds.set(parsed.data.id, 'other');
    else if ('from' in parsed.data && parsed.data.from) kinds.set(parsed.data.id, kinds.get(parsed.data.from) ?? 'other');
  });
  return { steps, issues };
}
