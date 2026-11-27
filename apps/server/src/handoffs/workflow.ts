import { scanOutboundSecrets, scanPromptInjection } from '@siftvane/shared';
import { readAttachments } from '../inbox/attachments.js';
import type { InboxEngine } from '../inbox/engine.js';
import type { McpCaller } from '../inbox/contracts.js';
import { isPodCaseThread, podCase } from './sample.js';

export async function extractPodAttachment(inbox: InboxEngine, inboxId: string, messageId: string, threadId = podCase.threadId, caller?: McpCaller) {
  inbox.guard();
  const canRead = inboxId === 'triage' || inbox.handoffs.list(inboxId)
    .some((handoff) => handoff.thread_id === threadId && handoff.payload.attachment_ids.includes(podCase.attachmentId));
  if (!canRead || messageId !== podCase.messageId || !isPodCaseThread(threadId)) throw new Error('ATTACHMENT_NOT_AVAILABLE');
  const text = await readAttachments([podCase.attachment]);
  if (scanOutboundSecrets(text) || scanPromptInjection(text).detected) throw new Error('MESSAGE_QUARANTINED');
  return inbox.recordScopedEvent('sandbox', 'mcp.extract_attachment_text', (record) => {
    const stored = inbox.store.sqlite.prepare("INSERT OR IGNORE INTO inbox_capability_events VALUES (?,'sandbox','attachment')")
      .run('pod:' + threadId + ':' + podCase.attachmentId);
    if (inboxId === 'triage' && stored.changes) record({ thread_id: threadId, inbound: {
      sender: podCase.sender, received_at: podCase.receivedAt, trust_level: 'untrusted_external', threat_signals: [],
    } }, 'PLAN');
    record({ thread_id: threadId, action: 'extract_attachment_text', outcome: 'VERIFIED', mime: podCase.attachment.mime });
    return { attachment_id: podCase.attachmentId, filename: podCase.attachment.name, text, trust_level: 'untrusted_external' };
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
