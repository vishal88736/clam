import type { InboxCalendarEvent } from '@siftvane/shared';
import { GoogleCalendar, GoogleCalendarLiveAdapter } from '../calendar/google.js';
import type { ReaderMessage } from '../sandbox/seed.js';
import type { GoogleAccounts } from '../auth/google.js';
import { GmailLiveAdapter } from '../mail/gmail.js';
import { address } from './reader.js';
import type { ActionKind, Claim, InboxTarget, MailSearch, Mode, SafeAction, Snapshot, Tier } from './contracts.js';
import { outboundPayload } from './policy.js';
import type { InboxStore } from './store.js';
import { canonicalJson, sha256 } from './trace.js';
import { verifiedState } from '../workspace/types.js';
import { type HandoffService, handoffReceipt, type SignedHandoff } from '../handoffs/service.js';

export function comparable(value: Snapshot): Snapshot {
  if (!value) return null;
  const { etag: _etag, ...rest } = value;
  return rest;
}

export const matches = (left: Snapshot, right: Snapshot) =>
  canonicalJson(comparable(left)) === canonicalJson(comparable(right));

const outboundState = (action: SafeAction, tier: Tier) => {
  const payload = outboundPayload(action, tier);
  return {
    recipient: payload.to, subjectHash: sha256(payload.subject), bodyHash: sha256(payload.body),
    disclosure: true, status: action.kind === 'draft' ? 'DRAFT' : 'SENT',
  };
};

export class SandboxTarget implements InboxTarget {
  constructor(private readonly store: InboxStore, private readonly guard: () => void, private readonly mode: Mode = 'sandbox',
    private readonly handoffs?: HandoffService) {}

  async read(action: Pick<SafeAction, 'kind' | 'target'>) {
    this.guard();
    if (action.kind === 'handoff') {
      const item = this.handoffs?.delivery(action.target);
      return item ? handoffReceipt(item) : null;
    }
    return this.store.entity(this.mode, action.kind, action.target);
  }

  async calendar() {
    this.guard();
    return this.store.entities<InboxCalendarEvent>(this.mode, 'calendar');
  }

  all(kind: ActionKind) {
    return this.store.entities(this.mode, kind);
  }

  async dispatch(action: SafeAction, tier: Tier, before: Snapshot, id: string, signal: AbortSignal) {
    this.guard();
    signal.throwIfAborted();
    if (action.kind === 'review') return id;
    this.store.transaction(() => {
      if (action.kind === 'handoff') {
        if (!this.handoffs || !this.store.action(id)) throw new Error('HANDOFF_NOT_RESERVED');
        this.handoffs.write(action.after as SignedHandoff, 'DELIVERED');
        return;
      }
      if (!matches(this.store.entity(this.mode, action.kind, action.target), before)) throw new Error('TARGET_VERSION_CHANGED');
      const result = action.kind === 'send' || action.kind === 'draft' ? outboundState(action, tier) : action.after;
      this.store.setEntity(this.mode, action.kind, action.target, result);
      if ((action.kind === 'send' || action.kind === 'draft') && this.mode === 'sandbox') {
        this.store.setEntity(this.mode, 'review', 'transport:' + id, outboundPayload(action, tier));
      }
    });
    return action.target;
  }

  async restore(claim: Claim, signal: AbortSignal) {
    this.guard();
    signal.throwIfAborted();
    this.store.transaction(() => {
      if (!matches(this.store.entity(this.mode, claim.kind, claim.target), claim.after)) throw new Error('TARGET_CHANGED_SINCE_RUN');
      this.store.setEntity(this.mode, claim.kind, claim.target, claim.before);
    });
  }
}

type GmailList = { messages?: { id: string }[] };
type GmailLabels = { labels?: { id: string; name: string; type: string }[] };
const messageId = (id: string) => `<siftvane-${id}@agent.siftvane.local>`;
const legacyMessageId = (id: string) => `<clam-${id}@agent.clam.local>`;

