import { eq } from 'drizzle-orm';
import type {
  CircuitBreakerConfig,
  KillSwitchState,
  KillSwitchTriggerMode,
} from '@clam/shared';
import type { AuditLogger, RealtimeEventHub } from '../audit/logger.js';
import type { ClamDatabase } from '../db/index.js';
import { killSwitchState } from '../db/schema.js';

const GLOBAL_ROW_ID = 'global';

export interface ActiveAbortRegistration {
  runId: string;
  agentId: string;
  controller: AbortController;
  startedAt: string;
}

export interface CircuitBreakerEvaluationInput {
  agentId: string;
  agentName: string;
  mcpTool: string;
  decision: 'ALLOW' | 'DENY' | 'PENDING_APPROVAL';
  reasoningCode: string;
  injectionRiskScore: number;
  runId?: string | null;
}

export class KillSwitchService {
  private state: KillSwitchState;
  private readonly activeControllers = new Map<string, ActiveAbortRegistration>();
  private readonly violationTimestamps = new Map<string, number[]>();
  private onGlobalResume: () => void = () => {};
  private externalHalt: () => boolean = () => false;
  private readonly callTimestamps = new Map<string, number[]>();

  constructor(
    private readonly db: ClamDatabase,
    private readonly auditLogger: AuditLogger,
    private readonly hub: RealtimeEventHub,
    defaultBreakerConfig?: Partial<CircuitBreakerConfig>
  ) {
    this.state = {
      status: 'ARMED',
      trigger_mode: null,
      engaged_at: null,
      engaged_by: null,
      reason: null,
      halted_agents: [],
      active_runs_count: 0,
      aborted_inflight_count: 0,
      circuit_breaker: {
        violation_threshold: defaultBreakerConfig?.violation_threshold ?? 3,
        window_seconds: defaultBreakerConfig?.window_seconds ?? 30,
        max_calls_per_min: defaultBreakerConfig?.max_calls_per_min ?? 25,
        trip_on_critical_injection: defaultBreakerConfig?.trip_on_critical_injection ?? true,
      },
      recent_violation_count: 0,
    };
  }

  async init(): Promise<void> {
    const row = await this.db
      .select()
      .from(killSwitchState)
      .where(eq(killSwitchState.id, GLOBAL_ROW_ID))
      .get();

    if (!row) {
      await this.persistState();
      return;
    }

    this.state = {
      ...this.state,
      status: row.status === 'HALTED' ? 'HALTED' : 'ARMED',
      trigger_mode: (row.triggerMode as KillSwitchTriggerMode) ?? null,
      engaged_at: row.engagedAt ?? null,
      engaged_by: row.engagedBy ?? null,
      reason: row.reason ?? null,
      halted_agents: JSON.parse(row.haltedAgentsJson || '[]') as string[],
      aborted_inflight_count: row.abortedInflightCount ?? 0,
      circuit_breaker: {
        ...this.state.circuit_breaker,
        ...(JSON.parse(row.circuitBreakerJson || '{}') as Partial<CircuitBreakerConfig>),
      },
    };
  }

