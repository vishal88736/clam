import {
  scanPromptInjection,
  type EphemeralEmail,
  type PromptInjectionResult,
} from '@clam/shared';

/**
 * Evaluates an ephemeral email strictly in RAM for indirect prompt-injection attacks,
 * hidden HTML/CSS directives, credential exfiltration imperatives, and authority spoofing.
 */
export function detectEmailPromptInjection(email: EphemeralEmail): PromptInjectionResult {
  const combined = [
    email.subject,
    email.body,
    ...(email.attachmentNames ?? []),
  ].join('\n');
  return scanPromptInjection(combined);
}

export function detectOutboundPromptInjection(outbound?: {
  to?: string;
  subject?: string;
  body?: string;
}): PromptInjectionResult {
  if (!outbound) {
    return {
      detected: false,
      risk_score: 0,
      severity: 'none',
      signals: [],
      exfiltration_target_detected: false,
    };
  }
  const combined = [outbound.to ?? '', outbound.subject ?? '', outbound.body ?? ''].join('\n');
  return scanPromptInjection(combined);
}