function parseWireMime(encodedMime: string, status: 'SENT' | 'DRAFT'): Snapshot {
  const raw = Buffer.from(encodedMime, 'base64url').toString('utf8').replace(/\r\n/g, '\n');
  const parts = (message: string) => {
    const cut = message.indexOf('\n\n');
    if (cut < 0) throw new Error('GMAIL_SENT_MIME_UNSUPPORTED');
    const headers = message.slice(0, cut).replace(/\n[ \t]+/g, ' ');
    return {
      header: (name: string) => headers.match(new RegExp('^' + name + ':\\s*([^\\n]+)', 'im'))?.[1].trim() ?? '',
      content: message.slice(cut + 2).trim(),
    };
  };
  const top = parts(raw);
  const boundary = /\bboundary="?([A-Za-z0-9_.=-]+)"?/i.exec(top.header('Content-Type'))?.[1];
  const plain = boundary ? top.content.split('--' + boundary).slice(1, -1)
    .map((item) => parts(item.trim())).find((item) => /^text\/plain\b/i.test(item.header('Content-Type'))) : top;
  if (!plain) throw new Error('GMAIL_SENT_MIME_UNSUPPORTED');
  const subject = top.header('Subject')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_word, encoded: string) => Buffer.from(encoded, 'base64').toString('utf8'));
  const body = plain.header('Content-Transfer-Encoding').toLowerCase() === 'base64'
    ? Buffer.from(plain.content.replace(/\s/g, ''), 'base64').toString('utf8').trim() : plain.content;
  return {
    recipient: top.header('To').toLowerCase(), subjectHash: sha256(subject),
    bodyHash: sha256(body), disclosure: top.header('X-Agent-Automated') === 'true', status,
  };
}

function mimeSubject(subject: string) {
  const parts = [''];
  for (const character of subject) {
    const last = parts.length - 1;
    if (Buffer.byteLength(parts[last] + character) > 42) parts.push(character);
    else parts[last] += character;
  }
  return parts.map((part) => '=?UTF-8?B?' + Buffer.from(part).toString('base64') + '?=').join('\r\n ');
}

export class LiveTarget implements InboxTarget {
  private readonly local: SandboxTarget;
  private readonly google: GoogleCalendar;

  constructor(store: InboxStore, private readonly gmail: GmailLiveAdapter | { getValidAccessToken(): Promise<string> }, calendarId: string, private readonly guard: () => void,
    private readonly connection?: { inboxId: string; accounts: GoogleAccounts }) {
    this.local = new SandboxTarget(store, guard, connection ? `live:${connection.inboxId}` : 'live');
    this.google = connection ? new GoogleCalendarLiveAdapter(connection.accounts, connection.inboxId, calendarId, guard) :
      new GoogleCalendar(() => this.token(), calendarId, guard);
  }

  private async token() {
    this.guard();
    if (this.gmail instanceof GmailLiveAdapter) throw new Error('USE_GOOGLE_ACCOUNT_VAULT');
    return this.gmail.getValidAccessToken();
  }

  private async request<T>(suffix: string, init?: RequestInit): Promise<T> {
    if (this.gmail instanceof GmailLiveAdapter) {
      const response = await this.gmail.request(suffix, init);
      if (!response.ok) throw new Error('GMAIL_' + response.status);
      return response.status === 204 ? undefined as T : await response.json() as T;
    }
    const accessToken = await this.token();
    this.guard();
    init?.signal?.throwIfAborted();
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me' + suffix, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('GMAIL_' + response.status);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async readerMessages(search?: MailSearch, signal?: AbortSignal): Promise<ReaderMessage[]> {
    this.guard();
    if (!(this.gmail instanceof GmailLiveAdapter)) throw new Error('LIVE_ADAPTER_UNAVAILABLE');
    const [messages, labels] = await Promise.all([
      search ? this.gmail.listForProgram(search, signal) : this.gmail.listForInbox('newer_than:14d -in:spam -in:trash', signal),
      search ? Promise.resolve(null) : this.request<GmailLabels>('/labels', { signal }),
    ]);
    const names = new Map(labels?.labels?.map((label) => [label.id, label.name]));
    return messages.map((email) => ({
      id: email.id, threadId: email.threadId, from: email.from, subject: email.subject,
      replyTo: email.replyTo, internetId: email.internetId, references: email.references, contextOnly: email.contextOnly, verifiedSender: email.verifiedSender || undefined,
      receivedAt: new Date(email.date).toISOString(), text: email.body, html: email.html,
      attachmentNames: email.attachmentNames, attachments: email.attachmentParts, labels: email.labels.map((id) => names.get(id) ?? id).sort(), sent: email.labels.includes('SENT'),
      loadAttachments: 'loadAttachments' in email ? email.loadAttachments as ReaderMessage['loadAttachments'] : undefined,
      threatSignals: email.threat_signals,
      redactText: this.connection ? (value: string) => this.connection!.accounts.redact(this.connection!.inboxId, value) : undefined,
    }));
  }

