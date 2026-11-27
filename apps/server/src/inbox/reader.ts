import { DatabaseSync } from 'node:sqlite';
import { inboxIntentSchema, recoveryNotice, scanOutboundSecrets, scanPromptInjection, verificationNotice, type InboxIntent, type InboxPolicy } from '@siftvane/shared';
import type { ReaderMessage } from '../sandbox/seed.js';
import { readAttachments } from './attachments.js';
import { analyzeBatch, ModelFailure, type ModelDecision } from './model.js';
import type { Reader, ReadOptions, ReadResult, ThreadSource } from './contracts.js';
import { externalHandoffThreats } from '../handoffs/externalHeaders.js';

const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const address = (value: string) => value.match(emailPattern)?.[0].toLowerCase() ?? '';
export const domain = (value: string) => address(value).split('@')[1] ?? '';

export function stripHtml(html: string): string {
  return html
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|head|template)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z\d]+)\b[^>]*(?:\bhidden\b|aria-hidden=["']true|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0(?:[; "'>])|color\s*:\s*(?:white|#fff(?:fff)?))[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br\b[^>]*|\/(?:div|p|li|td|tr))\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#32;/gi, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
}

const safeField = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 140);

export function parseMessage(message: ReaderMessage, policy: InboxPolicy): InboxIntent | null {
  const text = message.text.slice(0, 64000);
  const html = (message.html ?? '').slice(0, 64000);
  const observed = [message.subject, text, html, ...(message.attachmentNames ?? [])].join('\n');
  const cleaned = [message.subject, stripHtml(text), stripHtml(html)].join('\n');
  const injection = scanPromptInjection(observed);
  const sender = address(message.from);
  const senderDomain = domain(message.from);
  const title = safeField(message.subject);
  const fields: Record<string, string> = message.verifiedSender ? { trustedSender: 'true' } : {};
  const candidate = (label: string) => new RegExp('^\\s*' + label + '\\s*:\\s*([^\\r\\n]+)', 'im').exec(cleaned)?.[1]?.trim() ?? '';
  const pick = (key: string, label: string) => {
    const value = safeField(candidate(label));
    if (value) fields[key] = value;
  };
  let kind: InboxIntent['kind'];
  let evidence = title.slice(0, 140);
  let confidence = 0.94;
  const ruleIds: string[] = [...new Set([...(message.threatSignals ?? []), ...externalHandoffThreats(Object.keys(message.headers ?? {}))])];
  const isFlight = /\b(?:flight|airline|train)\b/i.test(title) && /\b(?:delay|depart|reschedul|chang|cancel)/i.test(cleaned);
  if (message.failure === 'parse' || message.failure === 'timeout') ruleIds.push(`INPUT_${message.failure.toUpperCase()}`);
  if (injection.detected) ruleIds.push(...injection.signals);
  if (message.replyTo && address(message.replyTo) !== sender) ruleIds.push('SENDER_REPLY_TO_MISMATCH');
  if (message.verifiedSender === false || (isFlight && !policy.trustedAirlines.includes(senderDomain))) ruleIds.push('UNTRUSTED_SENDER');
  if (isFlight && !message.verifiedSender) ruleIds.push('UNVERIFIED_FLIGHT_SENDER');
  if (ruleIds.length) {
    kind = 'hostile_suspected';
    evidence = (cleaned.includes(title) ? title : cleaned).slice(0, 140);
  } else if (recoveryNotice.test(cleaned) || /\bbreach\b/i.test(title)) {
    return null;
  } else if (verificationNotice.test(cleaned)) {
    kind = 'otp_ephemeral';
    evidence = '[verification content redacted]';
  } else if (isFlight) {
    kind = 'flight_update';
    pick('booking', 'Booking'); pick('start', 'Depart'); pick('end', 'Arrive');
    fields.domain = senderDomain;
    if (/\bcancel(?:led|ed|lation)\b/i.test(title)) fields.cancelled = 'true';
    if (!fields.booking || (!fields.cancelled && (!validDateTime(fields.start) || !validDateTime(fields.end)))) confidence = 0.4;
    evidence = fields.start || title;
  } else if (/meeting\s+request|schedul(?:e|ing)|calendar invitation|(?:meeting|calendar).*(?:cancell|reschedul)/i.test(title)) {
    kind = 'meeting_request';
    pick('start', 'Start'); pick('duration', 'Duration'); pick('event', 'Event');
    if (/\bcancell/i.test(title)) fields.cancelled = 'true';
    fields.title = title.replace(/^meeting request\s*:\s*/i, '');
    if ((!fields.cancelled || !fields.event) && (!validDateTime(fields.start) || !/^\d{1,3}$/.test(fields.duration ?? ''))) confidence = 0.45;
    evidence = fields.start || title;
  } else if (/invoice|bill\b|subscription|trial|renewal/i.test(title)) {
    kind = /subscription|trial|renewal/i.test(title) ? 'subscription_notice' : 'bill_invoice';
    pick('vendor', 'Vendor'); pick('invoice', 'Invoice'); pick('due', 'Due');
    const amount = /^([\d]+(?:\.\d{1,2})?)\s+([A-Z]{3})$/i.exec(candidate('Amount'));
    if (amount) {
      fields.amount = amount[1];
      fields.currency = amount[2].toUpperCase();
      evidence = amount[0];
    }
    if (candidate('Account')) fields.account = candidate('Account');
    fields.domain = senderDomain;
    if (!fields.vendor || !fields.invoice || !fields.amount || !validDay(fields.due)) confidence = 0.4;
  } else if (/order|shipped|delivery|tracking/i.test(title) && candidate('Order')) {
    kind = 'delivery_update';
    pick('order', 'Order'); pick('status', 'Status'); pick('returnBy', 'Return by');
    if (!['confirmed', 'shipped', 'delivered'].includes(fields.status?.toLowerCase() ?? '')) confidence = 0.45;
    evidence = fields.status || title;
  } else if (/newsletter|weekly digest|unsubscribe/i.test(cleaned)) {
    kind = 'newsletter_promo';
    fields.title = title;
  } else if (/cold outreach|unsolicited sales/i.test(cleaned)) {
    kind = 'cold_outreach';
  } else if (candidate('Project') || candidate('Commitment') || /commitment|deadline/i.test(title)) {
    kind = 'commitment_deadline';
    pick('project', 'Project'); pick('deadline', 'Deadline'); pick('file', 'File');
    pick('commitment', 'Commitment'); pick('waitingOn', 'Waiting on');
    if (message.sent) fields.sent = 'true';
    if (!fields.project || (fields.deadline && !validDay(fields.deadline))) confidence = 0.45;
    evidence = fields.deadline || title;
  } else {
    return null;
  }
  const recipients = [...new Set((cleaned.match(emailPattern) ?? []).map((item) => item.toLowerCase()))];
  return inboxIntentSchema.parse({
    kind, messageId: message.id, threadId: message.threadId, sender,
    receivedAt: message.receivedAt, confidence, evidence: evidence.slice(0, 240), fields,
    taintedTargets: recipients.filter((candidate) => candidate !== sender),
    ruleIds,
  });
}

