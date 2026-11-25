import type { InjectionSeverity, PromptInjectionResult } from './types.js';

interface InjectionRule {
  code: string;
  pattern: RegExp;
  weight: number;
  exfiltration?: boolean;
}

const INJECTION_RULES: InjectionRule[] = [
  {
    code: 'INJ_INSTRUCTION_OVERRIDE',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|system|earlier)\s+(?:instructions?|directives?|rules?|constraints?|prompts?)\b/i,
    weight: 0.55,
  },
  {
    code: 'INJ_SYSTEM_PROMPT_SPOOF',
    pattern:
      /(?:\[\s*system\s*\]|<\|im_start\|>system|<system_directive>|###\s*SYSTEM\s+OVERRIDE|ADMIN_BYPASS\s*=\s*true|DEVELOPER\s+MODE\s+ENABLED)/i,
    weight: 0.6,
  },
  {
    code: 'INJ_EXFIL_SEND_COMMAND',
    pattern:
      /\b(?:execute|call|invoke|use|run)\s+(?:the\s+)?(?:send_email|delete_email|forward_external)\b|(?:send|forward|email|exfiltrate|transmit)\s+(?:all\s+)?(?:otps?|2fa|verification\s+codes?|bank\s+alerts?|passwords?|tokens?|emails?)\s+(?:to|at)\s+[a-z0-9._%+-]+@[a-z0-9.-]+/i,
    weight: 0.7,
    exfiltration: true,
  },
  {
    code: 'INJ_ATTACKER_EMAIL_TARGET',
    pattern:
      /\b(?:attacker|evil|exfil|leak|dump)@[a-z0-9.-]+\.[a-z]{2,}\b|\bforward\s+(?:the\s+)?(?:otp|verification\s+code|password\s+reset|secret|token)\b/i,
    weight: 0.55,
    exfiltration: true,
  },
  {
    code: 'INJ_DESTRUCTIVE_TOOL_IMPERATIVE',
    pattern:
      /\b(?:delete|purge|erase|wipe)\s+(?:all\s+)?(?:emails?|messages?|inbox|logs?|audit\s+records?)\b/i,
    weight: 0.45,
    exfiltration: true,
  },
  {
    code: 'INJ_HIDDEN_HTML_SMUGGLING',
    pattern:
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em)?|opacity\s*:\s*0(?:\.0+)?|color\s*:\s*(?:#fff(?:fff)?|white))[\s\S]{0,240}(?:ignore|override|send_email|delete_email|forward|otp|wire|system)/i,
    weight: 0.6,
  },
  {
    code: 'INJ_HTML_COMMENT_DIRECTIVE',
    pattern:
      /<!--[\s\S]{0,300}(?:ignore|override|send_email|delete_email|instruction|system|exfiltrate|attacker)[\s\S]{0,300}-->/i,
    weight: 0.55,
  },
  {
    code: 'INJ_CEO_WIRE_COERCION',
    pattern:
      /\b(?:urgent\s+ceo\s+directive|confidential\s+executive\s+wire|wire\s+\$[\d,]+\s+immediately|bypass\s+standard\s+approval)\b/i,
    weight: 0.45,
  },
  {
    code: 'INJ_ZERO_WIDTH_OBFUSCATION',
    pattern: /[\u200B-\u200D\uFEFF]{3,}/,
    weight: 0.35,
  },
];

/**
 * Deterministic + structural indirect prompt-injection detector executed strictly in RAM.
 * Emits only symbolic signal codes and a bounded risk score (0.0 - 1.0) — never raw email content.
 */
export function scanPromptInjection(text: string): PromptInjectionResult {
  if (!text || text.trim().length === 0) {
    return {
      detected: false,
      risk_score: 0,
      severity: 'none',
      signals: [],
      exfiltration_target_detected: false,
    };
  }

  let score = 0;
  const signals: string[] = [];
  let exfiltration = false;

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text)) {
      signals.push(rule.code);
      score += rule.weight;
      if (rule.exfiltration) exfiltration = true;
    }
  }

  const clamped = Number(Math.min(1, score).toFixed(2));
  let severity: InjectionSeverity = 'none';
  if (clamped >= 0.8 || (clamped >= 0.65 && exfiltration)) severity = 'critical';
  else if (clamped >= 0.55) severity = 'high';
  else if (clamped >= 0.25) severity = 'low';

  return {
    detected: clamped >= 0.55,
    risk_score: clamped,
    severity,
    signals,
    exfiltration_target_detected: exfiltration,
  };
}
