import { scanOutboundSecrets, scanPromptInjection, type InboxPolicy } from '@siftvane/shared';
import type { PolicyVerdict, ProposedAction, SafeAction, Tier } from './contracts.js';
import { address } from './reader.js';
import { evaluateWorkspaceAction } from '../workspace/policy.js';

function verdict(decision: PolicyVerdict['decision'], tier: Tier, ruleId: string, reason: string): PolicyVerdict {
  return { decision, tier, ruleId, reason };
}

export function evaluateAction(action: ProposedAction, policy: InboxPolicy): PolicyVerdict {
  return evaluateSafeAction(safeAction(action), policy, action.intent.taintedTargets);
}

export function safeAction(action: ProposedAction): SafeAction {
  const { intent, ...rest } = action;
  const effectiveContact = address(action.contact ?? '');
  return { ...rest, sourceId: intent.messageId, threadId: intent.threadId, confidence: intent.confidence, effectiveContact,
    bodyOnlyRecipient: intent.taintedTargets.includes(effectiveContact) };
}

export function evaluateSafeAction(action: SafeAction, policy: InboxPolicy, tainted: string[] = []): PolicyVerdict {
  const trusted = new Set([...policy.contacts, ...policy.allowlist].map((item) => item.toLowerCase()));
  const allowed = new Set(policy.allowlist.map((item) => item.toLowerCase()));
  const vip = new Set(policy.vips.map((item) => item.toLowerCase()));
  const target = action.effectiveContact ?? '';
  if (action.sensitiveTarget && !trusted.has(action.sensitiveTarget.toLowerCase())) {
    return verdict('BLOCKED', 2, 'TAINT_DESTINATION', 'Destination was supplied by untrusted content.');
  }
  if (action.kind === 'workspace') return evaluateWorkspaceAction(action);
  if (action.kind === 'send' || action.kind === 'draft') {
    if (policy.blocklist.some((item) => item.toLowerCase() === target)) {
      return verdict('BLOCKED', 2, 'RECIPIENT_BLOCKLISTED', 'This recipient is blocked by the active policy.');
    }
    if (target.endsWith('@siftvane.local') || target.endsWith('@clam.local')) {
      return verdict('BLOCKED', 2, 'HANDOFF_TOOL_REQUIRED', 'Internal agent messages must use the signed handoff tool.');
    }
    if (!target || address(target) !== target || ((tainted.includes(target) || action.bodyOnlyRecipient) && !trusted.has(target))) {
      return verdict('BLOCKED', 2, 'TAINT_RECIPIENT', 'Recipient lacks trusted provenance.');
    }
    const text = `${action.after?.subject ?? ''}\n${action.after?.text ?? ''}`;
    if (scanOutboundSecrets(text) || scanPromptInjection(text).detected) {
      return verdict('BLOCKED', 2, 'OUTBOUND_CONTENT_BLOCKED', 'Outbound content contains a secret or rejected instruction.');
    }
    if (action.requestedTier === 2 && action.reason === 'FINANCIAL_COMMITMENT_APPROVAL') {
      return verdict('APPROVAL_REQUIRED', 2, 'FINANCIAL_COMMITMENT_APPROVAL', 'Bookings, purchases, and payment confirmations always require operator approval.');
    }
    if (action.kind === 'send' && (!allowed.has(target) || vip.has(target))) {
      return verdict('APPROVAL_REQUIRED', 2, vip.has(target) ? 'VIP_RECIPIENT' : 'RECIPIENT_NOT_ALLOWLISTED', 'This recipient requires explicit review.');
    }
  }
  if (action.kind === 'handoff') {
    if (action.after?.pod_id !== 'sandbox-pod' || action.after?.from_inbox_id === action.after?.to_inbox_id) {
      return verdict('BLOCKED', 2, 'HANDOFF_INBOX_NOT_AUTHORIZED', 'The agent inboxes are outside the permitted Pod.');
    }
    return verdict('AUTONOMOUS', 1, 'SIGNED_POD_HANDOFF', 'Verified Pod membership permits a bounded internal handoff.');
  }
  if (action.confidence < policy.confidenceThreshold && action.reason !== 'quarantine') {
    return verdict('APPROVAL_REQUIRED', 2, 'LOW_CONFIDENCE', 'Extraction confidence is below the active policy threshold.');
  }
  if (action.externalGuests) {
    return verdict('APPROVAL_REQUIRED', 2, 'EXTERNAL_CALENDAR_GUESTS', 'Changing an event with external attendees requires approval.');
  }
  if (action.requestedTier === 2 || action.kind === 'review') {
    return verdict('APPROVAL_REQUIRED', 2, action.reason ?? 'OPERATOR_REVIEW', 'This action requires operator review.');
  }
  const tier = action.kind === 'send' ? 1 : action.requestedTier;
  return verdict('AUTONOMOUS', tier, tier === 1 ? 'ALLOWLISTED_BOUNDED_ACTION' : 'REVERSIBLE_ACTION', 'Action meets the active policy.');
}

const footer = 'This email was sent automatically by Siftvane on behalf of the account owner.';
export function outboundPayload(action: SafeAction, _tier: Tier) {
  const to = action.effectiveContact ?? '';
  const subject = String(action.after?.subject ?? '').trim();
  const body = String(action.after?.text ?? '').trim();
  if (!to || to !== address(to) || !subject || /[\r\n\0]/.test(subject) || subject.length > 180 || !body || body.length > 2000) {
    throw new Error('INVALID_OUTBOUND_PAYLOAD');
  }
  return {
    to, subject,
    body: `${body}\n\n${footer}`,
    headers: { 'X-Agent-Automated': 'true' },
  };
}
