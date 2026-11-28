import type {
  AgentAction,
  McpToolName,
  PolicyClause,
  PolicyIR,
} from './types.js';

export function mapToolToAction(tool: McpToolName | string): AgentAction | null {
  switch (tool) {
    case 'list_emails':
    case 'search_emails':
      return 'list';
    case 'read_email':
      return 'read';
    case 'create_draft':
      return 'draft';
    case 'send_email':
      return 'send';
    case 'archive_email':
      return 'archive';
    case 'apply_label':
      return 'label';
    case 'delete_email':
      return 'delete';
    case 'save_itinerary_artifact':
      return 'write_artifact';
    default:
      return null;
  }
}

export interface DeterministicGateResult {
  allowed: boolean;
  reasonCode: string;
  matchedRuleId: string | null;
  ruleCitation: string;
  requiresAskFirst: boolean;
}

function findClauseForEffect(
  clauses: PolicyClause[],
  effects: PolicyClause['effect'][],
  action: AgentAction
): PolicyClause | undefined {
  const actionSynonyms: Record<AgentAction, string[]> = {
    list: ['list', 'search', 'read', 'browse', 'scan', 'view', 'fetch'],
    read: ['read', 'view', 'open', 'check', 'analyze', 'build', 'inspect', 'triage'],
    draft: ['draft', 'reply', 'compose', 'prepare'],
    send: ['send', 'deliver', 'dispatch', 'email out', 'transmit'],
    archive: ['archive', 'dismiss'],
    label: ['label', 'tag', 'categorize', 'organize'],
    delete: ['delete', 'trash', 'remove', 'erase', 'purge'],
    write_artifact: ['itinerary', 'digest', 'artifact', 'ics', 'calendar', 'save'],
  };
  const words = actionSynonyms[action] ?? [action];
  return (
    clauses.find(
      (c) =>
        effects.includes(c.effect) &&
        words.some((w) => c.text.toLowerCase().includes(w))
    ) ?? clauses.find((c) => effects.includes(c.effect))
  );
}

/**
 * Stage A deterministic gate: runs sub-millisecond checks in pure TypeScript.
 * Hard prohibitions and default-deny are ALWAYS enforced here, never delegated to LLMs.
 */
export function evaluateDeterministicGate(params: {
  agentStatus: 'active' | 'paused';
  rateLimited: boolean;
  policy: PolicyIR;
  tool: McpToolName | string;
  outboundText?: string;
}): DeterministicGateResult {
  const { agentStatus, rateLimited, policy, tool, outboundText } = params;

  if (agentStatus !== 'active') {
    return {
      allowed: false,
      reasonCode: 'AGENT_PAUSED',
      matchedRuleId: null,
      ruleCitation: 'Agent status is PAUSED; all MCP access is deterministically denied.',
      requiresAskFirst: false,
    };
  }

  if (rateLimited) {
    return {
      allowed: false,
      reasonCode: 'RATE_LIMIT_EXCEEDED',
      matchedRuleId: null,
      ruleCitation: 'Agent exceeded configured per-minute request rate limit.',
      requiresAskFirst: false,
    };
  }

  const action = mapToolToAction(tool);
  if (!action) {
    return {
      allowed: false,
      reasonCode: 'UNKNOWN_TOOL_DENIED',
      matchedRuleId: null,
      ruleCitation: `Default-deny: tool "${tool}" is not mapped to an authorized action.`,
      requiresAskFirst: false,
    };
  }

  // Hard prohibitions win above all else
  if (policy.hard_denied_actions.includes(action)) {
    const clause = findClauseForEffect(policy.rule_clauses, ['hard_deny'], action);
    return {
      allowed: false,
      reasonCode: `HARD_DENIED_${action.toUpperCase()}`,
      matchedRuleId: clause?.id ?? `hard_deny_${action}`,
      ruleCitation: clause?.text ?? `Hard prohibition blocks "${action}" deterministically.`,
      requiresAskFirst: false,
    };
  }

  // No-credentials / no-OTP deterministic outbound & artifact guard
  if ((action === 'send' || action === 'draft' || action === 'write_artifact') && outboundText) {
    const leak = scanOutboundSecrets(outboundText);
    if (leak) {
      return {
        allowed: false,
        reasonCode: 'NO_CREDENTIALS_OR_OTP',
        matchedRuleId: 'deterministic_no_credentials_or_otp',
        ruleCitation: `Deterministic hard gate NO_CREDENTIALS_OR_OTP blocked outbound ${leak}.`,
        requiresAskFirst: false,
      };
    }
  }

  // Default-deny: action must be explicitly permitted (or explicitly ask_first)
  const isAllowed = policy.allowed_actions.includes(action);
  const isAskFirst = policy.ask_first_actions.includes(action);

  if (!isAllowed && !isAskFirst) {
    return {
      allowed: false,
      reasonCode: `DEFAULT_DENY_${action.toUpperCase()}`,
      matchedRuleId: null,
      ruleCitation: `Default-deny: no rule permits action "${action}".`,
      requiresAskFirst: false,
    };
  }

  // Note: for 'list', the agent also needs 'read' capability or explicit 'list'
  if (action === 'list' && policy.hard_denied_actions.includes('read')) {
    const clause = findClauseForEffect(policy.rule_clauses, ['hard_deny'], 'read');
    return {
      allowed: false,
      reasonCode: 'HARD_DENIED_READ',
      matchedRuleId: clause?.id ?? 'hard_deny_read',
      ruleCitation: clause?.text ?? 'Hard prohibition blocks reading emails.',
      requiresAskFirst: false,
    };
  }

  const allowClause = findClauseForEffect(
    policy.rule_clauses,
    ['allow', 'ask_first', 'scope'],
    action
  );

  return {
    allowed: true,
    reasonCode: 'STAGE_A_PASSED',
    matchedRuleId: allowClause?.id ?? `allow_${action}`,
    ruleCitation: allowClause?.text ?? `Permitted action "${action}".`,
    requiresAskFirst: isAskFirst,
  };
}

/**
 * Deterministic outbound secret/credential/OTP leak scanner.
 * Blocks recognizable credentials and authentication material in outgoing content.
 */
export function scanOutboundSecrets(text: string): string | null {
  if (/\b(?:siftvane|clm)_(?:ag|inbox|pod)_[A-Za-z0-9_-]{12,}/.test(text)) {
    return 'Siftvane bearer token';
  }
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) {
    return 'AWS access key identifier';
  }
  if (/\b(?:AIza[A-Za-z0-9_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}|gsk_[A-Za-z0-9]{25,})\b/.test(text)) {
    return 'provider credential';
  }
  if (/(?:^|[\r\n])\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD)\s*=\s*['"]?[^\s'"#]{6,}/m.test(text)) {
    return 'environment credential assignment';
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    return 'private cryptographic key';
  }
  if (
    /(?:one-time\s*(?:password|passcode|code)|otp|2fa\s*(?:login\s*)?code|verification\s*code)\s*(?:is|:|#)?\s*\d{4,8}/i.test(
      text
    )
  ) {
    return 'OTP / 2FA code';
  }
  if (
    /(?:password\s*reset|reset\s*token|magic\s*link)\s*[:=]?\s*https?:\/\/|https?:\/\/[^\s]*(?:RecoverAccount\?token=|password_reset\/)/i.test(
      text
    )
  ) {
    return 'password reset link';
  }
  return null;
}

export function extractDomain(emailAddress: string): string | null {
  const match = emailAddress.match(/<[^>]*@([^>\s]+)>|@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return (match?.[1] ?? match?.[2] ?? null)?.toLowerCase() ?? null;
}