export const validDateTime = (value?: string): value is string => Boolean(value &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)));

export const validDay = (value?: string): value is string => Boolean(value &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value);

const normalized = (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim();
const subjectKey = (subject: string) => normalized(subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, ''));
const cleanContent = (message: ReaderMessage) => [
  message.subject, stripHtml(message.text), stripHtml(message.html ?? ''),
].join('\n').replace(/^\s*(?:account|bank details|routing number|iban)\s*:[^\n]*/gim, '').slice(0, 5000);

function source(message: ReaderMessage): ThreadSource {
  return {
    id: message.id, threadId: message.threadId, sender: address(message.from),
    subjectKey: subjectKey(message.subject), receivedAt: message.receivedAt,
    verified: message.verifiedSender === true, sent: message.sent === true,
    internetId: message.internetId, references: message.references,
  };
}

function acceptDecision(message: ReaderMessage, decision: ModelDecision, text: string, context: ReaderMessage[], policy: InboxPolicy) {
  if (decision.kind === 'none') return null;
  const domainName = domain(message.from);
  if (decision.kind === 'flight_update' && (!message.verifiedSender || !policy.trustedAirlines.includes(domainName))) {
    return inboxIntentSchema.parse({
      kind: 'hostile_suspected', messageId: message.id, threadId: message.threadId, sender: address(message.from),
      receivedAt: message.receivedAt, priority: 'urgent', confidence: 1, evidence: '', fields: {},
      taintedTargets: [], ruleIds: ['UNVERIFIED_FLIGHT_SENDER'],
    });
  }
  const proof = normalized(decision.evidence);
  const exactEvidence = proof && normalized(text).includes(proof);
  const fields = { ...decision.fields } as Record<string, string>;
  const authorizedContext = context.filter((item) => item.threadId === message.threadId &&
    address(item.from) === address(message.from) && item.verifiedSender);
  const grounded = normalized([text, ...authorizedContext.map(cleanContent)].join(' '));
  if (fields.cancelled && fields.cancelled.toLowerCase() !== 'true') delete fields.cancelled;
  if (fields.waitingOn && (!address(fields.waitingOn) || !grounded.includes(address(fields.waitingOn)))) delete fields.waitingOn;
  if (message.verifiedSender) fields.trustedSender = 'true';
  if (message.sent) fields.sent = 'true';
  if (['flight_update', 'bill_invoice', 'subscription_notice'].includes(decision.kind)) fields.domain = domainName;
  if (decision.kind === 'bill_invoice' || decision.kind === 'subscription_notice') {
    const account = /^\s*(?:account|bank details|iban)\s*:\s*([^\r\n]+)/im.exec(message.text)?.[1]?.trim().slice(0, 140);
    if (account) fields.account = account;
  }
  const hasStrongIdentifiers = ['booking', 'invoice', 'event'].every((key) =>
    !fields[key] || grounded.includes(normalized(fields[key])));
  const timestamps = [...grounded.matchAll(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:\d{2})/g)]
    .map(([value]) => Date.parse(value));
  const groundedFacts = ['start', 'end', 'duration', 'due', 'amount', 'deadline', 'returnBy'].every((key) => {
    const value = fields[key];
    if (!value) return true;
    if (key === 'start' || key === 'end') return timestamps.includes(Date.parse(value));
    return grounded.match(/[-\d.]+/g)?.includes(value) ?? false;
  });
  const confidence = exactEvidence && hasStrongIdentifiers && groundedFacts ? decision.confidence : Math.min(decision.confidence, 0.4);
  const draftText = [decision.reply?.subject, decision.reply?.text].join(' ');
  const unsafeDraft = scanOutboundSecrets(draftText) || scanPromptInjection(draftText).detected ||
    Boolean(address(draftText)) || /https?:|[\r\n]/i.test(decision.reply?.subject ?? '') || /https?:/i.test(draftText);
  return inboxIntentSchema.parse({
    kind: decision.kind, messageId: message.id, threadId: message.threadId, sender: address(message.from),
    receivedAt: message.receivedAt, priority: decision.priority, confidence,
    evidence: exactEvidence ? decision.evidence : '', guidance: confidence < policy.confidenceThreshold ? 'review' : decision.plan,
    reply: decision.reply && !unsafeDraft ? decision.reply : undefined,
    contextIds: context.filter((item) => item.id !== message.id).map((item) => item.id),
    fields, taintedTargets: [...new Set((grounded.match(emailPattern) ?? []).filter((recipient) => recipient !== address(message.from)))],
    ruleIds: exactEvidence && hasStrongIdentifiers && groundedFacts ? [] : ['MODEL_EVIDENCE_REVIEW'],
  });
}

