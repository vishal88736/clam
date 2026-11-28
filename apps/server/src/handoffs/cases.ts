import type { InboxStore } from '../inbox/store.js';
import type { ReaderMessage } from '../sandbox/seed.js';

/** An email delivered to one agent inbox in a Pod. The inbox it was addressed to owns the work and may hand it off. */
export type PodCase = ReaderMessage & { toInbox: string; attachmentIds?: string[] };

export const caseAttachmentId = (message: PodCase, index: number) => message.attachmentIds?.[index] ?? `${message.id}-attachment-${index}`;

/** Every case email in the Pod (stored as sandbox mail, like any other message), optionally for one agent inbox. */
export function podCases(store: InboxStore, inboxId?: string): PodCase[] {
  return (store.sqlite.prepare("SELECT body FROM inbox_sandbox_messages WHERE scope='pod' ORDER BY rowid").all() as Array<{ body: string }>)
    .map((row) => JSON.parse(row.body) as PodCase).filter((message) => !inboxId || message.toInbox === inboxId);
}

export const podCase = (store: InboxStore, messageId: string) => podCases(store).find((message) => message.id === messageId);

/** The case a handoff thread is about: the case's own thread, or a fresh run of it (`<thread>-<8 hex>`). */
export function caseForThread(store: InboxStore, threadId: string) {
  return podCases(store).find((message) => threadId === message.threadId || new RegExp('^' + message.threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-f0-9]{8}$').test(threadId));
}
