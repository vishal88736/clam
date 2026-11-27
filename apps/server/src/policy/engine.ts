import {
  evaluateDeterministicGate,
  extractDomain,
  mapToolToAction,
  type AgentRecord,
  type EphemeralEmail,
  type McpToolName,
  type PolicyEvaluationTrace,
  type PolicyIR,
  type SemanticClassificationResult,
} from '@siftvane/shared';
import {
  classifyEmailWithProvider,
  type ClassifierRuntimeConfig,
  type SemanticClassifierFn,
} from './classifier.js';
import { detectEmailPromptInjection, detectOutboundPromptInjection } from './injection.js';

export interface EvaluatePolicyInput {
  agent: Pick<AgentRecord, 'id' | 'name' | 'status' | 'rate_limit_per_min' | 'policy_ir'>;
  tool: McpToolName;
  email?: EphemeralEmail | null;
  outbound?: {
    to?: string;
    subject?: string;
    body?: string;
  };
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();

  isLimited(agentId: string, maxPerMin: number): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.hits.get(agentId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= maxPerMin) {
      this.hits.set(agentId, recent);
      return true;
    }
    recent.push(now);
    this.hits.set(agentId, recent);
    return false;
  }
}

export class PolicyEngine {
  private readonly rateLimiter = new SlidingWindowRateLimiter();

  constructor(
    private getClassifierConfig: () => Promise<ClassifierRuntimeConfig> | ClassifierRuntimeConfig,
    private customClassifier?: SemanticClassifierFn
  ) {}

  setCustomClassifier(fn?: SemanticClassifierFn): void {
    this.customClassifier = fn;
  }

  private async runSemanticClassifier(
    email: EphemeralEmail,
    policy: PolicyIR
  ): Promise<SemanticClassificationResult> {
    if (this.customClassifier) {
      try {
        const res = await this.customClassifier(email, policy);
        // Always fail closed if custom classifier returns invalid or low confidence
        if (!res || typeof res.confidence !== 'number' || (res.decision === 'ALLOW' && res.confidence < 0.65)) {
          return {
            matched_scope: null,
            sensitive_flag: res?.sensitive_flag ?? null,
            decision: 'DENY',
            confidence: res?.confidence ?? 0,
            reasoning_code: 'CLASSIFIER_FAIL_CLOSED',
          };
        }
        return res;
      } catch {
        return {
          matched_scope: null,
          sensitive_flag: null,
          decision: 'DENY',
          confidence: 0,
          reasoning_code: 'CLASSIFIER_EXCEPTION_FAIL_CLOSED',
        };
      }
    }
    const cfg = await this.getClassifierConfig();
    return classifyEmailWithProvider(email, policy, cfg);
  }

  private evaluateConditionalAskFirst(
    policy: PolicyIR,
    tool: McpToolName,
    outbound?: { to?: string; subject?: string; body?: string },
    contextEmail?: EphemeralEmail | null
  ): { triggered: boolean; ruleId: string | null; citation: string } {
    const action = mapToolToAction(tool);
    if (!action) return { triggered: false, ruleId: null, citation: '' };

    if (policy.ask_first_actions.includes(action)) {
      const clause =
        policy.rule_clauses.find((c) => c.effect === 'ask_first') ??
        policy.rule_clauses.find((c) => c.text.toLowerCase().includes(action));
      return {
        triggered: true,
        ruleId: clause?.id ?? `ask_first_${action}`,
        citation: clause?.text ?? `Ask-me-first rule requires human approval for "${action}".`,
      };
    }

    for (const rule of policy.conditional_ask_rules) {
      if (rule.action !== action) continue;
      if (rule.condition_type === 'always') {
        return { triggered: true, ruleId: rule.id, citation: rule.source_clause };
      }
      if (rule.condition_type === 'external_domain' && outbound?.to) {
        const targetDomain = extractDomain(outbound.to);
        const contextDomain = contextEmail ? extractDomain(contextEmail.from) : null;
        if (targetDomain && targetDomain !== contextDomain) {
          return { triggered: true, ruleId: rule.id, citation: rule.source_clause };
        }
      }
      if (rule.condition_type === 'keyword_match' && rule.condition_value) {
        const combined = `${outbound?.subject ?? ''} ${outbound?.body ?? ''}`.toLowerCase();
        if (combined.includes(rule.condition_value.toLowerCase())) {
          return { triggered: true, ruleId: rule.id, citation: rule.source_clause };
        }
      }
    }

    return { triggered: false, ruleId: null, citation: '' };
  }

