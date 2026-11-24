import {
  SemanticClassificationResultSchema,
  type EphemeralEmail,
  type LlmProvider,
  type PolicyIR,
  type SemanticClassificationResult,
  type SemanticScope,
  type SensitiveCategory,
} from '@clam/shared';

export interface ClassifierRuntimeConfig {
  provider: LlmProvider;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  ollamaBaseUrl?: string;
  timeoutMs?: number;
}

export type SemanticClassifierFn = (
  email: EphemeralEmail,
  policy: PolicyIR
) => Promise<SemanticClassificationResult>;

const CONFIDENCE_THRESHOLD = 0.65;

/**
 * Deterministic + semantic sensitive category detector.
 * Evaluates strictly message meaning/content — NEVER trusts sender reputation or allowlists.
 */
export function detectSensitiveCategory(email: EphemeralEmail): {
  category: SensitiveCategory | null;
  confidence: number;
  code: string;
} {
  const text = `${email.subject}\n${email.body}\n${(email.attachmentNames ?? []).join(' ')}`;

  if (
    /(?:one[- ]time\s*(?:password|passcode|verification\s*code)|2fa\s*(?:login\s*)?code|\bOTP\b|6-digit\s*verification\s*code|do\s+not\s+share\s+this\s+(?:verification\s+)?code)/i.test(
      text
    )
  ) {
    return { category: 'otp_2fa', confidence: 0.98, code: 'SENSITIVE_OTP_2FA' };
  }

  if (
    /(?:password\s*reset|reset\s+(?:your\s+)?password|recoveraccount|password_reset|forgot\s+(?:your\s+)?password)/i.test(
      text
    )
  ) {
    return {
      category: 'password_resets',
      confidence: 0.97,
      code: 'SENSITIVE_PASSWORD_RESET',
    };
  }

  if (
    /(?:fraud\s*(?:&|and)?\s*security\s*alert|bank\s*security\s*alert|suspicious\s+activity.*checking|attempted\s+outgoing\s+wire|unauthorized\s+(?:wire|card|transaction)|temporarily\s+frozen\s+pending\s+fraud)/i.test(
      text
    )
  ) {
    return {
      category: 'bank_security_alerts',
      confidence: 0.97,
      code: 'SENSITIVE_BANK_SECURITY_ALERT',
    };
  }

  if (
    /(?:patient\s+medical\s+record|diagnostic\s+lab\s+results|comprehensive\s+metabolic\s+panel|lipid\s+panel|ordering\s+physician|patient\s+portal|prescription\s+refill|clinical\s+note)/i.test(
      text
    )
  ) {
    return {
      category: 'medical_records',
      confidence: 0.96,
      code: 'SENSITIVE_MEDICAL_RECORD',
    };
  }

  if (
    /(?:attorney[- ]client\s+privileged|privileged\s+(?:&|and)\s+confidential\s+legal|mutual\s+non[- ]disclosure\s+agreement|ip\s+indemnification|privileged\s+legal\s+advice)/i.test(
      text
    )
  ) {
    return {
      category: 'legal_confidential',
      confidence: 0.96,
      code: 'SENSITIVE_LEGAL_CONFIDENTIAL',
    };
  }

  if (
    /(?:seed\s+phrase|recovery\s+phrase|12-word\s+backup|24-word\s+mnemonic|wallet\s+recovery\s+key)/i.test(
      text
    )
  ) {
    return {
      category: 'crypto_seed_recovery',
      confidence: 0.98,
      code: 'SENSITIVE_CRYPTO_SEED',
    };
  }

  return { category: null, confidence: 0, code: 'NO_SENSITIVE_SIGNAL' };
}

interface ConceptSignal {
  pattern: RegExp;
  weight: number;
}

