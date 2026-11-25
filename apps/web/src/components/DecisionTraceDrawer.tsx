'use client';

import React from 'react';
import { ShieldCheck, X } from 'lucide-react';
import type { AuditLogEntry } from '@clam/shared';
import { DecisionBadge } from './DecisionBadge';

export function DecisionTraceDrawer({
  entry,
  onClose,
}: {
  entry: AuditLogEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55"
      onClick={onClose}
      role="dialog"
      aria-label="Decision Trace"
    >
      <div
        className="w-full max-w-md bg-surface border-l border-hairline h-full flex flex-col justify-between overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <div className="flex items-center justify-between px-5 py-4 border-b border-hairline">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted">
                Decision Trace
              </div>
              <div className="text-sm font-medium text-ink-primary font-mono mt-0.5 tabular-nums">
                {entry.id}
              </div>
            </div>
            <button
              onClick={onClose}
              className="btn-tactile p-1.5 rounded-md border border-hairline text-ink-secondary hover:text-ink-primary hover:bg-elevated"
              aria-label="Close trace drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            <div className="flex items-center justify-between">
              <DecisionBadge decision={entry.decision} />
              <span className="font-mono text-xs text-ink-secondary tabular-nums">
                {entry.latency_ms} ms
              </span>
            </div>

            <div className="rounded-lg border border-hairline bg-canvas p-3.5 space-y-2">
              <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted">
                Rule Citation
              </div>
              <p className="text-sm text-ink-primary leading-relaxed">
                {entry.rule_citation}
              </p>
              {entry.matched_rule_id && (
                <div className="text-xs font-mono text-ink-secondary pt-1">
                  Rule ID: <span className="text-ink-primary">{entry.matched_rule_id}</span>
                </div>
              )}
            </div>

            <dl className="divide-y divide-hairline rounded-lg border border-hairline bg-canvas">
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Trace ID</dt>
                <dd className="font-mono text-ink-primary tabular-nums">{entry.trace_id}</dd>
              </div>
              {entry.run_id && (
                <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                  <dt className="text-ink-secondary">Run ID</dt>
                  <dd className="font-mono text-ink-primary tabular-nums">{entry.run_id}</dd>
                </div>
              )}
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Agent</dt>
                <dd className="font-medium text-ink-primary">{entry.agent_name}</dd>
              </div>
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">MCP Tool</dt>
                <dd className="font-mono text-ink-primary">{entry.mcp_tool}</dd>
              </div>
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Semantic Category</dt>
                <dd className="font-mono text-ink-primary">
                  {entry.semantic_category ?? '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Injection Risk</dt>
                <dd
                  className={`font-mono tabular-nums ${
                    entry.injection_risk_score >= 0.55
                      ? 'text-crimson-matte'
                      : 'text-ink-secondary'
                  }`}
                >
                  {Math.round((entry.injection_risk_score ?? 0) * 100)}%
                </dd>
              </div>
              {entry.injection_signals?.length > 0 && (
                <div className="px-3.5 py-2.5 text-xs space-y-1.5">
                  <dt className="text-ink-secondary">Injection Signals</dt>
                  <dd className="flex flex-wrap gap-1">
                    {entry.injection_signals.map((sig) => (
                      <span
                        key={sig}
                        className="px-1.5 py-0.5 rounded bg-crimson-fill text-crimson-matte border border-crimson-matte/30 font-mono text-[10px]"
                      >
                        {sig}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Confidence Score</dt>
                <dd className="font-mono text-ink-primary tabular-nums">
                  {entry.confidence !== null
                    ? `${Math.round(entry.confidence * 100)}%`
                    : 'Deterministic (100%)'}
                </dd>
              </div>
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Message ID Hash</dt>
                <dd className="font-mono text-ink-secondary tabular-nums">
                  {entry.message_id_hash ?? '—'}
                </dd>
              </div>
              {entry.approval_id && (
                <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                  <dt className="text-ink-secondary">Approval Ticket</dt>
                  <dd className="font-mono text-amber-matte tabular-nums">
                    {entry.approval_id}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                <dt className="text-ink-secondary">Timestamp</dt>
                <dd className="font-mono text-ink-secondary tabular-nums">
                  {new Date(entry.timestamp).toLocaleString()}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="p-5 border-t border-hairline bg-canvas">
          <div className="flex items-start gap-2.5 text-xs text-ink-secondary">
            <ShieldCheck className="w-4 h-4 text-emerald-matte shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-ink-primary">Zero-Retention Confirmed</div>
              <p className="text-ink-muted mt-0.5 leading-relaxed">
                0 email subject, body, sender, or attachment bytes were written to disk or
                audit storage. Only the one-way HMAC message hash and policy metadata remain.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
