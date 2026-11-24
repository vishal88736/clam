'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Play,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { AuditLogEntry } from '@clam/shared';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { DecisionTraceDrawer } from '@/components/DecisionTraceDrawer';
import { API_BASE, clamApi } from '@/lib/api';

export default function OverviewPage() {
  const { overview, liveFeed, sseConnected, refreshOverview } = useConsole();
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeNotice, setProbeNotice] = useState<string | null>(null);

  const metrics = overview?.metrics ?? {
    total_intercepted: 0,
    allowed: 0,
    blocked: 0,
    pending_decisions: 0,
  };

  const total = Math.max(1, metrics.allowed + metrics.blocked + (overview?.pending_approvals_count ?? 0));
  const allowPct = Math.round((metrics.allowed / total) * 100);
  const blockPct = Math.round((metrics.blocked / total) * 100);
  const pendingPct = Math.max(0, 100 - allowPct - blockPct);

  async function runLiveMcpProbe() {
    setProbing(true);
    setProbeNotice(null);
    let tokenId: string | null = null;
    try {
      const issued = await clamApi.issueToken('ag_travel', 'Console Live Probe');
      tokenId = issued.token.id;
      const mcpHeaders = {
        Authorization: `Bearer ${issued.raw_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };

      // 1. Call list_emails (returns only travel emails; silently filters OTP, bank alerts, medical)
      await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_emails', arguments: { maxResults: 10 } },
        }),
      });

      // 2. Attempt unauthorized direct read of bank OTP
      await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'read_email', arguments: { messageId: 'msg_otp_bank_06' } },
        }),
      });

      // 3. Attempt send_email (deterministically blocked by "Never send.")
      await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'send_email',
            arguments: {
              to: 'kenji.host@airbnb-messages.example',
              subject: 'Arrival time',
              body: 'Arriving at 4 PM.',
            },
          },
        }),
      });

      // 4. Create draft reply to host (triggers Stage C HITL "ask me first")
      await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'create_draft',
            arguments: {
              to: 'kenji.host@airbnb-messages.example',
              subject: 'Re: Reservation HM8842ZQ91 — Arrival instructions',
              body: 'Hi Kenji, my train arrives around 3:30 PM on Dec 20. Looking forward to staying at Cedar Machiya!',
              threadId: 'thr_hotel_airbnb_03',
            },
          },
        }),
      });

      setProbeNotice(
        'Executed real MCP JSON-RPC calls (list_emails, read_email OTP block, send_email hard-deny, create_draft HITL ticket).'
      );
      await refreshOverview();
    } catch (err) {
      setProbeNotice(err instanceof Error ? err.message : 'Probe failed');
    } finally {
      if (tokenId) {
        await clamApi.revokeToken('ag_travel', tokenId).catch(() => {});
      }
      setProbing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-display text-ink-primary">
            Live Firewall Overview
          </h1>
          <p className="text-sm text-ink-secondary mt-0.5">
            Real-time Model Context Protocol interception, semantic filtering, and HITL enforcement.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={runLiveMcpProbe}
            disabled={probing}
            className="btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 rounded text-xs font-medium"
          >
            <Play className="w-3.5 h-3.5" />
            {probing ? 'Running MCP Probe…' : 'Run Live MCP Probe'}
          </button>
          <Link
            href="/agents"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded border border-hairline bg-surface text-xs font-medium text-ink-primary hover:bg-elevated transition-colors duration-150"
          >
            Rules Studio
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {probeNotice && (
        <div className="px-4 py-2.5 rounded border border-hairline bg-surface text-xs text-ink-secondary flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-emerald-matte shrink-0" />
            {probeNotice}
          </span>
          {(overview?.pending_approvals_count ?? 0) > 0 && (
            <Link
              href="/approvals"
              className="text-amber-matte font-medium hover:underline whitespace-nowrap"
            >
              Review Approval Queue →
            </Link>
          )}
        </div>
      )}

      {/* 4-Metric Strip */}
      <div className="border border-hairline rounded bg-surface">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-hairline">
          <div className="p-4 lg:p-5">
            <div className="text-xs text-ink-secondary font-medium">Requests Intercepted</div>
            <div className="mt-2 text-2xl font-semibold font-mono tabular-nums tracking-display">
              {metrics.total_intercepted}
            </div>
            <div className="text-[11px] font-mono text-ink-tertiary mt-1">
              Total MCP evaluations
            </div>
          </div>

          <div className="p-4 lg:p-5">
            <div className="text-xs text-ink-secondary font-medium">Allowed</div>
            <div className="mt-2 text-2xl font-semibold font-mono tabular-nums tracking-display text-emerald-matte">
              {metrics.allowed}
            </div>
            <div className="text-[11px] font-mono text-ink-tertiary mt-1">
              In-scope semantic pass
            </div>
          </div>

          <div className="p-4 lg:p-5">
            <div className="text-xs text-ink-secondary font-medium">Blocked</div>
            <div className="mt-2 text-2xl font-semibold font-mono tabular-nums tracking-display text-crimson-matte">
              {metrics.blocked}
            </div>
            <div className="text-[11px] font-mono text-ink-tertiary mt-1">
              Default-deny & hard gates
            </div>
          </div>

          <div className="p-4 lg:p-5">
            <div className="text-xs text-ink-secondary font-medium">Pending Approval</div>
            <div className="mt-2 text-2xl font-semibold font-mono tabular-nums tracking-display text-amber-matte">
              {overview?.pending_approvals_count ?? 0}
            </div>
            <div className="text-[11px] font-mono text-ink-tertiary mt-1">
              Awaiting human sign-off
            </div>
          </div>
        </div>

        {/* Crisp Matte Ratio Bar */}
        <div className="px-4 lg:px-5 py-2.5 border-t border-hairline flex items-center gap-3">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary whitespace-nowrap">
            Decision Mix
          </span>
          <div className="flex-1 h-1.5 rounded-sm bg-canvas overflow-hidden flex">
            {metrics.total_intercepted > 0 ? (
              <>
                <div
                  className="bg-emerald-matte transition-all duration-150"
                  style={{ width: `${allowPct}%` }}
                />
                <div
                  className="bg-crimson-matte transition-all duration-150"
                  style={{ width: `${blockPct}%` }}
                />
                <div
                  className="bg-amber-matte transition-all duration-150"
                  style={{ width: `${pendingPct}%` }}
                />
              </>
            ) : (
              <div className="w-full bg-hairline" />
            )}
          </div>
          <span className="text-[11px] font-mono text-ink-secondary tabular-nums whitespace-nowrap">
            {metrics.total_intercepted > 0
              ? `${allowPct}% allow · ${blockPct}% block`
              : 'No traffic yet'}
          </span>
        </div>
      </div>

      {/* Pending HITL Callout if active */}
      {(overview?.pending_approvals_count ?? 0) > 0 && (
        <div className="px-4 py-3 rounded border border-amber-matte/30 bg-amber-fill flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs">
            <ShieldAlert className="w-4 h-4 text-amber-matte shrink-0" />
            <span className="text-ink-primary font-medium">
              {overview?.pending_approvals_count} action
              {overview?.pending_approvals_count === 1 ? '' : 's'} paused at Stage C HITL gate.
            </span>
            <span className="text-ink-secondary hidden sm:inline">
              Ephemeral action payloads are sealed in RAM pending approval or expiry.
            </span>
          </div>
          <Link
            href="/approvals"
            className="px-2.5 py-1 rounded border border-amber-matte/40 text-amber-matte text-xs font-medium hover:bg-amber-matte/10 whitespace-nowrap"
          >
            Open Queue
          </Link>
        </div>
      )}

      {/* Live Interception Feed */}
      <div className="border border-hairline rounded bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseConnected ? 'bg-emerald-matte' : 'bg-amber-matte'
              }`}
            />
            <h2 className="text-sm font-medium text-ink-primary">Live Interception Feed</h2>
            <span className="text-[11px] font-mono text-ink-tertiary">
              Click any row to inspect trace
            </span>
          </div>
          <Link
            href="/audit"
            className="text-xs text-ink-secondary hover:text-ink-primary font-medium"
          >
            Full Audit Ledger →
          </Link>
        </div>

        {liveFeed.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="inline-flex p-2.5 rounded border border-hairline bg-canvas text-ink-secondary">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="text-sm font-medium text-ink-primary">
              Firewall armed — waiting for MCP traffic
            </div>
            <p className="text-xs text-ink-secondary max-w-md mx-auto leading-relaxed">
              Connect Claude Desktop, Codex, or Gemini CLI via <span className="font-mono">/mcp</span>,
              or click <strong>Run Live MCP Probe</strong> above to execute real protocol requests
              against the Sandbox inbox.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-hairline bg-canvas text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                  <th className="py-2.5 px-4 font-medium">Time</th>
                  <th className="py-2.5 px-4 font-medium">Agent</th>
                  <th className="py-2.5 px-4 font-medium">Tool</th>
                  <th className="py-2.5 px-4 font-medium">Verdict</th>
                  <th className="py-2.5 px-4 font-medium">Rule / Scope</th>
                  <th className="py-2.5 px-4 font-medium text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline text-xs">
                {liveFeed.slice(0, 20).map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => setSelectedEntry(entry)}
                    className="hover:bg-elevated/60 cursor-pointer transition-colors duration-150"
                  >
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-ink-primary whitespace-nowrap">
                      {entry.agent_name}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-primary whitespace-nowrap">
                      {entry.mcp_tool}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <DecisionBadge decision={entry.decision} />
                    </td>
                    <td className="py-2.5 px-4 text-ink-secondary max-w-md truncate">
                      {entry.semantic_category && (
                        <span className="font-mono text-ink-primary mr-2">
                          [{entry.semantic_category}]
                        </span>
                      )}
                      {entry.rule_citation}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums text-right whitespace-nowrap">
                      {entry.latency_ms}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DecisionTraceDrawer entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </div>
  );
}
