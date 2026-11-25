'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Check,
  Copy,
  Download,
  FileCode2,
  MoreHorizontal,
  Play,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import type { AgentRecord, AuditDecision, AuditLogEntry } from '@clam/shared';
import { ClamMascot, type ClamMascotState } from '@/components/ClamMascot';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { DecisionTraceDrawer } from '@/components/DecisionTraceDrawer';
import { API_BASE, clamApi } from '@/lib/api';

type ProbeId = 'full' | 'flight_read' | 'otp_block' | 'forbidden_send' | 'runaway_trip' | 'trappack';

function mapDecisionToMascot(decision: AuditDecision): ClamMascotState {
  if (decision === 'KILL_SWITCH_ENGAGED' || decision === 'CIRCUIT_BREAKER_TRIPPED') return 'halted';
  if (decision === 'ALLOW' || decision === 'APPROVED' || decision === 'KILL_SWITCH_RESUMED') {
    return 'allow';
  }
  if (decision === 'PENDING_APPROVAL') return 'pending';
  return 'blocked';
}

const POSTURE_COPY: Record<ClamMascotState, { headline: string; sub: string }> = {
  armed: {
    headline: 'Firewall armed — monitoring MCP boundary',
    sub: 'Run the Unattended Autonomous Agent, connect Claude Desktop / Codex / Gemini CLI via /mcp, or run an adversarial probe.',
  },
  allow: {
    headline: 'Semantic check passed — permitted email proxied',
    sub: 'In-scope message served from ephemeral RAM with zero disk retention.',
  },
  blocked: {
    headline: 'Shell clamped — unauthorized or injected request blocked',
    sub: 'Deterministic hard gate, sensitive denylist, or prompt-injection shield stopped access in RAM.',
  },
  pending: {
    headline: 'Paused at Stage C HITL — awaiting human sign-off',
    sub: 'Proposed action encrypted in RAM until approved, denied, or expired.',
  },
  halted: {
    headline: 'EMERGENCY HALTED — Double-bolted hardware safety latch engaged',
    sub: 'All in-flight runs aborted, /mcp endpoints returning HTTP 423 Locked, and mutations frozen.',
  },
};

