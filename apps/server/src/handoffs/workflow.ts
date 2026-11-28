import { scanOutboundSecrets, scanPromptInjection } from '@siftvane/shared';
import { readAttachments } from '../inbox/attachments.js';
import type { InboxEngine } from '../inbox/engine.js';
import type { McpCaller } from '../inbox/contracts.js';
import { caseAttachmentId, caseForThread, podCase } from './cases.js';

/**
 * Reads a case email's attachment for an agent in the Pod: the inbox the email was addressed to, or an inbox that was
 * handed that attachment in the same thread. The text is screened before it is returned.
 */
export async function extractPodAttachment(inbox: InboxEngine, inboxId: string, messageId: string, threadId?: string, caller?: McpCaller) {
  inbox.guard();
  const message = podCase(inbox.store, messageId);
  const thread = threadId ?? message?.threadId ?? '';
  const attachment = message?.attachments?.[0];
  if (!message || !attachment || caseForThread(inbox.store, thread)?.id !== message.id) throw new Error('ATTACHMENT_NOT_AVAILABLE');
  const attachmentId = caseAttachmentId(message, 0);
  const canRead = inboxId === message.toInbox || inbox.handoffs.list(inboxId)
    .some((handoff) => handoff.thread_id === thread && handoff.payload.attachment_ids.includes(attachmentId));
  if (!canRead) throw new Error('ATTACHMENT_NOT_AVAILABLE');
  const text = await readAttachments([attachment]);
  if (scanOutboundSecrets(text) || scanPromptInjection(text).detected) throw new Error('MESSAGE_QUARANTINED');
  return inbox.recordScopedEvent('sandbox', 'mcp.extract_attachment_text', (record) => {
    const stored = inbox.store.sqlite.prepare("INSERT OR IGNORE INTO inbox_capability_events VALUES (?,'sandbox','attachment')")
      .run('pod:' + thread + ':' + attachmentId);
    if (inboxId === message.toInbox && stored.changes) record({ thread_id: thread, inbound: {
      sender: message.from, received_at: message.receivedAt, trust_level: 'untrusted_external', threat_signals: [],
    } }, 'PLAN');
    record({ thread_id: thread, action: 'extract_attachment_text', outcome: 'VERIFIED', mime: attachment.mime });
    return { attachment_id: attachmentId, filename: attachment.name, text, trust_level: 'untrusted_external', attachment };
  }, caller);
}

export function completeHandoff(inbox: InboxEngine, inboxId: string, handoffId: string, caller?: McpCaller) {
  return inbox.recordScopedEvent('sandbox', 'mcp.complete_agent_handoff', (record) => {
    const item = inbox.handoffs.delivery(handoffId);
    if (!item || item.to_inbox_id !== inboxId || !inbox.handoffs.complete(inboxId, handoffId)) throw new Error('HANDOFF_NOT_AVAILABLE');
    const step = record({ thread_id: item.thread_id, action: 'complete_agent_handoff', handoff_id: handoffId, outcome: 'COMPLETED' });
    return { handoff_id: handoffId, trace_step_id: step, status: 'COMPLETED' };
  }, caller);
}
