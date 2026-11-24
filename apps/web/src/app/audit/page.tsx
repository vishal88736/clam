'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ShieldCheck } from 'lucide-react';
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
          <h1 className="text-xl font-semibold tracking-display">Zero-Content Audit Ledger</h1>
          <p className="text-sm text-ink-secondary mt-0.5">
            Append-only metadata forensic ledger. Strictly zero subjects, bodies, or sender addresses stored.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-emerald-matte/25 bg-emerald-fill text-emerald-matte text-xs font-medium self-start">
          <ShieldCheck className="w-3.5 h-3.5" />
          0 Content Bytes Retained
        </span>
      </div>

      {/* Filters */}
      <div className="border border-hairline rounded bg-surface p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
        <div className="relative lg:col-span-2">
          <Search className="w-3.5 h-3.5 text-ink-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rule citation, scope, or hash ( / )"
            className="w-full rounded border border-hairline bg-canvas pl-8 pr-3 py-1.5 text-xs text-ink-primary focus:outline-none focus:border-ink-secondary"
          />
        </div>

        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-ink-primary"
        >
          <option value="">All Agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="rounded border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-ink-primary"
        >
          <option value="">All Decisions</option>
          <option value="ALLOW">ALLOW</option>
          <option value="DENY">DENY</option>
          <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
          <option value="APPROVED">APPROVED</option>
          <option value="REJECTED">REJECTED</option>
          <option value="EXPIRED">EXPIRED</option>
        </select>

        <div className="flex gap-2">
          <select
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            className="flex-1 rounded border border-hairline bg-canvas px-2.5 py-1.5 text-xs font-mono text-ink-primary"
          >
            <option value="">All Tools</option>
            <option value="list_emails">list_emails</option>
            <option value="search_emails">search_emails</option>
            <option value="read_email">read_email</option>
            <option value="create_draft">create_draft</option>
            <option value="send_email">send_email</option>
            <option value="archive_email">archive_email</option>
            <option value="apply_label">apply_label</option>
          </select>

          <select
            value={range}
            onChange={(e) => setRange(e.target.value as 'all' | '1h' | '24h' | '7d')}
            className="rounded border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink-primary"
          >
            <option value="all">All Time</option>
            <option value="1h">1h</option>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
          </select>
        </div>
      </div>

      {/* Dense Forensic Table */}
      <div className="border border-hairline rounded bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-hairline bg-canvas font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
                <th className="py-2.5 px-4 font-medium">Timestamp</th>
                <th className="py-2.5 px-4 font-medium">Agent</th>
                <th className="py-2.5 px-4 font-medium">Tool</th>
                <th className="py-2.5 px-4 font-medium">Decision</th>
                <th className="py-2.5 px-4 font-medium">Category</th>
                <th className="py-2.5 px-4 font-medium text-right">Conf</th>
                <th className="py-2.5 px-4 font-medium">Message Hash</th>
                <th className="py-2.5 px-4 font-medium text-right">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-ink-tertiary">
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
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-ink-primary whitespace-nowrap">
                      {entry.agent_name}
                    </td>
                    <td className="py-2.5 px-4 font-mono whitespace-nowrap">{entry.mcp_tool}</td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <DecisionBadge decision={entry.decision} />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary whitespace-nowrap">
                      {entry.semantic_category ?? '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums text-right">
                      {entry.confidence !== null ? `${Math.round(entry.confidence * 100)}%` : '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-tertiary tabular-nums">
                      {entry.message_id_hash ?? '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums text-right">
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