function offlineWithContext(intent: InboxIntent, message: ReaderMessage, context: ReaderMessage[], policy: InboxPolicy): InboxIntent {
  const related = context.filter((entry) => entry.threadId === message.threadId && entry.id !== message.id &&
    Date.parse(entry.receivedAt) < Date.parse(message.receivedAt) && entry.verifiedSender &&
    address(entry.from) === intent.sender);
  if (intent.kind !== 'flight_update' && intent.kind !== 'meeting_request') {
    return { ...intent, contextIds: context.filter((entry) => entry.id !== message.id && entry.threadId === message.threadId &&
      Date.parse(entry.receivedAt) < Date.parse(message.receivedAt)).map((entry) => entry.id) };
  }
  const keys = intent.kind === 'flight_update' ? ['booking'] : ['start', 'duration'];
  const fields = { ...intent.fields };
  const used = new Set<string>();
  const older = related.map((entry) => ({ entry, parsed: parseMessage(entry, policy) }));
  for (const key of keys) {
    if (fields[key]) continue;
    const options = older.filter(({ parsed }) => parsed?.kind === intent.kind && parsed.fields[key]);
    if (new Set(options.map(({ parsed }) => parsed!.fields[key])).size === 1) {
      fields[key] = options[0].parsed!.fields[key];
      for (const { entry } of options) used.add(entry.id);
    }
  }
  const complete = intent.kind === 'flight_update' ? fields.booking && (fields.cancelled || validDateTime(fields.start) && validDateTime(fields.end))
    : validDateTime(fields.start) && /^\d{1,3}$/.test(fields.duration ?? '');
  return { ...intent, fields, confidence: used.size && complete ? 0.93 : intent.confidence, contextIds: [...used] };
}

