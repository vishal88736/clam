import {
  DEFAULT_SENSITIVE_CATEGORIES,
  PolicyIRSchema,
  type AgentAction,
  type CompilerMode,
  type ConditionalAskRule,
  type LlmProvider,
  type PolicyClause,
  type PolicyIR,
  type SemanticScope,
  type SensitiveCategory,
} from '@clam/shared';

interface ScopeTemplate {
  id: string;
  label: string;
  description: string;
  examples: string[];
  patterns: RegExp[];
}

const BUILTIN_SCOPE_CATALOG: ScopeTemplate[] = [
  {
    id: 'flight_confirmations',
    label: 'Flight Confirmations & Boarding',
    description: 'Flight confirmations, airline tickets, PNRs, boarding passes, and gate changes',
    examples: ['Delta DL 402 confirmation', 'IndiGo e-ticket', 'United gate update'],
    patterns: [/\bflights?\b/i, /\bairlines?\b/i, /\bboarding\b/i, /\bairfare\b/i, /\bitinerar/i],
  },
  {
    id: 'hotel_reservations',
    label: 'Hotel & Lodging Reservations',
    description: 'Hotel reservations, Airbnb stays, check-in schedules, and accommodation confirmations',
    examples: ['Airbnb reservation confirmed', 'Marriott hotel booking'],
    patterns: [/\bhotels?\b/i, /\bairbnb\b/i, /\baccommodation/i, /\blodging\b/i, /\bstays?\b/i],
  },
  {
    id: 'travel_bookings',
    label: 'Travel Bookings & Itineraries',
    description: 'Travel reservations, trip itineraries, rental cars, rail tickets, and travel alerts',
    examples: ['Trip itinerary', 'Travel booking confirmation'],
    patterns: [/\btravel\b/i, /\bbookings?\b/i, /\bitinerar/i, /\btrip\b/i, /\breservations?\b/i],
  },
  {
    id: 'host_correspondence',
    label: 'Host Correspondence',
    description: 'Messages and replies with accommodation hosts, check-in questions, and arrival times',
    examples: ['Host arrival time check-in message'],
    patterns: [/\bhosts?\b/i, /\blandlord/i, /\bcheck[- ]?in/i],
  },
  {
    id: 'bills_and_invoices',
    label: 'Bills & Invoices',
    description: 'Utility bills, electricity/water statements, SaaS invoices, billing statements, and amount-due notices',
    examples: ['Monthly electricity statement', 'CloudPulse SaaS Invoice #INV-2026'],
    patterns: [
      /\bbills?\b/i,
      /\binvoices?\b/i,
      /\butility\b/i,
      /\belectric/i,
      /\bstatements?\b/i,
      /\bsubscription\b/i,
      /\bbilling\b/i,
    ],
  },
  {
    id: 'expense_receipts',
    label: 'Expense Receipts & Reimbursements',
    description: 'Payment receipts, reimbursement records, tax invoices, and purchase confirmations',
    examples: ['Stripe payment receipt', 'Expense receipt PDF'],
    patterns: [/\breceipts?\b/i, /\bexpenses?\b/i, /\breimburse/i, /\baccounting\b/i],
  },
  {
    id: 'newsletters_and_digests',
    label: 'Newsletters & Digests',
    description: 'Technical newsletters, weekly engineering digests, and subscribed publications',
    examples: ['Systems Weekly #142'],
    patterns: [/\bnewsletters?\b/i, /\bdigests?\b/i, /\bpublications?\b/i, /\bsubscriptions?\b/i],
  },
  {
    id: 'shipping_and_deliveries',
    label: 'Shipping & Deliveries',
    description: 'Package tracking numbers, courier updates, and delivery confirmations',
    examples: ['Order shipped tracking update'],
    patterns: [/\bshipping\b/i, /\bdeliver(y|ies)\b/i, /\bpackages?\b/i, /\btracking\b/i],
  },
  {
    id: 'work_correspondence',
    label: 'Work & Recruiting Correspondence',
    description: 'Professional outreach, recruiting emails, team discussions, and project updates',
    examples: ['Staff Engineer role outreach', 'Daily work priorities'],
    patterns: [/\bwork\b/i, /\brecruit/i, /\bcolleagues?\b/i, /\bproject/i, /\bpriorit(y|ies)/i],
  },
  {
    id: 'personal_friends',
    label: 'Personal & Friends',
    description: 'Social plans, personal messages from friends and family',
    examples: ['Weekend hike invite'],
    patterns: [/\bpersonal\b/i, /\bfriends?\b/i, /\bfamily\b/i, /\bsocial\b/i],
  },
];

