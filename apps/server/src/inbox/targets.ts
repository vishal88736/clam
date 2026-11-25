import type { InboxCalendarEvent } from '@clam/shared';
import { GoogleCalendar } from '../calendar/google.js';
import type { ReaderMessage } from '../sandbox/seed.js';
import type { GmailMailProvider } from '../mail/gmail.js';
import type { ActionKind, Claim, InboxTarget, Mode, SafeAction, Snapshot, Tier } from './contracts.js';
import { outboundPayload } from './policy.js';
import type { InboxStore } from './store.js';
import { canonicalJson, sha256 } from './trace.js';

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
    disclosure: tier === 1 && action.kind === 'send', status: action.kind === 'draft' ? 'DRAFT' : 'SENT',
  };
};

export class SandboxTarget implements InboxTarget {
  constructor(private readonly store: InboxStore, private readonly guard: () => void, private readonly mode: Mode = 'sandbox') {}

  async read(action: Pick<SafeAction, 'kind' | 'target'>) {
    this.guard();
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
const messageId = (id: string) => `<clam-${id}@agent.clam.local>`;

function parseWireMime(encodedMime: string, status: 'SENT' | 'DRAFT'): Snapshot {
    const raw = Buffer.from(encodedMime, 'base64url').toString('utf8').replace(/\r\n/g, '\n');
    const cut = raw.indexOf('\n\n');
    if (cut < 0) throw new Error('GMAIL_SENT_MIME_UNSUPPORTED');
    const head = raw.slice(0, cut);
    const header = (key: string) => head.match(new RegExp('^' + key + ':\\s*([^\\n]+)', 'im'))?.[1].trim() ?? '';
    const rawSubject = header('Subject');
    const encoded = /^=\?UTF-8\?B\?([^?]+)\?=$/i.exec(rawSubject);
    const text = raw.slice(cut + 2).trim();
    const body = header('Content-Transfer-Encoding').toLowerCase() === 'base64'
      ? Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8').trim() : text;
    return {
      recipient: header('To').toLowerCase(),
      subjectHash: sha256(encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : rawSubject),
      bodyHash: sha256(body), disclosure: header('X-Agent-Automated') === 'true', status,
    };
  }

export class LiveTarget implements InboxTarget {
  private readonly local: SandboxTarget;
  private readonly google: GoogleCalendar;

  constructor(store: InboxStore, private readonly gmail: GmailMailProvider, calendarId: string, private readonly guard: () => void) {
    this.local = new SandboxTarget(store, guard, 'live');
    this.google = new GoogleCalendar(() => this.token(), calendarId, guard);
  }

  private async token() {
    this.guard();
    return this.gmail.getValidAccessToken();
  }

  private async request<T>(suffix: string, init?: RequestInit): Promise<T> {
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

  async readerMessages(): Promise<ReaderMessage[]> {
    this.guard();
    const [messages, labels] = await Promise.all([
      this.gmail.listForInbox('newer_than:14d {in:inbox in:sent}'),
      this.request<GmailLabels>('/labels'),
    ]);
    const names = new Map(labels.labels?.map((label) => [label.id, label.name]));
    return messages.map((email) => ({
      id: email.id, threadId: email.threadId, from: email.from, subject: email.subject,
      replyTo: email.replyTo, verifiedSender: email.verifiedSender || undefined,
      receivedAt: new Date(email.date).toISOString(), text: email.body, html: email.html,
      attachmentNames: email.attachmentNames, attachments: email.attachmentParts, labels: email.labels.map((id) => names.get(id) ?? id).sort(), sent: email.labels.includes('SENT'),
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
    const list = await this.request<GmailList>('/messages?' + new URLSearchParams({ q: `in:sent rfc822msgid:${messageId(providerId)}` }));
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
        if (!/^CLAM_[A-Z_]+$|^MUTED$/.test(name)) throw new Error('UNSUPPORTED_LABEL');
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
      const mime = [
        'To: ' + payload.to, 'Subject: =?UTF-8?B?' + Buffer.from(payload.subject).toString('base64') + '?=',
        'Message-ID: ' + messageId(id), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        ...Object.entries(payload.headers).map(([key, value]) => `${key}: ${value}`),
        '', Buffer.from(payload.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '',
      ].join('\r\n');
      const message = { raw: Buffer.from(mime).toString('base64url') };
      if (action.kind === 'draft') {
        return (await this.request<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify({ message }), signal })).id;
      }
      await this.request('/messages/send', { method: 'POST', body: JSON.stringify(message), signal });
      return id;
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
  if (action.kind === 'send' || action.kind === 'draft') return outboundState(action, tier);
  return action.after;
}
