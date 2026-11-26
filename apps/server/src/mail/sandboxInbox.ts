import { scanPromptInjection, type EphemeralEmail } from '@clam/shared';
import type { InboxStore } from '../inbox/store.js';
import { address, domain, stripHtml } from '../inbox/reader.js';
import { externalHandoffThreats } from '../handoffs/externalHeaders.js';
import { sandboxClock, type ReaderMessage } from '../sandbox/seed.js';
import type { MailboxAdapter } from './inboxAdapter.js';

export class SandboxInboxAdapter implements MailboxAdapter {
  constructor(private readonly store: InboxStore, private readonly guard: () => void) {}

  private all(): EphemeralEmail[] {
    this.guard();
    return this.store.sqlite.prepare(
      "SELECT body FROM inbox_sandbox_messages WHERE scope IN ('inbox','history') ORDER BY rowid",
    ).all().map((row) => {
      const message = JSON.parse(String(row.body)) as ReaderMessage;
      const flags = scanPromptInjection([message.subject, message.text, message.html ?? ''].join('\n'));
      const mismatch = message.replyTo && address(message.replyTo) !== address(message.from);
      const forged = externalHandoffThreats(Object.keys(message.headers ?? {}));
      const labels = this.store.entity('sandbox', 'mail', message.id)?.labels as string[] | undefined;
      return {
        id: message.id, threadId: message.threadId, from: message.from, to: [], date: message.receivedAt,
        subject: message.subject, body: stripHtml(message.text), html: message.html, snippet: message.text.slice(0, 140),
        labels: labels ?? message.labels, hasAttachments: Boolean(message.attachments?.length),
        attachmentParts: message.attachments, verifiedSender: message.verifiedSender,
        trust_level: 'untrusted_external', quarantined: Boolean(forged.length) || flags.detected || Boolean(mismatch),
        threat_signals: [...forged, ...flags.signals, ...(mismatch ? ['SENDER_REPLY_TO_MISMATCH'] : [])],
      };
    });
  }

  async listMessages(query = '', maxResults = 20) {
    const sender = /^from:@([^ ]+) newer_than:1h\b/.exec(query)?.[1];
    return this.all().filter((message) => sender ? domain(message.from) === sender &&
      Date.parse(message.date) >= Date.parse(sandboxClock) - 3_600_000 :
      (message.from + '\n' + message.subject + '\n' + message.body).toLowerCase().includes(query.toLowerCase())).slice(0, maxResults);
  }

  async getMessage(id: string) { return this.all().find((message) => message.id === id) ?? null; }

  async listThreads(query = '', maxResults = 20) {
    const entries = await this.listMessages(query, 50);
    return Promise.all([...new Set(entries.map((item) => item.threadId))].slice(0, maxResults).map((id) => this.getThread(id)));
  }

  async getThread(id: string) {
    const messages = this.all().filter((message) => message.threadId === id);
    if (!messages.length) throw new Error('THREAD_NOT_AVAILABLE');
    return { id, messages };
  }

  async listAttachments(id: string) {
    return (await this.getMessage(id))?.attachmentParts?.slice(0, 3).map((part, index) => ({
      index, name: part.name, mime: part.mime, size: Buffer.from(part.data, 'base64url').length,
    })) ?? [];
  }

  async getAttachment(id: string, index: number) {
    const part = (await this.getMessage(id))?.attachmentParts?.[index];
    if (!part) throw new Error('ATTACHMENT_NOT_AVAILABLE');
    return part;
  }
}
