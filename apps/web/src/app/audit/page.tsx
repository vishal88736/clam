'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Search, ShieldCheck } from 'lucide-react';
import type { AgentRecord, AuditLogEntry } from '@clam/shared';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { DecisionTraceDrawer } from '@/components/DecisionTraceDrawer';
import { clamApi } from '@/lib/api';

export default function AuditLedgerPage() {
  const { lastEventTick } = useConsole();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState('');
  const [decision, setDecision] = useState('');
  const [tool, setTool] = useState('');
  const [range, setRange] = useState<'all' | '1h' | '24h' | '7d'>('all');

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void clamApi.getAgents().then((res) => setAgents(res.agents));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const loadLogs = useCallback(async () => {
    let fromIso: string | undefined;
    const now = Date.now();
    if (range === '1h') fromIso = new Date(now - 3600_000).toISOString();
    else if (range === '24h') fromIso = new Date(now - 86_400_000).toISOString();
    else if (range === '7d') fromIso = new Date(now - 7 * 86_400_000).toISOString();

    const res = await clamApi.getAuditLogs({
      agent_id: agentId || undefined,
      decision: decision || undefined,
      mcp_tool: tool || undefined,
      from: fromIso,
      search: search || undefined,
      limit: 200,
    });
    setLogs(res.logs);
  }, [agentId, decision, tool, range, search]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs, lastEventTick]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-display text-ink-primary">
            Forensic Metadata Ledger
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            Append-only inspection log. Strictly zero email subjects, bodies, or sender addresses stored.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start">
          <a
            href={clamApi.getAuditExportUrl({
              agent_id: agentId || undefined,
              decision: decision || undefined,
              mcp_tool: tool || undefined,
            })}
            download="clam-trace.jsonl"
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSONL Trace
          </a>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-matte/25 bg-emerald-fill text-emerald-matte text-xs font-mono">
            <ShieldCheck className="w-3.5 h-3.5" />
            0 Content Bytes Retained
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="bento-card rounded-xl p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-2.5">
        <div className="relative sm:col-span-2">
          <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            ref={searchRef}
            aria-label="Search audit log"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rule citation, scope, or hash ( / )"
            className="w-full rounded-md border border-hairline bg-canvas pl-8 pr-3 py-1.5 text-xs text-ink-primary focus:outline-none focus:border-ink-muted"
          />
        </div>

        <select
          aria-label="Filter by agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-ink-primary"
        >
          <option value="">All Agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-ink-primary"
        >
          <option value="">All Decisions</option>
          <option value="ALLOW">ALLOW</option>
          <option value="DENY">DENY</option>
          <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
          <option value="APPROVED">APPROVED</option>
          <option value="REJECTED">REJECTED</option>
          <option value="EXPIRED">EXPIRED</option>
          <option value="KILL_SWITCH_ENGAGED">KILL_SWITCH_ENGAGED</option>
          <option value="CIRCUIT_BREAKER_TRIPPED">CIRCUIT_BREAKER_TRIPPED</option>
          <option value="KILL_SWITCH_RESUMED">KILL_SWITCH_RESUMED</option>
        </select>

        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2 sm:col-span-2">
          <select
            aria-label="Filter by tool"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            className="rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs font-mono text-ink-primary"
          >
            <option value="">All Tools</option>
            <option value="list_emails">list_emails</option>
            <option value="search_emails">search_emails</option>
            <option value="read_email">read_email</option>
            <option value="create_draft">create_draft</option>
            <option value="send_email">send_email</option>
            <option value="archive_email">archive_email</option>
            <option value="apply_label">apply_label</option>
            <option value="delete_email">delete_email</option>
            <option value="save_itinerary_artifact">save_itinerary_artifact</option>
            <option value="killswitch.engage">killswitch.engage</option>
          </select>

          <select
            aria-label="Filter by time range"
            value={range}
            onChange={(e) => setRange(e.target.value as 'all' | '1h' | '24h' | '7d')}
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink-primary"
          >
            <option value="all">All Time</option>
            <option value="1h">1h</option>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
          </select>
        </div>
      </div>

      {/* Dense Forensic Table */}
      <div className="bento-card rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-hairline bg-canvas/70 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="py-2.5 px-4 font-medium">Timestamp</th>
                <th className="py-2.5 px-4 font-medium">Agent</th>
                <th className="py-2.5 px-4 font-medium">Tool</th>
                <th className="py-2.5 px-4 font-medium">Decision</th>
                <th className="py-2.5 px-4 font-medium">Category</th>
                <th className="py-2.5 px-4 font-medium text-right">Inj Risk</th>
                <th className="py-2.5 px-4 font-medium text-right">Conf</th>
                <th className="py-2.5 px-4 font-medium">Message Hash</th>
                <th className="py-2.5 px-4 font-medium text-right">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-ink-muted">
                    No matching audit records.
                  </td>
                </tr>
              ) : (
                logs.map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => setSelectedEntry(entry)}
                    className="hover:bg-elevated/60 cursor-pointer transition-colors duration-150"
                  >
                    <td className="py-2.5 px-4 font-mono text-[11px] text-ink-secondary tabular-nums whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-ink-primary whitespace-nowrap">
                      {entry.agent_name}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] whitespace-nowrap">
                      {entry.mcp_tool}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <DecisionBadge decision={entry.decision} />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-ink-secondary whitespace-nowrap">
                      {entry.semantic_category ?? '—'}
                    </td>
                    <td
                      className={`py-2.5 px-4 font-mono text-[11px] tabular-nums text-right ${
                        entry.injection_risk_score >= 0.55
                          ? 'text-crimson-matte'
                          : 'text-ink-muted'
                      }`}
                    >
                      {Math.round((entry.injection_risk_score ?? 0) * 100)}%
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-ink-secondary tabular-nums text-right">
                      {entry.confidence !== null ? `${Math.round(entry.confidence * 100)}%` : '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-ink-muted tabular-nums">
                      {entry.message_id_hash ?? '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-ink-secondary tabular-nums text-right">
                      {entry.latency_ms}ms
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <DecisionTraceDrawer entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </div>
  );
}