const SENSITIVE_PATTERN_MAP: { category: SensitiveCategory; pattern: RegExp; label: string }[] = [
  {
    category: 'password_resets',
    pattern: /\bpassword\s*resets?\b|\breset\s*links?\b/i,
    label: 'Password Resets',
  },
  {
    category: 'otp_2fa',
    pattern: /\b(?:otps?|2fa|verification\s*codes?|one[- ]time\s*passcodes?)\b/i,
    label: 'OTPs & 2FA Codes',
  },
  {
    category: 'bank_security_alerts',
    pattern: /\bbank(?:ing)?\s*(?:security\s*)?alerts?\b|\bfraud\s*alerts?\b|\bwire\s*alerts?\b/i,
    label: 'Bank Security Alerts',
  },
  {
    category: 'medical_records',
    pattern: /\bmedical\s*records?\b|\blab\s*results?\b|\bhealth\s*records?\b/i,
    label: 'Medical Records',
  },
  {
    category: 'legal_confidential',
    pattern: /\blegal\b|\battorney[- ]client\b|\bnda\b/i,
    label: 'Legal & Privileged',
  },
  {
    category: 'crypto_seed_recovery',
    pattern: /\bseed\s*phrase\b|\bcrypto\s*recovery\b/i,
    label: 'Crypto Seed Recovery',
  },
];

const ACTION_KEYWORDS: { action: AgentAction; regex: RegExp }[] = [
  { action: 'send', regex: /\bsend(?:ing|s)?\b|\bdeliver\b|\bdispatch\b|\btransmit\b/i },
  { action: 'delete', regex: /\bdelet(?:e|ing|es)\b|\btrash\b|\bremove\b|\bpurge\b/i },
  { action: 'draft', regex: /\bdraft(?:ing|s)?\b|\brepl(?:y|ies)\b|\bcompos(?:e|ing)\b/i },
  { action: 'archive', regex: /\barchiv(?:e|ing|es)\b/i },
  { action: 'label', regex: /\blabel(?:ing|s)?\b|\btag(?:ging|s)?\b|\bcategoriz/i },
  {
    action: 'read',
    regex: /\bread(?:ing|s)?\b|\bsummariz|\btriag(?:e|ing)\b|\bbuild\b|\banalyz|\bcheck\b|\bextract\b|\btrack/i,
  },
  { action: 'list', regex: /\blist(?:ing)?\b|\bsearch(?:ing)?\b|\bfind\b|\bscan\b/i },
];

export interface LlmCompilerRuntimeConfig {
  provider: LlmProvider;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  ollamaBaseUrl?: string;
  timeoutMs?: number;
}

export interface CompilePolicyOptions {
  rawRules: string;
  overriddenSensitiveCategories?: SensitiveCategory[];
  llmConfig?: LlmCompilerRuntimeConfig;
}