  async calendar() {
    this.guard();
    return this.google.list();
  }

  all(kind: ActionKind) {
    return this.local.all(kind);
  }

  private async readSent(providerId: string): Promise<Snapshot> {
    if (providerId.startsWith('gmail:')) {
      const message = await this.request<{ raw: string }>(`/messages/${encodeURIComponent(providerId.slice(6))}?format=raw`);
      return parseWireMime(message.raw, 'SENT');
    }
    const ids = [messageId(providerId), legacyMessageId(providerId)];
    const list = await this.request<GmailList>('/messages?' + new URLSearchParams({ q: `in:sent {${ids.map((id) => 'rfc822msgid:' + id).join(' ')}}` }));
    if (!list.messages?.length) return null;
    if (list.messages.length !== 1) throw new Error('DUPLICATE_PROVIDER_RECEIPTS');
    const message = await this.request<{ raw: string }>(`/messages/${encodeURIComponent(list.messages[0].id)}?format=raw`);
    return parseWireMime(message.raw, 'SENT');
  }

  private async readDraft(providerId: string): Promise<Snapshot> {
    try {
      const draft = await this.request<{ message: { raw: string } }>(
        `/drafts/${encodeURIComponent(providerId)}?format=raw`,
      );
      return parseWireMime(draft.message.raw, 'DRAFT');
    } catch (error) {
      if (error instanceof Error && error.message === 'GMAIL_404') return null;
      throw error;
    }
  }

  async read(action: Pick<SafeAction, 'kind' | 'target'>, providerId?: string | null): Promise<Snapshot> {
    this.guard();
    if (action.kind === 'calendar') return await this.google.get(action.target);
    if (action.kind === 'send') return providerId ? this.readSent(providerId) : null;
    if (action.kind === 'draft') return providerId ? this.readDraft(providerId) : null;
    if (action.kind !== 'mail') return this.local.read(action);
    const [message, catalog] = await Promise.all([
      this.request<{ labelIds?: string[] }>(`/messages/${encodeURIComponent(action.target)}?format=minimal`),
      this.request<GmailLabels>('/labels'),
    ]);
    const names = new Map(catalog.labels?.map((label) => [label.id, label.name]));
    return { labels: (message.labelIds ?? []).map((id) => names.get(id) ?? id).sort() };
  }

