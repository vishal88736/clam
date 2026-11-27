import type { EphemeralEmail } from '@siftvane/shared';
import { scanOutboundSecrets, scanPromptInjection, verificationNotice } from '@siftvane/shared';
import type { MailSearch } from '../inbox/contracts.js';
import { address, stripHtml } from '../inbox/reader.js';
import { externalHandoffThreats } from '../handoffs/externalHeaders.js';
import type { GoogleAccounts } from '../auth/google.js';
import type { MailboxAdapter } from './inboxAdapter.js';
interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: { name: string; value: string }[];
    body?: { data?: string; attachmentId?: string; size?: number };
    parts?: GmailMessagePart[];
  };
}

type ProgramEmail = EphemeralEmail & { loadAttachments?: () => Promise<NonNullable<EphemeralEmail['attachmentParts']>> };

function searchTerm(value: string) {
  const term = value.replace(/["\\{}()\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return term ? `"${term}"` : '';
}

const attachmentLimit = 750_000;
const attachmentMimes = new Set(['application/pdf', 'text/plain', 'text/calendar', 'text/csv']);
const attachmentParts = (part?: GmailMessagePart): GmailMessagePart[] => part
  ? [...(part.filename && part.mimeType && attachmentMimes.has(part.mimeType) ? [part] : []), ...(part.parts ?? []).flatMap(attachmentParts)]
  : [];

function decodeBase64Url(input?: string): string {
  if (!input || input.length > 120_000) return '';
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function extractBodyAndAttachments(part?: GmailMessagePart): {
  text: string;
  html: string;
  attachments: string[];
} {
  if (!part) return { text: '', html: '', attachments: [] };
  let text = '';
  let html = '';
  const attachments: string[] = [];

  if (part.filename) {
    attachments.push(part.filename);
  }
  if (!part.filename && part.mimeType === 'text/plain' && part.body?.data) {
    text += decodeBase64Url(part.body.data);
  } else if (!part.filename && part.mimeType === 'text/html' && part.body?.data) {
    html += decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const sub = extractBodyAndAttachments(child);
    if (sub.text) text += (text ? '\n' : '') + sub.text;
    if (sub.html) html += (html ? '\n' : '') + sub.html;
    attachments.push(...sub.attachments);
  }
  return { text, html, attachments };
}

function parseGmailMessage(raw: GmailRawMessage): EphemeralEmail {
  const headers = raw.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const extracted = extractBodyAndAttachments(raw.payload);
  const sender = getHeader('From').match(/@([a-z\d.-]+\.[a-z]+)/i)?.[1]?.toLowerCase();
  const auth = headers.find((header) => header.name.toLowerCase() === 'authentication-results')?.value;
  const dmarcDomain = auth?.match(/\bdmarc=pass\b[^;]*\bheader\.from=([a-z\d.-]+)/i)?.[1]?.toLowerCase();
  const plainBody =
    extracted.text ||
    stripHtml(extracted.html).trim() ||
    raw.snippet ||
    '';

  const toHeader = getHeader('To');
  const toList = toHeader
    ? toHeader.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    id: raw.id,
    threadId: raw.threadId,
    from: getHeader('From') || 'unknown@sender',
    to: toList,
    subject: getHeader('Subject') || '(No Subject)',
    date: new Date(Number(raw.internalDate || 0)).toISOString(),
    snippet: raw.snippet || plainBody.slice(0, 140),
    body: plainBody,
    html: extracted.html || undefined,
    replyTo: getHeader('Reply-To') || undefined,
    internetId: getHeader('Message-ID').match(/<[^<> ]+>/)?.[0],
    references: (getHeader('References') + ' ' + getHeader('In-Reply-To')).match(/<[^<> ]+>/g) ?? [],
    verifiedSender: Boolean(sender && auth?.startsWith('mx.google.com;') && dmarcDomain === sender),
    labels: raw.labelIds ?? [],
    hasAttachments: extracted.attachments.length > 0,
    attachmentNames: extracted.attachments,
    isUnread: raw.labelIds?.includes('UNREAD') ?? false,
  };
}

export class GmailLiveAdapter implements MailboxAdapter {
  constructor(private readonly accounts: GoogleAccounts, readonly inboxId: string, private readonly guard: () => void) {
  }

  async request(path: string, init: RequestInit = {}) {
    const operation = !init.method || init.method === 'GET' ? 'mail:read' : 'mail:write';
    const cost = path === '/messages/send' ? 100 : 20;
    return this.accounts.api(this.inboxId, operation, 'https://gmail.googleapis.com/gmail/v1/users/me' + path, this.guard, init, cost);
  }

  private async gmailFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new Error('GMAIL_' + response.status);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  private normalize(raw: GmailRawMessage) {
    const message = parseGmailMessage(raw);
    const redact = (value: string) => this.accounts.redact(this.inboxId, value);
    const rule = scanPromptInjection([message.subject, message.body, message.html ?? '', ...(message.attachmentNames ?? [])].join('\n'));
    const mismatch = message.replyTo && address(message.replyTo) !== address(message.from);
    const forged = externalHandoffThreats((raw.payload?.headers ?? []).map((header) => header.name));
    const signals = [...forged, ...rule.signals, ...(mismatch ? ['SENDER_REPLY_TO_MISMATCH'] : [])];
    return {
      ...message, subject: redact(message.subject), body: redact(message.body), snippet: redact(message.body).slice(0, 140),
      from: redact(message.from), to: message.to.map(redact), replyTo: message.replyTo ? redact(message.replyTo) : undefined,
      attachmentNames: message.attachmentNames?.map(redact),
      html: message.html ? redact(message.html) : undefined, trust_level: 'untrusted_external' as const,
      threat_signals: signals, quarantined: Boolean(forged.length) || rule.detected || Boolean(mismatch),
    };
  }

  async listMessages(query?: string, maxResults = 20): Promise<EphemeralEmail[]> {
    const qs = new URLSearchParams({
      maxResults: String(Math.max(1, Math.min(maxResults, 50))),
    });
    if (query?.trim()) qs.set('q', query.trim());

    const list = await this.gmailFetch<{ messages?: { id: string }[] }>(
      `/messages?${qs.toString()}`
    );
    const ids = list.messages ?? [];
    const results = await Promise.all(ids.map((m) => this.getMessage(m.id)));
    return results.filter((m): m is EphemeralEmail => m !== null);
  }

  async getMessage(messageId: string): Promise<EphemeralEmail | null> {
    try {
      const raw = await this.gmailFetch<GmailRawMessage>(
        `/messages/${encodeURIComponent(messageId)}?format=full`
      );
      return this.normalize(raw);
    } catch (error) {
      if (error instanceof Error && error.message === 'GMAIL_404') return null;
      throw error;
    }
  }

  async listThreads(query = '', maxResults = 20) {
    const params = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(maxResults, 20))) });
    if (query) params.set('q', query);
    const list = await this.gmailFetch<{ threads?: { id: string }[] }>('/threads?' + params);
    return Promise.all((list.threads ?? []).map(({ id }) => this.getThread(id)));
  }

  async getThread(id: string) {
    const thread = await this.gmailFetch<{ id: string; messages?: GmailRawMessage[] }>(
      '/threads/' + encodeURIComponent(id) + '?format=full',
    );
    return { id: thread.id, messages: (thread.messages ?? []).slice(-30).map((entry) => this.normalize(entry)) };
  }

  async listAttachments(messageId: string) {
    const raw = await this.gmailFetch<GmailRawMessage>('/messages/' + encodeURIComponent(messageId) + '?format=full');
    return attachmentParts(raw.payload).slice(0, 3).map((part, index) => ({
      index, name: part.filename!, mime: part.mimeType!, size: part.body?.size ?? 0,
    }));
  }

  private async loadAttachment(id: string, part: GmailMessagePart, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if ((part.body?.size ?? 0) > attachmentLimit) throw new Error('ATTACHMENT_TOO_LARGE');
    const data = part.body?.data ?? (part.body?.attachmentId ? (
      await this.gmailFetch<{ data: string }>(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, { signal })
    ).data : '');
    if (!data || data.length > Math.ceil(attachmentLimit * 4 / 3) + 4 ||
        !/^[A-Za-z0-9_-]+={0,2}$/.test(data) || Buffer.from(data, 'base64url').length > attachmentLimit) {
      throw new Error('ATTACHMENT_INVALID');
    }
    return { name: part.filename!, mime: part.mimeType!, data };
  }

  async getAttachment(messageId: string, index: number) {
    const raw = await this.gmailFetch<GmailRawMessage>('/messages/' + encodeURIComponent(messageId) + '?format=full');
    const part = attachmentParts(raw.payload).slice(0, 3)[index];
    if (!part) throw new Error('ATTACHMENT_NOT_AVAILABLE');
    return this.loadAttachment(messageId, part);
  }

  private async loadMessageAttachments(raw: GmailRawMessage, signal?: AbortSignal): Promise<NonNullable<EphemeralEmail['attachmentParts']>> {
    const attachments: NonNullable<EphemeralEmail['attachmentParts']> = [];
    for (const part of attachmentParts(raw.payload).slice(0, 3)) {
      try {
        attachments.push(await this.loadAttachment(raw.id, part, signal));
      } catch (error) {
        if (!(error instanceof Error) || !['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_INVALID'].includes(error.message)) throw error;
        attachments.push({ name: part.filename!, mime: part.mimeType!, data: 'invalid' });
      }
    }
    return attachments;
  }

  /** Searches Gmail first and reads bodies only for a bounded set of candidates. Attachment bytes are lazy. */
  async listForProgram(search: MailSearch, signal?: AbortSignal): Promise<ProgramEmail[]> {
    const keywords = search.keywords.map(searchTerm).filter(Boolean);
    const sender = search.from_contains ? searchTerm(search.from_contains) : '';
    const subject = search.subject_contains ? searchTerm(search.subject_contains) : '';
    const query = [`newer_than:${search.newer_than_days ?? 14}d`, '-in:spam', '-in:trash', '-in:sent', '-in:drafts',
      sender && 'from:' + sender, subject && 'subject:' + subject, keywords.length && '{' + keywords.join(' ') + '}'].filter(Boolean).join(' ');
    const matched: ProgramEmail[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let inspected = 0;
    for (let page = 0; page < 4 && inspected < 100 && matched.length < search.limit; page++) {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(50, 100 - inspected, Math.max(10, search.limit - matched.length))) });
      if (pageToken) params.set('pageToken', pageToken);
      const list = await this.gmailFetch<{ messages?: { id: string }[]; nextPageToken?: string }>('/messages?' + params, { signal });
      for (const { id } of list.messages ?? []) {
        if (matched.length >= search.limit || inspected >= 100) break;
        if (seen.has(id)) continue;
        seen.add(id);
        inspected++;
        const raw = await this.gmailFetch<GmailRawMessage>(`/messages/${encodeURIComponent(id)}?format=full`, { signal });
        const email = this.normalize(raw);
        if (email.quarantined || email.labels.some((name) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(name)) ||
            verificationNotice.test(email.subject + '\n' + email.body) || scanOutboundSecrets(email.body)) continue;
        if (search.from_contains && !email.from.toLowerCase().includes(search.from_contains.toLowerCase())) continue;
        if (search.subject_contains && !email.subject.toLowerCase().includes(search.subject_contains.toLowerCase())) continue;
        if (attachmentParts(raw.payload).length) {
          let loading: Promise<NonNullable<EphemeralEmail['attachmentParts']>> | undefined;
          matched.push({ ...email, loadAttachments: () => loading ??= this.loadMessageAttachments(raw, signal) });
        } else matched.push(email);
      }
      if (!list.nextPageToken || list.nextPageToken === pageToken) break;
      pageToken = list.nextPageToken;
    }
    return matched;
  }

  async listForInbox(query: string, signal?: AbortSignal): Promise<EphemeralEmail[]> {
    const list = await this.gmailFetch<{ messages?: { id: string }[] }>(
      `/messages?${new URLSearchParams({ maxResults: '50', q: query })}`, { signal }
    );
    const messages = await Promise.all((list.messages ?? []).map(async ({ id }) => {
      const raw = await this.gmailFetch<GmailRawMessage>(`/messages/${encodeURIComponent(id)}?format=full`, { signal });
      const message = this.normalize(raw);
      message.attachmentParts = await this.loadMessageAttachments(raw, signal);
      return message;
    }));
    const seen = new Set(messages.map((message) => message.id));
    const primary = messages.filter((message) => message.labels.includes('INBOX') || message.labels.includes('SENT'));
    for (const message of messages) message.contextOnly = !primary.includes(message);
    const threads = [...new Set(primary.map((message) => message.threadId))].slice(0, 12);
    const history = await Promise.all(threads.map((thread) => this.gmailFetch<{ messages?: GmailRawMessage[] }>(
      '/threads/' + encodeURIComponent(thread) + '?format=full', { signal },
    )));
    for (const thread of history) {
      for (const raw of (thread.messages ?? []).filter((entry) => !seen.has(entry.id)).slice(-3)) {
        seen.add(raw.id);
        messages.push({ ...this.normalize(raw), contextOnly: true });
      }
    }
    return messages;
  }

}
