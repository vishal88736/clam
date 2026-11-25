import { DatabaseSync } from 'node:sqlite';
import { inboxIntentSchema, scanPromptInjection, type InboxIntent, type InboxPolicy } from '@clam/shared';
import type { ReaderMessage } from '../sandbox/seed.js';
import { readAttachments } from './attachments.js';
import type { Reader, ReadResult } from './contracts.js';

const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const address = (value: string) => value.match(emailPattern)?.[0].toLowerCase() ?? '';
export const domain = (value: string) => address(value).split('@')[1] ?? '';

function stripHtml(html: string): string {
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
  const ruleIds: string[] = [];
  const isFlight = /\b(?:flight|airline|train)\b/i.test(title) && /\b(?:delay|depart|reschedul|chang|cancel)/i.test(cleaned);
  if (message.failure === 'parse' || message.failure === 'timeout') ruleIds.push(`INPUT_${message.failure.toUpperCase()}`);
  if (injection.detected) ruleIds.push(...injection.signals);
  if (message.replyTo && address(message.replyTo) !== sender) ruleIds.push('SENDER_REPLY_TO_MISMATCH');
  if (message.verifiedSender === false || (isFlight && !policy.trustedAirlines.includes(senderDomain))) ruleIds.push('UNTRUSTED_SENDER');
  if (isFlight && !message.verifiedSender) ruleIds.push('UNVERIFIED_FLIGHT_SENDER');
  if (ruleIds.length) {
    kind = 'hostile_suspected';
    evidence = (cleaned.includes(title) ? title : cleaned).slice(0, 140);
  } else if (/password\s+reset|security\s+alert|breach/i.test(title)) {
    return null;
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
  } else if (/verification code|one.time code|\botp\b/i.test(cleaned)) {
    kind = 'otp_ephemeral';
    evidence = title;
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

async function parseMessages(messages: ReaderMessage[], policy: InboxPolicy): Promise<ReadResult> {
  const intents: InboxIntent[] = [];
  const mailStates: ReadResult['mailStates'] = {};
  for (const message of messages) {
    mailStates[message.id] = { labels: message.labels, receivedAt: message.receivedAt };
    let content = message;
    if (message.attachments?.length) {
      try {
        content = { ...message, text: message.text + '\n' + await readAttachments(message.attachments) };
      } catch {
        content = { ...message, failure: 'parse' };
      }
    }
    const intent = parseMessage(content, policy);
    if (intent) intents.push(intent);
  }
  return { emailCount: messages.length, intents, mailStates, tokens: 0, usd: 0 };
}

export function sandboxReader(filename: string): Reader {
  return {
    async read(_now, scope, policy) {
      // SQLite opens the file with SQLITE_OPEN_READONLY. Query-only is an additional connection guard.
      const db = new DatabaseSync(filename, { readOnly: true, enableForeignKeyConstraints: true });
      try {
        db.exec('PRAGMA query_only=ON');
        const entries = db.prepare(`SELECT m.body, e.body AS state FROM inbox_sandbox_messages m
          JOIN inbox_entities e ON e.mode='sandbox' AND e.kind='mail' AND e.id=m.id
          WHERE m.scope=? ORDER BY m.rowid`).all(scope);
        const messages = entries.map((entry) => ({
          ...JSON.parse(String(entry.body)) as ReaderMessage,
          labels: (JSON.parse(String(entry.state)) as { labels: string[] }).labels,
        }));
        return parseMessages(messages, policy);
      } finally {
        db.close();
      }
    },
  };
}

export function liveReader(readMessages: () => Promise<ReaderMessage[]>) {
  return {
    async read(_now: Date, _scope: 'inbox' | 'trap', policy: InboxPolicy): Promise<ReadResult> {
      const messages = await readMessages();
      return parseMessages(messages, policy);
    },
  };
}