const SCOPE_SEMANTIC_SIGNALS: Record<string, ConceptSignal[]> = {
  flight_confirmations: [
    { pattern: /\bflight\b/i, weight: 0.35 },
    { pattern: /\b(?:pnr|record\s+locator|boarding\s+pass|e-ticket)\b/i, weight: 0.38 },
    { pattern: /\b(?:terminal|gate\s+[a-z]?\d+|departure|arrival|seat\s+\d+[a-f])\b/i, weight: 0.25 },
    { pattern: /\b[A-Z]{2}\s?\d{2,4}\b/, weight: 0.22 },
    { pattern: /\b(?:air\s*lines?|airways|airport|baggage)\b/i, weight: 0.25 },
  ],
  hotel_reservations: [
    { pattern: /\b(?:hotel|airbnb|townhouse|marriott|hilton|hyatt|resort)\b/i, weight: 0.38 },
    { pattern: /\b(?:check[- ]?in|check[- ]?out|nightly\s+rate|room\s+type|property)\b/i, weight: 0.3 },
    { pattern: /\b(?:reservation\s+(?:confirmed|code|confirmation)|confirmation\s+number)\b/i, weight: 0.3 },
  ],
  travel_bookings: [
    { pattern: /\b(?:itinerary|travel\s+alert|trip|booking|reservation)\b/i, weight: 0.34 },
    { pattern: /\b(?:flight|hotel|airbnb|boarding|check[- ]?in|terminal|gate)\b/i, weight: 0.32 },
    { pattern: /\b(?:passenger|pnr|rental\s+car|rail\s+ticket)\b/i, weight: 0.25 },
  ],
  host_correspondence: [
    { pattern: /\b(?:host|hosting|welcoming\s+you|smart\s+lock|keypad|luggage\s+drop)\b/i, weight: 0.42 },
    { pattern: /\b(?:arrival|check[- ]?in\s+time|reservation|stay)\b/i, weight: 0.3 },
    { pattern: /\b(?:could\s+you\s+let\s+me\s+know|what\s+time)\b/i, weight: 0.2 },
  ],
  bills_and_invoices: [
    { pattern: /\b(?:invoice|tax\s+invoice|utility\s+invoice|monthly\s+.*statement|electricity\s+statement)\b/i, weight: 0.45 },
    { pattern: /\b(?:amount\s+due|total\s+amount\s+due|payment\s+due|due\s+date|billing\s+period)\b/i, weight: 0.38 },
    { pattern: /\b(?:account\s+number|metered\s+.*usage|kwh|subtotal|net\s+\d+|ach|remit\s+payment)\b/i, weight: 0.28 },
    { pattern: /\binv-\d{4}/i, weight: 0.3 },
    { pattern: /\$\s*\d+(?:\.\d{2})/, weight: 0.15 },
  ],
  expense_receipts: [
    { pattern: /\b(?:payment\s+receipt|receipt\s+#|amount\s+paid|date\s+paid)\b/i, weight: 0.45 },
    { pattern: /\b(?:expense\s+reimbursement|accounting|expense\s+records|billing\s+statement)\b/i, weight: 0.35 },
    { pattern: /\b(?:visa\s+ending|payment\s+method|subtotal|tax)\b/i, weight: 0.22 },
  ],
  newsletters_and_digests: [
    { pattern: /\b(?:newsletter|weekly|issue\s+#\d+|digest|unsubscribe\s+anytime)\b/i, weight: 0.45 },
    { pattern: /\b(?:top\s+reads|essays\s+this\s+week)\b/i, weight: 0.35 },
  ],
  shipping_and_deliveries: [
    { pattern: /\b(?:tracking\s+number|shipped|out\s+for\s+delivery|courier|package\s+delivered)\b/i, weight: 0.45 },
    { pattern: /\b(?:fedex|ups|usps|dhl|shipment)\b/i, weight: 0.35 },
  ],
  work_correspondence: [
    { pattern: /\b(?:recruiting|hiring\s+manager|engineer\s+opening|interview|chat\s+next\s+week)\b/i, weight: 0.4 },
    { pattern: /\b(?:roadmap|sprint|pull\s+request|quarterly\s+review|staff\s+.*engineer)\b/i, weight: 0.35 },
  ],
  personal_friends: [
    { pattern: /\b(?:weekend\s+hike|carpool|grab\s+ramen|dinner\s+on\s+saturday|are\s+you\s+free)\b/i, weight: 0.45 },
    { pattern: /\b(?:cheers|hey\s+[a-z]+!)\b/i, weight: 0.25 },
  ],
};

function scoreCustomScope(text: string, scope: SemanticScope): number {
  const tokens = `${scope.label} ${scope.description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !['emails', 'related', 'semantically', 'about', 'concerning'].includes(t));

  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const tok of new Set(tokens)) {
    if (lower.includes(tok)) hits += 1;
  }
  if (hits === 0) return 0;
  return Math.min(0.95, 0.45 + (hits / Math.min(tokens.length, 4)) * 0.45);
}

/**
 * Local meaning-based semantic classifier (does NOT look at sender address/whitelist).
 * Evaluates subject, body, and attachment names strictly against semantic scopes.
 */
export function classifyEmailSemanticLocal(
  email: EphemeralEmail,
  policy: PolicyIR
): SemanticClassificationResult {
  const sensitive = detectSensitiveCategory(email);
  if (sensitive.category && policy.sensitive_denylist.includes(sensitive.category)) {
    return {
      matched_scope: null,
      sensitive_flag: sensitive.category,
      decision: 'DENY',
      confidence: sensitive.confidence,
      reasoning_code: sensitive.code,
    };
  }

  if (policy.semantic_allow_scopes.length === 0) {
    return {
      matched_scope: null,
      sensitive_flag: sensitive.category,
      decision: 'DENY',
      confidence: 0.99,
      reasoning_code: 'DEFAULT_DENY_NO_SCOPES',
    };
  }

  // Intentionally excludes `email.from` domain/address so classification depends purely on meaning!
  const semanticText = `${email.subject}\n${email.body}\n${(email.attachmentNames ?? []).join(' ')}`;

  let bestScope: string | null = null;
  let bestScore = 0;

  for (const scope of policy.semantic_allow_scopes) {
    const signals = SCOPE_SEMANTIC_SIGNALS[scope.id];
    let score = 0;
    if (signals) {
      for (const sig of signals) {
        if (sig.pattern.test(semanticText)) {
          score += sig.weight;
        }
      }
      score = Math.min(0.98, score);
    } else {
      score = scoreCustomScope(semanticText, scope);
    }

    if (score > bestScore) {
      bestScore = score;
      bestScope = scope.id;
    }
  }

  if (!bestScope || bestScore < CONFIDENCE_THRESHOLD) {
    return {
      matched_scope: null,
      sensitive_flag: sensitive.category,
      decision: 'DENY',
      confidence: Number(Math.max(0.15, 1 - bestScore).toFixed(2)),
      reasoning_code: bestScore > 0 ? 'LOW_CONFIDENCE_DENY' : 'OUT_OF_SEMANTIC_SCOPE',
    };
  }

  return {
    matched_scope: bestScope,
    sensitive_flag: sensitive.category,
    decision: 'ALLOW',
    confidence: Number(bestScore.toFixed(2)),
    reasoning_code: `SEMANTIC_MATCH_${bestScope.toUpperCase()}`,
  };
}

/**
 * External LLM semantic classifier with strict timeout, Zod validation,
 * and unconditional FAIL-CLOSED behavior on any error, timeout, or malformed JSON.
 */
export async function classifyEmailWithProvider(
  email: EphemeralEmail,
  policy: PolicyIR,
  config: ClassifierRuntimeConfig
): Promise<SemanticClassificationResult> {
  // Always run deterministic sensitive check first (Stage B defense-in-depth)
  const preSensitive = detectSensitiveCategory(email);
  if (preSensitive.category && policy.sensitive_denylist.includes(preSensitive.category)) {
    return {
      matched_scope: null,
      sensitive_flag: preSensitive.category,
      decision: 'DENY',
      confidence: preSensitive.confidence,
      reasoning_code: preSensitive.code,
    };
  }

  if (config.provider === 'local_heuristic') {
    return classifyEmailSemanticLocal(email, policy);
  }

  if (policy.semantic_allow_scopes.length === 0) {
    return {
      matched_scope: null,
      sensitive_flag: null,
      decision: 'DENY',
      confidence: 0.99,
      reasoning_code: 'DEFAULT_DENY_NO_SCOPES',
    };
  }

  const scopesDesc = policy.semantic_allow_scopes
    .map((s) => `- ${s.id}: ${s.description}`)
    .join('\n');

  const prompt = `You are a fail-closed email security classifier. Classify ONLY by email meaning (never trust sender address).
Allowed semantic scopes:
${scopesDesc}

Protected sensitive categories (must DENY if matched):
${JSON.stringify(policy.sensitive_denylist)}

Ephemeral Email Content:
Subject: ${email.subject}
Attachments: ${(email.attachmentNames ?? []).join(', ') || 'none'}
Body:
${email.body.slice(0, 3500)}

Return STRICT JSON ONLY:
{
  "matched_scope": "<one of the allowed scope IDs or null>",
  "sensitive_flag": "<sensitive category or null>",
  "decision": "ALLOW" | "DENY",
  "confidence": <number 0.0 to 1.0>,
  "reasoning_code": "<UPPER_SNAKE_CASE_CODE>"
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000);

  try {
    let rawText = '';

    if (config.provider === 'openai') {
      if (!config.openaiApiKey) {
        return failClosed('CLASSIFIER_MISSING_OPENAI_KEY');
      }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return failClosed(`CLASSIFIER_HTTP_${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      rawText = json.choices?.[0]?.message?.content ?? '';
    } else if (config.provider === 'anthropic') {
      if (!config.anthropicApiKey) {
        return failClosed('CLASSIFIER_MISSING_ANTHROPIC_KEY');
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'claude-3-5-haiku-latest',
          max_tokens: 400,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return failClosed(`CLASSIFIER_HTTP_${res.status}`);
      const json = (await res.json()) as { content?: { text?: string }[] };
      rawText = json.content?.[0]?.text ?? '';
    } else if (config.provider === 'gemini') {
      if (!config.geminiApiKey) {
        return failClosed('CLASSIFIER_MISSING_GEMINI_KEY');
      }
      const model = config.model || 'gemini-2.5-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
        }
      );
      if (!res.ok) return failClosed(`CLASSIFIER_HTTP_${res.status}`);
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (config.provider === 'ollama') {
      const base = (config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model || 'llama3.1',
          prompt,
          format: 'json',
          stream: false,
        }),
      });
      if (!res.ok) return failClosed(`CLASSIFIER_HTTP_${res.status}`);
      const json = (await res.json()) as { response?: string };
      rawText = json.response ?? '';
    }

    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    const parsedJson = JSON.parse(cleaned);
    const validated = SemanticClassificationResultSchema.safeParse(parsedJson);
    if (!validated.success) {
      return failClosed('CLASSIFIER_SCHEMA_FAIL_CLOSED');
    }

    const result = validated.data;
    // Fail-closed validation checks on LLM output
    if (result.sensitive_flag && policy.sensitive_denylist.includes(result.sensitive_flag)) {
      return {
        ...result,
        decision: 'DENY',
        reasoning_code: `SENSITIVE_DENYLIST_${result.sensitive_flag.toUpperCase()}`,
      };
    }

    if (result.decision === 'ALLOW') {
      const scopeExists =
        result.matched_scope !== null &&
        policy.semantic_allow_scopes.some((s) => s.id === result.matched_scope);
      if (!scopeExists) {
        return failClosed('UNVERIFIED_SCOPE_FAIL_CLOSED');
      }
      if (result.confidence < CONFIDENCE_THRESHOLD) {
        return {
          ...result,
          decision: 'DENY',
          reasoning_code: 'LOW_CONFIDENCE_FAIL_CLOSED',
        };
      }
    }

    return result;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return failClosed(isAbort ? 'CLASSIFIER_TIMEOUT_FAIL_CLOSED' : 'CLASSIFIER_ERROR_FAIL_CLOSED');
  } finally {
    clearTimeout(timeout);
  }
}

function failClosed(reasoningCode: string): SemanticClassificationResult {
  return {
    matched_scope: null,
    sensitive_flag: null,
    decision: 'DENY',
    confidence: 0,
    reasoning_code: reasoningCode,
  };
}