  private async persistState(): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(killSwitchState)
      .values({
        id: GLOBAL_ROW_ID,
        status: this.state.status,
        triggerMode: this.state.trigger_mode,
        engagedAt: this.state.engaged_at,
        engagedBy: this.state.engaged_by,
        reason: this.state.reason,
        haltedAgentsJson: JSON.stringify(this.state.halted_agents),
        abortedInflightCount: this.state.aborted_inflight_count,
        circuitBreakerJson: JSON.stringify(this.state.circuit_breaker),
        updatedAt: now,
      } as typeof killSwitchState.$inferInsert)
      .onConflictDoUpdate({
        target: killSwitchState.id,
        set: {
          status: this.state.status,
          triggerMode: this.state.trigger_mode,
          engagedAt: this.state.engaged_at,
          engagedBy: this.state.engaged_by,
          reason: this.state.reason,
          haltedAgentsJson: JSON.stringify(this.state.halted_agents),
          abortedInflightCount: this.state.aborted_inflight_count,
          circuitBreakerJson: JSON.stringify(this.state.circuit_breaker),
          updatedAt: now,
        },
      });
  }

  getState(): KillSwitchState {
    const now = Date.now();
    const cutoff = now - this.state.circuit_breaker.window_seconds * 1000;
    let recentViolations = 0;
    for (const [key, list] of this.violationTimestamps.entries()) {
      const filtered = list.filter((ts) => ts > cutoff);
      this.violationTimestamps.set(key, filtered);
      recentViolations += filtered.length;
    }

    return {
      ...this.state,
      halted_agents: [...this.state.halted_agents],
      circuit_breaker: { ...this.state.circuit_breaker },
      active_runs_count: this.activeControllers.size,
      recent_violation_count: recentViolations,
    };
  }

  isHalted(agentId?: string): boolean {
    if (this.state.status === 'HALTED' || this.externalHalt()) return true;
    if (agentId && this.state.halted_agents.includes(agentId)) return true;
    return false;
  }

  attachExternalHalt(check: () => boolean, onResume: () => void) {
    this.externalHalt = check;
    this.onGlobalResume = onResume;
  }

  registerInFlight(runId: string, agentId: string, controller: AbortController): () => void {
    this.activeControllers.set(runId, {
      runId,
      agentId,
      controller,
      startedAt: new Date().toISOString(),
    });
    this.hub.publish('killswitch.changed', this.getState());
    return () => {
      this.activeControllers.delete(runId);
      this.hub.publish('killswitch.changed', this.getState());
    };
  }

  private abortControllersFor(agentId?: string, reason = 'KILL_SWITCH_ENGAGED'): number {
    let aborted = 0;
    for (const [key, reg] of this.activeControllers.entries()) {
      if (!agentId || reg.agentId === agentId) {
        if (!reg.controller.signal.aborted) {
          reg.controller.abort(new Error(reason));
          aborted += 1;
        }
        this.activeControllers.delete(key);
      }
    }
    return aborted;
  }

  async engage(params: {
    triggerMode?: Exclude<KillSwitchTriggerMode, null>;
    engagedBy?: string;
    reason?: string;
    agentId?: string;
    runId?: string | null;
  }): Promise<KillSwitchState> {
    const now = new Date().toISOString();
    const triggerMode = params.triggerMode ?? 'manual_api';
    const reason =
      params.reason?.trim() ||
      (triggerMode === 'circuit_breaker'
        ? 'Auto-Trip Circuit Breaker triggered due to anomalous policy violations.'
        : 'Emergency Kill Switch engaged by operator.');
    const engagedBy = params.engagedBy?.trim() || 'operator';

    const abortedCount = this.abortControllersFor(params.agentId, reason);

    if (params.agentId) {
      if (!this.state.halted_agents.includes(params.agentId)) {
        this.state.halted_agents.push(params.agentId);
      }
    } else {
      this.state.status = 'HALTED';
      this.state.trigger_mode = triggerMode;
      this.state.engaged_at = now;
      this.state.engaged_by = engagedBy;
      this.state.reason = reason;
    }

    this.state.aborted_inflight_count += abortedCount;
    await this.persistState();

    const auditDecision =
      triggerMode === 'circuit_breaker' ? 'CIRCUIT_BREAKER_TRIPPED' : 'KILL_SWITCH_ENGAGED';

    await this.auditLogger.record({
      runId: params.runId ?? null,
      agentId: params.agentId ?? 'system_killswitch',
      agentName: params.agentId ? `Agent Freeze (${params.agentId})` : 'Global Kill Switch',
      mcpTool: 'killswitch.engage',
      decision: auditDecision,
      matchedRuleId: triggerMode,
      ruleCitation: `${reason} (aborted ${abortedCount} in-flight operation(s))`,
      semanticCategory: 'kill_switch',
      confidence: 1,
      injectionRiskScore: triggerMode === 'circuit_breaker' ? 1 : 0,
      injectionSignals: triggerMode === 'circuit_breaker' ? ['CIRCUIT_BREAKER_TRIP'] : [],
      latencyMs: 1,
    });

    const snapshot = this.getState();
    this.hub.publish('killswitch.changed', snapshot);
    return snapshot;
  }

  async resume(params: {
    resumedBy?: string;
    reason: string;
    agentId?: string;
  }): Promise<KillSwitchState> {
    const reason = params.reason.trim();
    if (!reason) {
      throw new Error('Explicit resume reason is required for audit trail accountability.');
    }

    if (params.agentId) {
      this.state.halted_agents = this.state.halted_agents.filter((a) => a !== params.agentId);
      this.violationTimestamps.delete(params.agentId);
      for (const key of this.callTimestamps.keys()) {
        if (key === params.agentId || key.startsWith(params.agentId + ':')) this.callTimestamps.delete(key);
      }
    } else {
      this.state.status = 'ARMED';
      this.state.trigger_mode = null;
      this.state.engaged_at = null;
      this.state.engaged_by = null;
      this.state.reason = null;
      this.state.halted_agents = [];
      this.violationTimestamps.clear();
      this.callTimestamps.clear();
    }

    await this.persistState();
    if (!params.agentId) this.onGlobalResume();

    await this.auditLogger.record({
      agentId: params.agentId ?? 'system_killswitch',
      agentName: params.agentId ? `Agent Resume (${params.agentId})` : 'Global Kill Switch',
      mcpTool: 'killswitch.resume',
      decision: 'KILL_SWITCH_RESUMED',
      matchedRuleId: 'manual_resume',
      ruleCitation: `Kill Switch disarmed by ${params.resumedBy || 'operator'}: ${reason}`,
      semanticCategory: 'kill_switch',
      confidence: 1,
      latencyMs: 1,
    });

    const snapshot = this.getState();
    this.hub.publish('killswitch.changed', snapshot);
    return snapshot;
  }

  async updateCircuitBreakerConfig(
    patch: Partial<CircuitBreakerConfig>
  ): Promise<KillSwitchState> {
    this.state.circuit_breaker = {
      violation_threshold:
        patch.violation_threshold !== undefined
          ? Math.max(1, Math.min(20, patch.violation_threshold))
          : this.state.circuit_breaker.violation_threshold,
      window_seconds:
        patch.window_seconds !== undefined
          ? Math.max(5, Math.min(300, patch.window_seconds))
          : this.state.circuit_breaker.window_seconds,
      max_calls_per_min:
        patch.max_calls_per_min !== undefined
          ? Math.max(3, Math.min(200, patch.max_calls_per_min))
          : this.state.circuit_breaker.max_calls_per_min,
      trip_on_critical_injection:
        patch.trip_on_critical_injection !== undefined
          ? patch.trip_on_critical_injection
          : this.state.circuit_breaker.trip_on_critical_injection,
    };

    await this.persistState();
    const snapshot = this.getState();
    this.hub.publish('killswitch.changed', snapshot);
    return snapshot;
  }

  /**
   * Evaluates explicit MCP tool call outcomes against the sliding-window Auto-Trip Circuit Breaker.
   * Returns true if the circuit breaker tripped during this call.
   */
  async recordToolOutcome(input: CircuitBreakerEvaluationInput): Promise<boolean> {
    if (this.isHalted(input.agentId)) return true;

    const now = Date.now();
    const cfg = this.state.circuit_breaker;

    // 1. Track overall call velocity per minute (runaway loop detector)
    const minCutoff = now - 60_000;
    const scope = input.runId ? input.agentId + ':' + input.runId : input.agentId;
    for (const [key, timestamps] of this.callTimestamps) {
      if (timestamps.at(-1)! <= minCutoff) this.callTimestamps.delete(key);
    }
    const calls = (this.callTimestamps.get(scope) ?? []).filter((ts) => ts > minCutoff);
    calls.push(now);
    this.callTimestamps.set(scope, calls);

    if (calls.length > cfg.max_calls_per_min) {
      await this.engage({
        triggerMode: 'circuit_breaker',
        engagedBy: 'auto_circuit_breaker',
        reason: `Auto-Trip Circuit Breaker: runaway tool loop detected (${calls.length} calls/min > ${cfg.max_calls_per_min} limit) for ${input.agentName}.`,
        runId: input.runId,
      });
      return true;
    }

    if (input.decision !== 'DENY') {
      return false;
    }

    // 2. Immediate trip on critical prompt-injection exfiltration attempt toward outbound/destructive tools
    const isOutboundOrDestructive =
      input.mcpTool === 'send_email' ||
      input.mcpTool === 'delete_email' ||
      input.mcpTool === 'create_draft';
    const isCriticalExfil =
      input.reasoningCode === 'NO_CREDENTIALS_OR_OTP' ||
      (isOutboundOrDestructive && input.injectionRiskScore >= 0.75);

    if (cfg.trip_on_critical_injection && isCriticalExfil) {
      await this.engage({
        triggerMode: 'circuit_breaker',
        engagedBy: 'auto_circuit_breaker',
        reason: `Auto-Trip Circuit Breaker: critical exfiltration/injection attempt on ${input.mcpTool} (${input.reasoningCode}).`,
        runId: input.runId,
      });
      return true;
    }

    // 3. Sliding-window violation counter
    const winCutoff = now - cfg.window_seconds * 1000;
    const violations = (this.violationTimestamps.get(input.agentId) ?? []).filter(
      (ts) => ts > winCutoff
    );
    violations.push(now);
    this.violationTimestamps.set(input.agentId, violations);

    if (violations.length >= cfg.violation_threshold) {
      await this.engage({
        triggerMode: 'circuit_breaker',
        engagedBy: 'auto_circuit_breaker',
        reason: `Auto-Trip Circuit Breaker: ${violations.length} blocked policy violations within ${cfg.window_seconds}s by ${input.agentName}.`,
        runId: input.runId,
      });
      return true;
    }

    return false;
  }
}
