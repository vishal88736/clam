import type { EphemeralEmail, InboxCalendarEvent } from '@siftvane/shared';
import type { ReaderAttachment } from '../inbox/attachments.js';

export interface MailboxAdapter {
  listMessages(query?: string, maxResults?: number): Promise<EphemeralEmail[]>;
  getMessage(id: string): Promise<EphemeralEmail | null>;
  listThreads(query?: string, maxResults?: number): Promise<{ id: string; messages: EphemeralEmail[] }[]>;
  getThread(id: string): Promise<{ id: string; messages: EphemeralEmail[] }>;
  listAttachments(messageId: string): Promise<{ index: number; name: string; mime: string; size: number }[]>;
  getAttachment(messageId: string, index: number): Promise<ReaderAttachment>;
}

export interface CalendarAdapter {
  list(): Promise<InboxCalendarEvent[]>;
  get(id: string): Promise<InboxCalendarEvent | null>;
}