  /**
   * Evaluates Stage A (Deterministic Gate) -> Stage B (Fail-Closed Semantic Classifier) -> Stage C (HITL Gate).
   */
  async evaluate(
    input: EvaluatePolicyInput,
    options?: { skipRateLimit?: boolean }
  ): Promise<PolicyEvaluationTrace> {
    const start = performance.now();
    const policy = input.agent.policy_ir;
    const outboundCombined = input.outbound
      ? `${input.outbound.to ?? ''}\n${input.outbound.subject ?? ''}\n${input.outbound.body ?? ''}`
      : undefined;

    const emailInjection = input.email ? detectEmailPromptInjection(input.email) : null;
    const outboundInjection = input.outbound
      ? detectOutboundPromptInjection(input.outbound)
      : null;
    const baseInjectionScore = Math.max(
      emailInjection?.risk_score ?? 0,
      outboundInjection?.risk_score ?? 0
    );
    const baseInjectionSignals = Array.from(
      new Set([...(emailInjection?.signals ?? []), ...(outboundInjection?.signals ?? [])])
    );

    // Stage A — Deterministic Hard Gate
    const rateLimited = options?.skipRateLimit
      ? false
      : this.rateLimiter.isLimited(input.agent.id, input.agent.rate_limit_per_min);

    const stageA = evaluateDeterministicGate({
      agentStatus: input.agent.status,
      rateLimited,
      policy,
      tool: input.tool,
      outboundText: outboundCombined,
    });

    if (!stageA.allowed) {
      return {
        decision: 'DENY',
        stage: 'STAGE_A_DETERMINISTIC',
        matched_rule_id: stageA.matchedRuleId,
        rule_citation: stageA.ruleCitation,
        semantic_category: null,
        sensitive_flag: null,
        confidence: 1,
        injection_risk_score: baseInjectionScore,
        injection_signals: baseInjectionSignals,
        reasoning_code: stageA.reasonCode,
        latency_ms: Math.max(1, Math.round(performance.now() - start)),
        stage_details: {
          stage_a_passed: false,
          stage_a_reason: stageA.ruleCitation,
          stage_b_executed: false,
          stage_b_reason: null,
          stage_c_triggered: false,
          stage_c_reason: null,
        },
      };
    }

    // Outbound prompt-injection deterministic block (prevents hijacked drafts/artifacts)
    if (outboundInjection?.detected) {
      return {
        decision: 'DENY',
        stage: 'STAGE_A_DETERMINISTIC',
        matched_rule_id: 'deterministic_prompt_injection_shield',
        rule_citation: `Outbound payload blocked by Prompt-Injection Shield (${outboundInjection.signals.join(', ')}).`,
        semantic_category: 'prompt_injection',
        sensitive_flag: null,
        confidence: outboundInjection.risk_score,
        injection_risk_score: outboundInjection.risk_score,
        injection_signals: outboundInjection.signals,
        reasoning_code: 'PROMPT_INJECTION_BLOCKED',
        latency_ms: Math.max(1, Math.round(performance.now() - start)),
        stage_details: {
          stage_a_passed: false,
          stage_a_reason: `Outbound prompt-injection signals: ${outboundInjection.signals.join(', ')}`,
          stage_b_executed: false,
          stage_b_reason: null,
          stage_c_triggered: false,
          stage_c_reason: null,
        },
      };
    }

    // Stage B — Semantic Meaning & Indirect Injection Evaluation
    let matchedScope: string | null = null;
    let semanticConfidence = 1;
    let stageBReason = 'No email payload context required for Stage B.';
    let stageBExecuted = false;

    if (input.email) {
      stageBExecuted = true;

      if (emailInjection?.detected) {
        return {
          decision: 'DENY',
          stage: 'STAGE_B_SEMANTIC',
          matched_rule_id: 'deterministic_prompt_injection_shield',
          rule_citation: `Indirect prompt injection blocked in RAM (${emailInjection.signals.join(', ')}).`,
          semantic_category: 'prompt_injection',
          sensitive_flag: null,
          confidence: emailInjection.risk_score,
          injection_risk_score: emailInjection.risk_score,
          injection_signals: emailInjection.signals,
          reasoning_code: 'PROMPT_INJECTION_BLOCKED',
          latency_ms: Math.max(1, Math.round(performance.now() - start)),
          stage_details: {
            stage_a_passed: true,
            stage_a_reason: stageA.ruleCitation,
            stage_b_executed: true,
            stage_b_reason: `Indirect prompt injection detected (score=${emailInjection.risk_score}, signals=${emailInjection.signals.join(', ')}).`,
            stage_c_triggered: false,
            stage_c_reason: null,
          },
        };
      }

      const sem = await this.runSemanticClassifier(input.email, policy);
      semanticConfidence = sem.confidence;

      if (sem.decision !== 'ALLOW') {
        const sensitiveRule = sem.sensitive_flag
          ? `Protected sensitive category "${sem.sensitive_flag}" blocked.`
          : `Email outside allowed semantic scopes (${sem.reasoning_code}).`;
        return {
          decision: 'DENY',
          stage: 'STAGE_B_SEMANTIC',
          matched_rule_id: sem.sensitive_flag ? `sensitive_${sem.sensitive_flag}` : null,
          rule_citation: sensitiveRule,
          semantic_category: sem.sensitive_flag ?? sem.matched_scope,
          sensitive_flag: sem.sensitive_flag,
          confidence: sem.confidence,
          injection_risk_score: baseInjectionScore,
          injection_signals: baseInjectionSignals,
          reasoning_code: sem.reasoning_code,
          latency_ms: Math.max(1, Math.round(performance.now() - start)),
          stage_details: {
            stage_a_passed: true,
            stage_a_reason: stageA.ruleCitation,
            stage_b_executed: true,
            stage_b_reason: sensitiveRule,
            stage_c_triggered: false,
            stage_c_reason: null,
          },
        };
      }

      matchedScope = sem.matched_scope;
      const matchedScopeObj = policy.semantic_allow_scopes.find((s) => s.id === matchedScope);
      stageBReason = `Matched semantic scope "${matchedScopeObj?.label ?? matchedScope}" (${Math.round(sem.confidence * 100)}% confidence).`;
    } else if (
      (input.tool === 'create_draft' || input.tool === 'send_email') &&
      input.outbound
    ) {
      // Evaluate outbound draft/send text semantically as a synthetic ephemeral email
      // to ensure sensitive content or out-of-scope topics aren't smuggled if scopes exist.
      stageBExecuted = true;
      const syntheticEmail: EphemeralEmail = {
        id: 'outbound_eval',
        threadId: 'outbound_eval',
        from: 'self@siftvane.local',
        to: input.outbound.to ? [input.outbound.to] : [],
        subject: input.outbound.subject ?? '',
        date: new Date().toISOString(),
        snippet: (input.outbound.body ?? '').slice(0, 120),
        body: input.outbound.body ?? '',
        labels: [],
        hasAttachments: false,
      };
      const sem = await this.runSemanticClassifier(syntheticEmail, policy);
      semanticConfidence = sem.confidence;
      if (sem.sensitive_flag && policy.sensitive_denylist.includes(sem.sensitive_flag)) {
        return {
          decision: 'DENY',
          stage: 'STAGE_B_SEMANTIC',
          matched_rule_id: `sensitive_${sem.sensitive_flag}`,
          rule_citation: `Outbound payload blocked by sensitive category protection "${sem.sensitive_flag}".`,
          semantic_category: sem.sensitive_flag,
          sensitive_flag: sem.sensitive_flag,
          confidence: sem.confidence,
          injection_risk_score: baseInjectionScore,
          injection_signals: baseInjectionSignals,
          reasoning_code: sem.reasoning_code,
          latency_ms: Math.max(1, Math.round(performance.now() - start)),
          stage_details: {
            stage_a_passed: true,
            stage_a_reason: stageA.ruleCitation,
            stage_b_executed: true,
            stage_b_reason: sem.reasoning_code,
            stage_c_triggered: false,
            stage_c_reason: null,
          },
        };
      }
      matchedScope = sem.matched_scope;
      stageBReason = matchedScope
        ? `Outbound context aligned with "${matchedScope}".`
        : 'Outbound payload cleared sensitive checks.';
    }

    // Stage C — HITL "Ask Me First" Gate
    const stageC = this.evaluateConditionalAskFirst(
      policy,
      input.tool,
      input.outbound,
      input.email
    );

    if (stageC.triggered) {
      return {
        decision: 'PENDING_APPROVAL',
        stage: 'STAGE_C_HITL',
        matched_rule_id: stageC.ruleId,
        rule_citation: stageC.citation,
        semantic_category: matchedScope,
        sensitive_flag: null,
        confidence: semanticConfidence,
        injection_risk_score: baseInjectionScore,
        injection_signals: baseInjectionSignals,
        reasoning_code: 'HITL_APPROVAL_REQUIRED',
        latency_ms: Math.max(1, Math.round(performance.now() - start)),
        stage_details: {
          stage_a_passed: true,
          stage_a_reason: stageA.ruleCitation,
          stage_b_executed: stageBExecuted,
          stage_b_reason: stageBReason,
          stage_c_triggered: true,
          stage_c_reason: stageC.citation,
        },
      };
    }

    const scopeObj = matchedScope
      ? policy.semantic_allow_scopes.find((s) => s.id === matchedScope)
      : undefined;
    const scopeClause = scopeObj?.source_clause_id
      ? policy.rule_clauses.find((c) => c.id === scopeObj.source_clause_id)
      : undefined;

    return {
      decision: 'ALLOW',
      stage: stageBExecuted ? 'STAGE_B_SEMANTIC' : 'STAGE_A_DETERMINISTIC',
      matched_rule_id: scopeClause?.id ?? stageA.matchedRuleId,
      rule_citation: scopeClause?.text ?? stageA.ruleCitation,
      semantic_category: matchedScope,
      sensitive_flag: null,
      confidence: semanticConfidence,
      injection_risk_score: baseInjectionScore,
      injection_signals: baseInjectionSignals,
      reasoning_code: matchedScope ? `ALLOWED_${matchedScope.toUpperCase()}` : 'ALLOWED_BY_RULE',
      latency_ms: Math.max(1, Math.round(performance.now() - start)),
      stage_details: {
        stage_a_passed: true,
        stage_a_reason: stageA.ruleCitation,
        stage_b_executed: stageBExecuted,
        stage_b_reason: stageBReason,
        stage_c_triggered: false,
        stage_c_reason: null,
      },
    };
  }
}