function splitClauses(rawRules: string): string[] {
  return rawRules
    .split(/(?<=[.!?\n;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function detectActionsInText(text: string): AgentAction[] {
  const matched: AgentAction[] = [];
  for (const item of ACTION_KEYWORDS) {
    if (item.regex.test(text)) {
      matched.push(item.action);
    }
  }
  return matched;
}

function extractCustomScopeFromClause(clauseText: string, clauseId: string): SemanticScope | null {
  const match = clauseText.match(
    /(?:read|allow|access|summarize|check|track|process)\s+([a-z0-9,&\-\s]{3,60}?)(?:\s+(?:emails?|messages?|correspondence|and\s+build|to\s+summarize|for\s+expense)|[.!?]|$)/i
  );
  if (!match?.[1]) return null;
  const topic = match[1]
    .replace(/\b(my|the|any|all|only|emails?|messages?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (topic.length < 3) return null;
  // Don't create custom scope if it is just an action verb or sensitive category
  if (/^(send|draft|archive|label|delete|read|list)$/i.test(topic)) return null;

  const slug =
    'custom_' +
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);

  return {
    id: slug,
    label: topic.replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Emails semantically related to ${topic}`,
    examples: [],
    source_clause_id: clauseId,
  };
}

/**
 * Deterministic plain-English -> PolicyIR compiler.
 * Works completely offline with zero API keys, and serves as the baseline + safety clamp.
 */
export function compilePolicyDeterministic(
  rawRules: string,
  overriddenSensitiveCategories: SensitiveCategory[] = []
): PolicyIR {
  const clauses = splitClauses(rawRules);
  const allowedSet = new Set<AgentAction>();
  const hardDeniedSet = new Set<AgentAction>();
  const askFirstSet = new Set<AgentAction>();
  const conditionalAskRules: ConditionalAskRule[] = [];
  const scopesMap = new Map<string, SemanticScope>();
  const parsedClauses: PolicyClause[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const text = clauses[i];
    const clauseId = `clause_${i + 1}`;
    const lower = text.toLowerCase();

    const isHardProhibition =
      /\b(?:never|do\s+not|don't|cannot|can't|must\s+not|forbid|prohibit|block|disallow)\b/i.test(
        lower
      ) || /\bno\s+(?:sending|deleting|archiving|drafting|reading)\b/i.test(lower);

    const isAskFirst =
      /\b(?:ask\s+me\s+first|ask\s+before|require\s+approval|with\s+(?:my\s+)?approval|for\s+me\s+to\s+review|review\s+before|confirm\s+before|human\s+review|hitl)\b/i.test(
        lower
      );

    // Check explicit sensitive overrides attempted in English
    for (const sens of SENSITIVE_PATTERN_MAP) {
      if (sens.pattern.test(text) && !isHardProhibition) {
        if (/\b(?:allow|read|include|permit)\b/i.test(lower)) {
          if (!overriddenSensitiveCategories.includes(sens.category)) {
            warnings.push(
              `Sensitive protection kept active for "${sens.label}". Confirm explicit sensitive-category override to permit ${sens.category}.`
            );
          }
        }
      }
    }

    if (isHardProhibition) {
      const targetActions = detectActionsInText(text);
      // Handle "never send or delete" or "never send"
      if (targetActions.length === 0 && /\bsend\b/i.test(lower)) targetActions.push('send');
      if (targetActions.length === 0 && /\bdelete\b/i.test(lower)) targetActions.push('delete');

      for (const act of targetActions) {
        hardDeniedSet.add(act);
        allowedSet.delete(act);
        askFirstSet.delete(act);
      }

      parsedClauses.push({
        id: clauseId,
        text,
        effect: 'hard_deny',
        summary: `Hard-deny: ${targetActions.join(', ') || 'prohibited action'}`,
      });
      continue;
    }

    if (isAskFirst) {
      const targetActions = detectActionsInText(text).filter((a) => a !== 'read' && a !== 'list');
      // If sentence says "Ask me first before creating drafts or sending replies"
      const actionsToGate: AgentAction[] =
        targetActions.length > 0 ? targetActions : ['send', 'draft'];

      const hasExternalCond = /\bexternal\s+domain|outside\s+domain|unknown\s+recipient/i.test(
        lower
      );
      const keywordMatch = lower.match(/\bmentioning\s+([a-z0-9_-]+)/i);

      for (const act of actionsToGate) {
        allowedSet.add(act);
        if (!hasExternalCond && !keywordMatch) {
          askFirstSet.add(act);
        } else {
          // Conditional ask rules still allow gated execution and trigger HITL when condition matches
          conditionalAskRules.push({
            id: `cond_${clauseId}_${act}`,
            action: act,
            condition_type: hasExternalCond ? 'external_domain' : 'keyword_match',
            condition_value: keywordMatch?.[1],
            description: text,
            source_clause: text,
          });
        }
      }

      // Also extract scopes if mentioned in same sentence (e.g., "Draft replies to hosts for me to review.")
      for (const template of BUILTIN_SCOPE_CATALOG) {
        if (template.patterns.some((p) => p.test(text))) {
          scopesMap.set(template.id, {
            id: template.id,
            label: template.label,
            description: template.description,
            examples: template.examples,
            source_clause_id: clauseId,
          });
        }
      }

      parsedClauses.push({
        id: clauseId,
        text,
        effect: 'ask_first',
        summary: `Ask-me-first: ${actionsToGate.join(', ')}`,
      });
      continue;
    }

    // Standard allow / scope clause
    const actionsInClause = detectActionsInText(text);
    let matchedAnyBuiltin = false;
    for (const template of BUILTIN_SCOPE_CATALOG) {
      if (template.patterns.some((p) => p.test(text))) {
        matchedAnyBuiltin = true;
        scopesMap.set(template.id, {
          id: template.id,
          label: template.label,
          description: template.description,
          examples: template.examples,
          source_clause_id: clauseId,
        });
      }
    }

    if (!matchedAnyBuiltin && (actionsInClause.includes('read') || actionsInClause.includes('list'))) {
      const custom = extractCustomScopeFromClause(text, clauseId);
      if (custom) {
        scopesMap.set(custom.id, custom);
      }
    }

    // Grant read+list whenever reading/summarizing/triaging/extracting is mentioned
    if (actionsInClause.includes('read') || actionsInClause.includes('list')) {
      allowedSet.add('read');
      allowedSet.add('list');
    }
    for (const act of actionsInClause) {
      if (!hardDeniedSet.has(act)) {
        allowedSet.add(act);
      }
    }

    parsedClauses.push({
      id: clauseId,
      text,
      effect: matchedAnyBuiltin ? 'scope' : 'allow',
      summary: `Permit ${actionsInClause.join(', ') || 'read'}`,
    });
  }

  // Enforce hard denials deterministically over any earlier allow
  for (const denied of hardDeniedSet) {
    allowedSet.delete(denied);
    askFirstSet.delete(denied);
  }

  if (allowedSet.size === 0 && askFirstSet.size === 0) {
    warnings.push('No actions are permitted; default-deny will block all MCP tool calls.');
  }
  if (
    (allowedSet.has('read') || allowedSet.has('list')) &&
    scopesMap.size === 0
  ) {
    warnings.push(
      'No semantic email scopes were recognized. Default-deny will block email reads until a topic/scope is specified.'
    );
  }

  const sensitiveDenylist = DEFAULT_SENSITIVE_CATEGORIES.filter(
    (cat) => !overriddenSensitiveCategories.includes(cat)
  );

  return {
    version: 1,
    compiled_at: new Date().toISOString(),
    compiler_mode: 'deterministic_heuristic',
    raw_rules: rawRules,
    allowed_actions: Array.from(allowedSet),
    hard_denied_actions: Array.from(hardDeniedSet),
    ask_first_actions: Array.from(askFirstSet),
    conditional_ask_rules: conditionalAskRules,
    semantic_allow_scopes: Array.from(scopesMap.values()),
    sensitive_denylist: sensitiveDenylist,
    overridden_sensitive_categories: overriddenSensitiveCategories,
    rule_clauses: parsedClauses,
    warnings,
  };
}

/**
 * Deterministic safety clamp applied on top of any LLM compiler output so
 * explicit English prohibitions like "Never send" can NEVER be bypassed.
 */
function applyDeterministicClamps(ir: PolicyIR, rawRules: string): PolicyIR {
  const baseline = compilePolicyDeterministic(rawRules, ir.overridden_sensitive_categories);
  const hardDenied = new Set<AgentAction>([...ir.hard_denied_actions, ...baseline.hard_denied_actions]);
  const allowed = ir.allowed_actions.filter((a) => !hardDenied.has(a));
  const askFirst = ir.ask_first_actions.filter((a) => !hardDenied.has(a));

  for (const reqAsk of baseline.ask_first_actions) {
    if (!hardDenied.has(reqAsk) && !askFirst.includes(reqAsk)) {
      askFirst.push(reqAsk);
    }
    if (!hardDenied.has(reqAsk) && !allowed.includes(reqAsk)) {
      allowed.push(reqAsk);
    }
  }

  const sensitiveDenylist = DEFAULT_SENSITIVE_CATEGORIES.filter(
    (c) => !ir.overridden_sensitive_categories.includes(c)
  );

  return {
    ...ir,
    raw_rules: rawRules,
    allowed_actions: Array.from(new Set(allowed)),
    hard_denied_actions: Array.from(hardDenied),
    ask_first_actions: Array.from(new Set(askFirst)),
    sensitive_denylist: sensitiveDenylist,
  };
}

async function compileWithLlm(
  rawRules: string,
  overriddenSensitiveCategories: SensitiveCategory[],
  llm: LlmCompilerRuntimeConfig
): Promise<PolicyIR | null> {
  const prompt = `You are a security policy compiler for Clam, an email MCP firewall.
Convert the following plain-English rules into valid PolicyIR JSON (version: 1).
Rules: "${rawRules}"
Overridden sensitive categories confirmed by user: ${JSON.stringify(overriddenSensitiveCategories)}
Return ONLY strict JSON matching keys:
{
  "version": 1,
  "compiled_at": "<ISO>",
  "compiler_mode": "${llm.provider}",
  "raw_rules": <string>,
  "allowed_actions": ("list"|"read"|"draft"|"send"|"archive"|"label"|"delete")[],
  "hard_denied_actions": [...],
  "ask_first_actions": [...],
  "conditional_ask_rules": [{ "id": "...", "action": "...", "condition_type": "always"|"external_domain"|"keyword_match"|"new_recipient", "condition_value": "...", "description": "...", "source_clause": "..." }],
  "semantic_allow_scopes": [{ "id": "snake_case", "label": "...", "description": "...", "examples": [] }],
  "sensitive_denylist": ["password_resets","otp_2fa","bank_security_alerts","medical_records","legal_confidential","crypto_seed_recovery"],
  "overridden_sensitive_categories": ${JSON.stringify(overriddenSensitiveCategories)},
  "rule_clauses": [{ "id": "clause_1", "text": "...", "effect": "allow"|"ask_first"|"hard_deny"|"scope", "summary": "..." }],
  "warnings": []
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llm.timeoutMs ?? 8000);
  try {
    let rawJsonText = '';
    if (llm.provider === 'openai' && llm.openaiApiKey) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${llm.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: llm.model || 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      rawJsonText = data.choices?.[0]?.message?.content ?? '';
    } else if (llm.provider === 'anthropic' && llm.anthropicApiKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': llm.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: llm.model || 'claude-3-5-haiku-latest',
          max_tokens: 1200,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { content?: { text?: string }[] };
      rawJsonText = data.content?.[0]?.text ?? '';
    } else if (llm.provider === 'gemini' && llm.geminiApiKey) {
      const model = llm.model || 'gemini-2.5-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(llm.geminiApiKey)}`,
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
      if (!res.ok) return null;
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (llm.provider === 'ollama') {
      const base = (llm.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llm.model || 'llama3.1',
          prompt,
          format: 'json',
          stream: false,
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      rawJsonText = data.response ?? '';
    } else {
      return null;
    }

    const cleaned = rawJsonText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = PolicyIRSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) return null;

    const mode: CompilerMode =
      (llm.provider as string) === 'local_heuristic' ? 'deterministic_heuristic' : llm.provider;
    return applyDeterministicClamps({ ...parsed.data, compiler_mode: mode }, rawRules);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function compilePolicy(options: CompilePolicyOptions): Promise<PolicyIR> {
  const overridden = options.overriddenSensitiveCategories ?? [];
  if (options.llmConfig && options.llmConfig.provider !== 'local_heuristic') {
    const compiled = await compileWithLlm(options.rawRules, overridden, options.llmConfig);
    if (compiled) return compiled;
  }
  return compilePolicyDeterministic(options.rawRules, overridden);
}