async function parseMessages(messages: ReaderMessage[], policy: InboxPolicy, options: ReadOptions = {}, history: ReaderMessage[] = []): Promise<ReadResult> {
  const intents: InboxIntent[] = [];
  const mailStates: ReadResult['mailStates'] = {};
  const threadSources: ThreadSource[] = [];
  const primaryIds = new Set(messages.map((message) => message.id));
  const records: ReaderMessage[] = [];
  const eligible: Array<{ message: ReaderMessage; text: string; id: number; thread: number }> = [];
  const threads = new Map<string, number>();
  for (const [index, message] of [...history, ...messages].entries()) {
    options.signal?.throwIfAborted();
    mailStates[message.id] = { labels: message.labels, receivedAt: message.receivedAt };
    let content = message;
    if (message.attachments?.length) {
      try {
        const extracted = await readAttachments(message.attachments);
        content = { ...message, text: message.text + '\n' + (message.redactText?.(extracted) ?? extracted) };
      } catch {
        content = { ...message, failure: 'parse' };
      }
    }
    const offline = parseMessage(content, policy);
    if (offline?.kind !== 'hostile_suspected') {
      threadSources.push(source(content));
      records.push(content);
    }
    if (options.agent?.mode !== 'llm' || offline?.kind === 'hostile_suspected' || offline?.kind === 'otp_ephemeral') {
      if (offline && primaryIds.has(message.id)) intents.push(offline);
      continue;
    }
    const text = cleanContent(content);
    if (/password\s+reset|security\s+alert|breach/i.test(content.subject) || scanOutboundSecrets(text)) continue;
    if (!threads.has(content.threadId)) threads.set(content.threadId, threads.size + 1);
    eligible.push({ message: content, text, id: index + 1, thread: threads.get(content.threadId)! });
  }

  if (options.agent?.mode === 'llm') {
    const primary = eligible.filter((item) => primaryIds.has(item.message.id));
    const batchSize = options.agent.provider === 'ollama' ? 3 : 4;
    for (let offset = 0; offset < primary.length; offset += batchSize) {
      options.signal?.throwIfAborted();
      const batch = primary.slice(offset, offset + batchSize);
      const ids = new Set(batch.map((item) => item.id));
      const context = eligible.filter((item) => !ids.has(item.id) && batch.some((entry) =>
        entry.thread === item.thread && Date.parse(item.message.receivedAt) <= Date.parse(entry.message.receivedAt))).slice(-4);
      const rows = [...context, ...batch].map((item) => ({
        id: item.id, thread: item.thread, direction: item.message.sent ? 'sent' as const : 'received' as const,
        date: item.message.receivedAt, content: item.text, ...(!ids.has(item.id) ? { context: true } : {}),
      }));
      try {
        const result = await analyzeBatch(options.agent, rows, options.signal);
        options.onUsage?.(result.usage);
        for (const decision of result.decisions) {
          const item = batch.find((entry) => entry.id === decision.id)!;
          const thread = [...context, ...batch].filter((entry) => entry.thread === item.thread && entry.id !== item.id)
            .map((entry) => entry.message);
          const parsed = acceptDecision(item.message, decision, item.text, thread, policy);
          if (parsed) intents.push(parsed);
        }
      } catch (error) {
        if (error instanceof ModelFailure) options.onUsage?.(error.usage, error.message);
        throw error;
      }
    }
  }
  return { emailCount: messages.length,
    intents: options.agent?.mode === 'llm' ? intents : intents.map((intent) => {
      const original = records.find((entry) => entry.id === intent.messageId);
      return original ? offlineWithContext(intent, original, records, policy) : intent;
    }),
    mailStates, threadSources,
  };
}

export function sandboxReader(filename: string): Reader {
  return {
    async read(_now, scope, policy, options) {
      // SQLite opens the file with SQLITE_OPEN_READONLY. Query-only is an additional connection guard.
      const db = new DatabaseSync(filename, { readOnly: true, enableForeignKeyConstraints: true });
      try {
        db.exec('PRAGMA query_only=ON');
        const entries = db.prepare(`SELECT m.body, m.scope, e.body AS state FROM inbox_sandbox_messages m
          JOIN inbox_entities e ON e.mode='sandbox' AND e.kind='mail' AND e.id=m.id
          WHERE m.scope=? OR (?='inbox' AND m.scope='history') ORDER BY m.rowid`).all(scope, scope);
        const convert = (entry: (typeof entries)[number]) => ({
          ...JSON.parse(String(entry.body)) as ReaderMessage,
          labels: (JSON.parse(String(entry.state)) as { labels: string[] }).labels,
        });
        const messages = entries.filter((entry) => entry.scope === scope).map(convert);
        const history = entries.filter((entry) => entry.scope === 'history').map(convert);
        return parseMessages(messages, policy, options, history);
      } finally {
        db.close();
      }
    },
  };
}

export function liveReader(readMessages: () => Promise<ReaderMessage[]>) {
  return {
    async read(_now: Date, _scope: 'inbox' | 'trap', policy: InboxPolicy, options?: ReadOptions): Promise<ReadResult> {
      const messages = await readMessages();
      return parseMessages(messages.filter((message) => !message.contextOnly), policy, options,
        messages.filter((message) => message.contextOnly));
    },
  };
}