  private async changeLabels(target: string, before: Snapshot, after: Snapshot, signal: AbortSignal) {
    const previous = before?.labels as string[] ?? [];
    const next = after?.labels as string[] ?? [];
    const list = await this.request<GmailLabels>('/labels', { signal });
    const names = new Map(list.labels?.map(({ name, id }) => [name, id]));
    const addLabelIds: string[] = [];
    for (const name of next.filter((label) => !previous.includes(label))) {
      let id = names.get(name);
      if (!id) {
        if (!/^(?:(?:SIFTVANE|CLAM)_[A-Z][A-Z0-9_]*|MUTED)$/.test(name)) throw new Error('UNSUPPORTED_LABEL');
        id = (await this.request<{ id: string }>('/labels', { method: 'POST', body: JSON.stringify({ name }), signal })).id;
      }
      addLabelIds.push(id);
    }
    const removeLabelIds = previous.filter((label) => !next.includes(label)).map((name) => names.get(name) ?? name);
    await this.request(`/messages/${encodeURIComponent(target)}/modify`, {
      method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds }), signal,
    });
  }

  async dispatch(action: SafeAction, tier: Tier, before: Snapshot, id: string, signal: AbortSignal) {
    this.guard();
    signal.throwIfAborted();
    if (action.kind === 'calendar') {
      await this.google.write(action.target, before, action.after, signal);
    } else if (action.kind === 'mail') {
      await this.changeLabels(action.target, before, action.after, signal);
    } else if (action.kind === 'send' || action.kind === 'draft') {
      const payload = outboundPayload(action, tier);
      if (this.connection && this.connection.accounts.redact(this.connection.inboxId, payload.subject + '\n' + payload.body) !== payload.subject + '\n' + payload.body) {
        throw new Error('OUTBOUND_CONTENT_BLOCKED');
      }
      const original = this.gmail instanceof GmailLiveAdapter && action.sourceId && !action.sourceId.startsWith('mcp:')
        ? await this.gmail.getMessage(action.sourceId) : null;
      const cleanSubject = (text: string) => text.replace(/^(?:re\s*:\s*)+/i, '').trim().toLowerCase();
      const messageRef = (id: string) => id.length <= 100 && /^<[^<>\s\x00-\x1f]+>$/.test(id);
      const replyTo = original && (
        address(original.from) === payload.to || (original.labels.includes('SENT') && original.to.some((recipient) => address(recipient) === payload.to))
      ) && original.internetId && messageRef(original.internetId) && cleanSubject(original.subject) === cleanSubject(payload.subject) ? original : null;
      const boundary = 'siftvane-' + sha256(id).slice(0, 32);
      const mime = [
        'To: ' + payload.to, 'Subject: ' + mimeSubject(payload.subject),
        'Message-ID: ' + messageId(id), 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="' + boundary + '"',
        ...(replyTo ? ['In-Reply-To: ' + replyTo.internetId,
          'References: ' + [...new Set([...(replyTo.references ?? []).filter(messageRef).slice(-8), replyTo.internetId])].join(' ')] : []),
        ...Object.entries(payload.headers).map(([key, value]) => `${key}: ${value}`),
        '', '--' + boundary, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
        '', Buffer.from(payload.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '',
        '--' + boundary + '--', '',
      ].join('\r\n');
      const message = { raw: Buffer.from(mime).toString('base64url'), ...(replyTo ? { threadId: replyTo.threadId } : {}) };
      if (action.kind === 'draft') {
        return (await this.request<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify({ message }), signal })).id;
      }
      const sent = await this.request<{ id?: string }>('/messages/send', { method: 'POST', body: JSON.stringify(message), signal });
      return this.connection && sent.id ? 'gmail:' + sent.id : id;
    } else {
      return this.local.dispatch(action, tier, before, id, signal);
    }
    return action.target;
  }

  async restore(claim: Claim, signal: AbortSignal) {
    const current = await this.read(claim, claim.providerId);
    if (!matches(current, claim.after)) throw new Error('TARGET_CHANGED_SINCE_RUN');
    if (claim.kind === 'calendar') await this.google.write(claim.target, current, claim.before, signal);
    else if (claim.kind === 'mail') await this.changeLabels(claim.target, current, claim.before, signal);
    else if (claim.kind === 'draft' && claim.providerId) await this.request('/drafts/' + encodeURIComponent(claim.providerId), { method: 'DELETE', signal });
    else if (claim.kind === 'send') throw new Error('SENT_MAIL_CANNOT_BE_RECALLED');
    else await this.local.restore(claim, signal);
  }
}

export function expectedAfter(action: SafeAction, tier: Tier): Snapshot {
  if (action.kind === 'workspace') return verifiedState(action.after);
  if (action.kind === 'handoff') return handoffReceipt(action.after as SignedHandoff);
  if (action.kind === 'send' || action.kind === 'draft') return outboundState(action, tier);
  return action.after;
}
