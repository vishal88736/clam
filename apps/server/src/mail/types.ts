import type { EphemeralEmail } from '@siftvane/shared';

export interface CreateDraftInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

export interface SendMessageInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

export interface MailActionResult {
  ok: boolean;
  provider: 'sandbox' | 'gmail';
  id: string;
  detail: string;
}

export interface MailProvider {
  readonly mode: 'sandbox' | 'gmail';
  listMessages(query?: string, maxResults?: number): Promise<EphemeralEmail[]>;
  getMessage(messageId: string): Promise<EphemeralEmail | null>;
  createDraft(input: CreateDraftInput): Promise<MailActionResult>;
  sendMessage(input: SendMessageInput): Promise<MailActionResult>;
  archiveMessage(messageId: string): Promise<MailActionResult>;
  applyLabel(messageId: string, label: string): Promise<MailActionResult>;
}