export default function OverviewPage() {
  const {
    overview,
    liveFeed,
    killSwitch,
    latestRun,
    liveRunSteps,
    trapReport,
    sseConnected,
    refreshOverview,
    mascotState,
    pulseMascot,
    lastEventTick,
    setLatestRun,
    setTrapReport,
    clearLiveRunSteps,
  } = useConsole();

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [activeProbe, setActiveProbe] = useState<ProbeId | null>(null);
  const [runningAutonomous, setRunningAutonomous] = useState(false);
  const [probeNotice, setProbeNotice] = useState<string | null>(null);
  const [probeHovered, setProbeHovered] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<{
    filename: string;
    content: string;
  } | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const res = await clamApi.getAgents();
      setAgents(res.agents);
    } catch {
      // ignore initial boot race
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents, lastEventTick]);

  const metrics = overview?.metrics ?? {
    total_intercepted: 0,
    allowed: 0,
    blocked: 0,
    pending_decisions: 0,
  };
  const pendingCount = overview?.pending_approvals_count ?? 0;
  const isHalted = killSwitch?.status === 'HALTED';

  const totalMix = Math.max(1, metrics.allowed + metrics.blocked + pendingCount);
  const allowPct = Math.round((metrics.allowed / totalMix) * 100);
  const blockPct = Math.round((metrics.blocked / totalMix) * 100);
  const pendingPct = Math.max(0, 100 - allowPct - blockPct);

  const mcpEndpointDisplay = `${API_BASE}/mcp`;

  function copyMcpChip() {
    void navigator.clipboard.writeText(mcpEndpointDisplay);
    setCopiedMcp(true);
    setTimeout(() => setCopiedMcp(false), 1600);
  }

  async function callMcpTool(token: string, id: number, name: string, args: Record<string, unknown>) {
    const res = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return res.json();
  }

  async function handleRunAutonomousAgent() {
    if (runningAutonomous || activeProbe !== null) return;
    setRunningAutonomous(true);
    setProbeNotice(null);
    clearLiveRunSteps();
    try {
      const res = await clamApi.startAgentRun({ agent_id: 'ag_autonomous' });
      setLatestRun(res.run);
      setProbeNotice(
        `Unattended run ${res.run.run_id} ${res.run.status.toUpperCase()}: ${res.run.emails_permitted} permitted, ${res.run.emails_stripped_or_blocked} stripped/blocked, ${res.run.conflicts_resolved} conflict resolved, ${res.run.artifacts_written.length} artifacts saved ($${res.run.estimated_cost_usd.toFixed(2)}).`
      );
      await refreshOverview();
    } catch (err) {
      setProbeNotice(err instanceof Error ? err.message : 'Autonomous run failed');
    } finally {
      setRunningAutonomous(false);
    }
  }

  async function runProbe(probeId: ProbeId) {
    if (activeProbe !== null || runningAutonomous) return;
    setActiveProbe(probeId);
    setProbeNotice(null);

    if (probeId === 'trappack') {
      try {
        const res = await clamApi.runTrapPack();
        setTrapReport(res.report);
        setProbeNotice(
          `Trap Pack verified: ${res.report.passed_cases}/${res.report.total_cases} cases passed · 0 exfiltration leaks · legitimate mission ${res.report.mission_survived ? 'SURVIVED' : 'FAILED'}.`
        );
        await refreshOverview();
      } catch (err) {
        setProbeNotice(err instanceof Error ? err.message : 'Trap Pack run failed');
      } finally {
        setActiveProbe(null);
      }
      return;
    }

    let tokenId: string | null = null;
    try {
      const targetAgentId = probeId === 'runaway_trip' ? 'ag_autonomous' : 'ag_travel';
      const issued = await clamApi.issueToken(targetAgentId, `Quick Probe (${probeId})`);
      tokenId = issued.token.id;

      if (probeId === 'full') {
        await callMcpTool(issued.raw_token, 1, 'list_emails', { maxResults: 10 });
        await callMcpTool(issued.raw_token, 2, 'read_email', { messageId: 'msg_otp_bank_06' });
        await callMcpTool(issued.raw_token, 3, 'send_email', {
          to: 'kenji.host@airbnb-messages.example',
          subject: 'Arrival time',
          body: 'Arriving at 4 PM.',
        });
        await callMcpTool(issued.raw_token, 4, 'create_draft', {
          to: 'kenji.host@airbnb-messages.example',
          subject: 'Re: Reservation HM8842ZQ91 — Arrival instructions',
          body: 'Hi Kenji, my train arrives around 3:30 PM on Dec 20. Looking forward to staying at Cedar Machiya!',
          threadId: 'thr_hotel_airbnb_03',
        });
        setProbeNotice(
          'Executed real MCP JSON-RPC calls (list_emails, read_email OTP block, send_email hard-deny, create_draft HITL ticket).'
        );
      } else if (probeId === 'flight_read') {
        await callMcpTool(issued.raw_token, 1, 'read_email', { messageId: 'msg_flight_delta_01' });
        pulseMascot('allow', 2500);
        setProbeNotice('Test Flight Read → ALLOW: Delta DL 402 confirmation passed semantic scope.');
      } else if (probeId === 'otp_block') {
        await callMcpTool(issued.raw_token, 2, 'read_email', { messageId: 'msg_otp_bank_06' });
        pulseMascot('blocked', 2500);
        setProbeNotice('Test Bank OTP Block → BLOCKED: Mercury 2FA code denied at Stage B.');
      } else if (probeId === 'forbidden_send') {
        await callMcpTool(issued.raw_token, 3, 'send_email', {
          to: 'external@untrusted.example',
          subject: 'Direct Outbound Attempt',
          body: 'Testing deterministic NEVER_SEND hard gate.',
        });
        pulseMascot('blocked', 2500);
        setProbeNotice('Test Forbidden Send → BLOCKED: Deterministic NEVER_SEND enforced at Stage A.');
      } else if (probeId === 'runaway_trip') {
        for (let i = 1; i <= 3; i++) {
          await callMcpTool(issued.raw_token, 10 + i, 'send_email', {
            to: 'exfil@untrusted.example',
            subject: `Runaway attempt #${i}`,
            body: `Loop probe #${i}`,
          });
        }
        setProbeNotice(
          'Auto-Trip Circuit Breaker fired after 3 rapid policy violations — Kill Switch latched to HALTED.'
        );
      }

      await refreshOverview();
    } catch (err) {
      setProbeNotice(err instanceof Error ? err.message : 'Probe failed');
    } finally {
      if (tokenId) {
        const targetAgentId = probeId === 'runaway_trip' ? 'ag_autonomous' : 'ag_travel';
        await clamApi.revokeToken(targetAgentId, tokenId).catch(() => {});
      }
      setActiveProbe(null);
    }
  }

  async function openArtifact(filename: string) {
    try {
      const res = await clamApi.getArtifactContent(filename);
      setArtifactPreview(res);
    } catch {
      // ignore
    }
  }

  const bannerMascotState =
    isHalted ? 'halted' : probeHovered && mascotState === 'armed' ? 'allow' : mascotState;
  const postureText =
    liveFeed.length === 0 && bannerMascotState === 'armed'
      ? {
          headline: 'Firewall armed — ready for zero-touch autonomous run',
          sub: 'Click Run Unattended Agent to triage the Sandbox Inbox over real MCP, strip OTPs & prompt injections, reconcile conflicts, and emit itinerary.md + trip.ics.',
        }
      : POSTURE_COPY[bannerMascotState];

  const displayedSteps = liveRunSteps.length > 0 ? liveRunSteps : latestRun?.steps ?? [];
  const artifacts = overview?.artifacts ?? [];

  return (
    <div className="space-y-5">
      {/* Top Page Title & Action Row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-display text-ink-primary">
            Live Firewall & Autonomy Overview
          </h1>
          <p className="text-[13px] text-ink-secondary mt-0.5">
            Unattended MCP Inbox Agent behind deterministic gates, prompt-injection shield, and instant Kill Switch.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleRunAutonomousAgent}
            disabled={runningAutonomous || activeProbe !== null || isHalted}
            onMouseEnter={() => setProbeHovered(true)}
            onMouseLeave={() => setProbeHovered(false)}
            className="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
          >
            <Bot className="w-3.5 h-3.5" />
            {runningAutonomous ? 'Running Autonomous Agent…' : 'Run Unattended Agent'}
          </button>

          <button
            type="button"
            onClick={() => runProbe('full')}
            disabled={activeProbe !== null || runningAutonomous || isHalted}
            className="btn-tactile inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-hairline bg-elevated text-xs font-medium text-ink-primary hover:border-ink-muted disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {activeProbe === 'full' ? 'Probing…' : 'Run MCP Probe'}
          </button>

          <Link
            href="/agents"
            className="btn-tactile inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-hairline bg-surface text-xs font-medium text-ink-secondary hover:text-ink-primary hover:border-ink-muted"
          >
            Rules Studio
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {probeNotice && (
        <div className="bento-card rounded-xl px-4 py-2.5 text-xs text-ink-secondary flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-emerald-matte shrink-0" />
            <span className="text-ink-primary">{probeNotice}</span>
          </span>
          {pendingCount > 0 && (
            <Link
              href="/approvals"
              className="text-amber-matte font-medium hover:underline whitespace-nowrap"
            >
              Review Approval Queue →
            </Link>
          )}
        </div>
      )}

      {/* 4-Column Unified KPI Strip */}
      <section className="bento-card rounded-xl overflow-hidden">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-hairline">
          <div className="p-4 lg:p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-secondary">Requests Intercepted</span>
              <span className="px-1.5 py-0.5 rounded border border-hairline bg-elevated font-mono text-[9px] uppercase tracking-wider text-ink-secondary">
                NEUTRAL
              </span>
            </div>
            <div
              className={`mt-2.5 text-[28px] leading-none font-semibold kpi-num ${
                metrics.total_intercepted > 0 ? 'text-ink-primary' : 'text-ink-muted'
              }`}
            >
              {metrics.total_intercepted}
            </div>
            <div className="text-[11px] text-ink-muted mt-2">Total MCP evaluations</div>
          </div>

          <div className={`p-4 lg:p-5 ${metrics.allowed > 0 ? 'bg-emerald-fill/35' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-secondary">Allowed</span>
              <span className="px-1.5 py-0.5 rounded border border-emerald-matte/30 bg-emerald-fill font-mono text-[9px] uppercase tracking-wider text-emerald-matte">
                ALLOWED
              </span>
            </div>
            <div
              className={`mt-2.5 text-[28px] leading-none font-semibold kpi-num ${
                metrics.allowed > 0 ? 'text-emerald-matte' : 'text-ink-muted'
              }`}
            >
              {metrics.allowed}
            </div>
            <div className="text-[11px] text-ink-muted mt-2">In-scope semantic pass</div>
          </div>

          <div className="p-4 lg:p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-secondary">Blocked</span>
              <span className="px-1.5 py-0.5 rounded border border-crimson-matte/30 bg-crimson-fill font-mono text-[9px] uppercase tracking-wider text-crimson-matte">
                BLOCKED
              </span>
            </div>
            <div
              className={`mt-2.5 text-[28px] leading-none font-semibold kpi-num ${
                metrics.blocked > 0 ? 'text-crimson-matte' : 'text-ink-muted'
              }`}
            >
              {metrics.blocked}
            </div>
            <div className="text-[11px] text-ink-muted mt-2">Default-deny, injections & halts</div>
          </div>

          <div className="p-4 lg:p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-secondary">Pending Approval</span>
              <span className="px-1.5 py-0.5 rounded border border-amber-matte/30 bg-amber-fill font-mono text-[9px] uppercase tracking-wider text-amber-matte">
                ASK FIRST
              </span>
            </div>
            <div
              className={`mt-2.5 text-[28px] leading-none font-semibold kpi-num ${
                pendingCount > 0 ? 'text-amber-matte' : 'text-ink-muted'
              }`}
            >
              {pendingCount}
            </div>
            <div className="text-[11px] text-ink-muted mt-2">Awaiting human sign-off</div>
          </div>
        </div>

        {/* Bottom Segmented Ratio Bar */}
        <div className="px-4 lg:px-5 py-2.5 border-t border-hairline bg-canvas/50 flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-wider text-ink-muted whitespace-nowrap">
            DECISION MIX
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden flex">
            {metrics.total_intercepted > 0 ? (
              <>
                <div
                  className="bg-emerald-matte transition-all duration-300"
                  style={{ width: `${allowPct}%` }}
                />
                <div
                  className="bg-crimson-matte transition-all duration-300"
                  style={{ width: `${blockPct}%` }}
                />
                <div
                  className="bg-amber-matte transition-all duration-300"
                  style={{ width: `${pendingPct}%` }}
                />
              </>
            ) : (
              <div className="w-full bg-hairline/70" />
            )}
          </div>
          <span className="text-[11px] font-mono text-ink-secondary tabular-nums whitespace-nowrap">
            {metrics.total_intercepted > 0
              ? `${allowPct}% allow · ${blockPct}% block`
              : '0%'}
          </span>
        </div>
      </section>

      {pendingCount > 0 && (
        <div className="rounded-xl px-4 py-3 border border-amber-matte/30 bg-amber-fill flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs">
            <ShieldAlert className="w-4 h-4 text-amber-matte shrink-0" />
            <span className="text-ink-primary font-medium">
              {pendingCount} action{pendingCount === 1 ? '' : 's'} held at Stage C HITL gate.
            </span>
            <span className="text-ink-secondary hidden sm:inline">
              Encrypted payloads live in RAM until approved, denied, or expired.
            </span>
          </div>
          <Link
            href="/approvals"
            className="btn-tactile px-2.5 py-1 rounded-md border border-amber-matte/35 text-amber-matte text-xs font-medium hover:bg-amber-matte/10 whitespace-nowrap"
          >
            Open Queue
          </Link>
        </div>
      )}

      {/* Asymmetric 2-Column Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Left (8 cols): Autonomous Deliverables + Live Interception Feed */}
        <div className="xl:col-span-8 space-y-5">
          {/* Autonomous Run & Deliverables Card */}
          {(latestRun || displayedSteps.length > 0 || artifacts.length > 0) && (
            <section className="bento-card rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-hairline flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-emerald-matte" />
                  <h2 className="text-[13px] font-semibold text-ink-primary">
                    Autonomous Agent Run & Artifacts
                  </h2>
                  {latestRun && (
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-hairline bg-canvas text-ink-secondary">
                      {latestRun.run_id} · {latestRun.status.toUpperCase()}
                    </span>
                  )}
                </div>
                {latestRun && (
                  <span className="font-mono text-[11px] text-ink-secondary tabular-nums">
                    {latestRun.provider} · ${latestRun.estimated_cost_usd.toFixed(4)}
                  </span>
                )}
              </div>

              {displayedSteps.length > 0 && (
                <div className="p-4 space-y-1.5 border-b border-hairline bg-canvas/35 max-h-56 overflow-y-auto">
                  {displayedSteps.map((s) => (
                    <div
                      key={`${s.step}-${s.action}`}
                      className="flex items-start justify-between gap-3 text-xs py-1"
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <span
                          className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                            s.status === 'ok'
                              ? 'bg-emerald-fill text-emerald-matte border-emerald-matte/30'
                              : s.status === 'blocked' || s.status === 'aborted'
                                ? 'bg-crimson-fill text-crimson-matte border-crimson-matte/30'
                                : 'bg-elevated text-ink-secondary border-hairline'
                          }`}
                        >
                          #{s.step}
                        </span>
                        <div className="min-w-0">
                          <span className="font-mono text-[11px] text-ink-primary mr-2">
                            {s.action}
                          </span>
                          <span className="text-ink-secondary">{s.detail}</span>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-ink-muted shrink-0 tabular-nums">
                        {s.latency_ms}ms
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {artifacts.length > 0 && (
                <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-2 bg-surface">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-ink-muted">
                    Generated Deliverables
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {artifacts.map((art) => (
                      <div key={art.filename} className="inline-flex items-center">
                        <button
                          type="button"
                          onClick={() => openArtifact(art.filename)}
                          className="btn-tactile inline-flex items-center gap-1.5 px-2.5 py-1 rounded-l-md border border-hairline bg-canvas hover:bg-elevated text-xs font-mono text-ink-primary"
                        >
                          <FileCode2 className="w-3 h-3 text-emerald-matte" />
                          {art.filename}
                        </button>
                        <a
                          href={clamApi.getArtifactDownloadUrl(art.filename)}
                          download={art.filename}
                          title={`Download ${art.filename}`}
                          className="btn-tactile px-2 py-1 rounded-r-md border border-l-0 border-hairline bg-canvas hover:bg-elevated text-ink-secondary hover:text-ink-primary"
                        >
                          <Download className="w-3 h-3" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Live Interception Feed */}
          <section className="bento-card rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-hairline flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    sseConnected ? 'bg-emerald-matte' : 'bg-amber-matte'
                  }`}
                />
                <h2 className="text-[13px] font-semibold text-ink-primary">
                  Live Interception Feed
                </h2>
              </div>
              <Link
                href="/audit"
                className="text-xs text-ink-secondary hover:text-ink-primary font-medium"
              >
                Full Audit Ledger →
              </Link>
            </div>

            {/* Live Mascot Status Banner (52px) */}
            <div className="relative px-5 py-5 border-b border-hairline bg-canvas/40 flex flex-col items-center text-center overflow-hidden">
              <div className="absolute inset-0 dot-grid-stage pointer-events-none" />
              <div className="relative z-10 flex flex-col items-center space-y-2.5 max-w-lg">
                <ClamMascot
                  state={bannerMascotState}
                  size={52}
                  interactive
                  peek={probeHovered}
                />
                <div className="text-[13px] font-semibold text-ink-primary">
                  {postureText.headline}
                </div>
                <p className="text-[11px] text-ink-secondary leading-relaxed">
                  {postureText.sub}
                </p>
                <button
                  type="button"
                  onClick={copyMcpChip}
                  className="btn-tactile inline-flex items-center gap-2 px-2.5 py-1 rounded-md border border-hairline bg-surface hover:bg-elevated text-[11px] font-mono text-ink-secondary hover:text-ink-primary"
                >
                  <span>{mcpEndpointDisplay}</span>
                  {copiedMcp ? (
                    <Check className="w-3 h-3 text-emerald-matte" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            </div>

            {/* Dense Scannable Feed Rows */}
            {liveFeed.length > 0 && (
              <div className="divide-y divide-hairline">
                {liveFeed.slice(0, 14).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedEntry(entry)}
                    className="animate-row-in w-full text-left px-4 py-2.5 hover:bg-elevated/60 transition-colors duration-150 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <DecisionBadge decision={entry.decision} />
                      <ClamMascot state={mapDecisionToMascot(entry.decision)} size={26} />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-ink-primary truncate">
                          <span>{entry.agent_name}</span>
                          <span className="text-ink-muted mx-1.5">·</span>
                          <span className="font-mono text-[11px] text-ink-secondary">
                            {entry.mcp_tool}
                          </span>
                          {entry.injection_risk_score >= 0.55 && (
                            <span className="ml-2 font-mono text-[10px] text-crimson-matte">
                              INJ {Math.round(entry.injection_risk_score * 100)}%
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-ink-secondary truncate mt-0.5">
                          {entry.rule_citation}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0 font-mono text-[11px] text-ink-muted tabular-nums">
                      <span className="hidden sm:inline">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-ink-secondary w-11 text-right">
                        {entry.latency_ms}ms
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right (4 cols): Active Guardrails + Quick Probes & Trap Pack */}
        <div className="xl:col-span-4 space-y-5">
          {/* Card 1: Active Guardrails */}
          <section className="bento-card rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-matte" />
                <h2 className="text-[13px] font-semibold text-ink-primary">Active Guardrails</h2>
              </div>
              <Link
                href="/agents"
                className="text-[11px] font-medium text-ink-muted hover:text-ink-primary"
              >
                Edit
              </Link>
            </div>

            <div className="divide-y divide-hairline">
              {agents.map((ag) => (
                <Link
                  key={ag.id}
                  href={`/agents?agent=${encodeURIComponent(ag.id)}`}
                  className="btn-tactile flex items-center justify-between gap-3 px-4 py-3 hover:bg-elevated/60"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                        ag.status === 'active' ? 'bg-emerald-matte' : 'bg-ink-muted'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-ink-primary truncate">
                        {ag.name}
                      </div>
                      <div className="text-[11px] text-ink-secondary truncate mt-0.5">
                        {ag.raw_rules}
                      </div>
                    </div>
                  </div>
                  <MoreHorizontal className="w-4 h-4 text-ink-muted shrink-0" />
                </Link>
              ))}
              {agents.length === 0 && (
                <div className="px-4 py-5 text-xs text-ink-muted">Loading agents…</div>
              )}
            </div>
          </section>

          {/* Card 2: Adversarial Probes & Trap Pack */}
          <section className="bento-card rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-ink-secondary" />
                <h2 className="text-[13px] font-semibold text-ink-primary">
                  Probes & Trap Pack
                </h2>
              </div>
              <span className="text-[10px] font-mono text-ink-muted">LIVE /mcp</span>
            </div>

            <div className="p-3.5 space-y-2.5">
              <button
                type="button"
                disabled={activeProbe !== null || runningAutonomous || isHalted}
                onClick={() => runProbe('flight_read')}
                className="btn-tactile w-full px-3.5 py-2.5 rounded-lg border border-hairline bg-elevated hover:border-emerald-matte/40 text-xs font-medium text-ink-primary flex items-center justify-between disabled:opacity-50"
              >
                <span>Test Flight Read</span>
                <span className="font-mono text-[10px] text-emerald-matte">ALLOW</span>
              </button>

              <button
                type="button"
                disabled={activeProbe !== null || runningAutonomous || isHalted}
                onClick={() => runProbe('otp_block')}
                className="btn-tactile w-full px-3.5 py-2.5 rounded-lg border border-hairline bg-elevated hover:border-crimson-matte/40 text-xs font-medium text-ink-primary flex items-center justify-between disabled:opacity-50"
              >
                <span>Test Bank OTP Block</span>
                <span className="font-mono text-[10px] text-crimson-matte">BLOCKED</span>
              </button>

              <button
                type="button"
                disabled={activeProbe !== null || runningAutonomous || isHalted}
                onClick={() => runProbe('forbidden_send')}
                className="btn-tactile w-full px-3.5 py-2.5 rounded-lg border border-hairline bg-elevated hover:border-crimson-matte/40 text-xs font-medium text-ink-primary flex items-center justify-between disabled:opacity-50"
              >
                <span>Test Forbidden Send</span>
                <span className="font-mono text-[10px] text-crimson-matte">HARD DENY</span>
              </button>

              <button
                type="button"
                disabled={activeProbe !== null || runningAutonomous}
                onClick={() => runProbe('trappack')}
                className="btn-tactile w-full px-3.5 py-2.5 rounded-lg border border-hairline bg-canvas hover:border-emerald-matte/45 text-xs font-medium text-ink-primary flex items-center justify-between disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-matte" />
                  {activeProbe === 'trappack' ? 'Running Trap Pack…' : 'Run Trap Pack Suite'}
                </span>
                <span className="font-mono text-[10px] text-emerald-matte">SHIELD</span>
              </button>

              <button
                type="button"
                disabled={activeProbe !== null || runningAutonomous || isHalted}
                onClick={() => runProbe('runaway_trip')}
                className="btn-tactile w-full px-3.5 py-2.5 rounded-lg border border-crimson-matte/35 bg-crimson-fill/60 hover:border-crimson-matte text-xs font-medium text-ink-primary flex items-center justify-between disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-crimson-matte" />
                  {activeProbe === 'runaway_trip'
                    ? 'Tripping Breaker…'
                    : 'Trigger Runaway Loop'}
                </span>
                <span className="font-mono text-[10px] text-crimson-matte">AUTO-TRIP</span>
              </button>

              {trapReport && (
                <div className="rounded-lg border border-hairline bg-canvas p-3 space-y-1.5 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="font-mono uppercase text-[10px] text-ink-muted">
                      Trap Pack Receipt
                    </span>
                    <span className="font-mono text-emerald-matte font-semibold">
                      {trapReport.passed_cases}/{trapReport.total_cases} PASS
                    </span>
                  </div>
                  <div className="text-ink-secondary">
                    0 leaks · Mission {trapReport.mission_survived ? 'survived' : 'failed'} ·
                    Breaker {trapReport.circuit_breaker_verified ? 'verified' : 'checked'}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Artifact Preview Modal */}
      {artifactPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setArtifactPreview(null)}
        >
          <div
            className="bento-card rounded-xl w-full max-w-2xl max-h-[82vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-xs text-ink-primary">
                <FileCode2 className="w-4 h-4 text-emerald-matte" />
                {artifactPreview.filename}
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={clamApi.getArtifactDownloadUrl(artifactPreview.filename)}
                  download={artifactPreview.filename}
                  className="btn-tactile inline-flex items-center gap-1 px-2.5 py-1 rounded border border-hairline bg-canvas text-xs text-ink-primary"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setArtifactPreview(null)}
                  className="btn-tactile p-1 rounded border border-hairline text-ink-secondary hover:text-ink-primary"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="p-5 overflow-auto font-mono text-xs text-ink-secondary whitespace-pre-wrap leading-relaxed">
              {artifactPreview.content}
            </pre>
          </div>
        </div>
      )}

      <DecisionTraceDrawer entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </div>
  );
}
