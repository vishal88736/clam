'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Clock, Edit3, ShieldCheck, X } from 'lucide-react';
import type { ApprovalView } from '@clam/shared';
import { useConsole } from '@/components/ConsoleContext';
import { DecisionBadge } from '@/components/DecisionBadge';
import { clamApi } from '@/lib/api';

function formatCountdown(expiresAt: string, nowMs: number): string {
  const diff = Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

export default function ApprovalsPage() {
  const { lastEventTick, refreshOverview } = useConsole();
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ to: string; subject: string; body: string }>({
    to: '',
    subject: '',
    body: '',
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  const loadApprovals = useCallback(async () => {
    const res = await clamApi.getApprovals();
    setApprovals(res.approvals);
  }, []);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals, lastEventTick]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const pending = approvals.filter((a) => a.status === 'PENDING');
  const resolved = approvals.filter((a) => a.status !== 'PENDING');

  const handleApprove = useCallback(
    async (item: ApprovalView) => {
      setBusyId(item.id);
      try {
        const edited =
          editingId === item.id
            ? { to: editForm.to, subject: editForm.subject, body: editForm.body }
            : undefined;
        await clamApi.approveRequest(item.id, edited);
        setEditingId(null);
        await loadApprovals();
        await refreshOverview();
      } finally {
        setBusyId(null);
      }
    },
    [editingId, editForm, loadApprovals, refreshOverview]
  );

  const handleDeny = useCallback(
    async (item: ApprovalView) => {
      setBusyId(item.id);
      try {
        await clamApi.denyRequest(item.id);
        setEditingId(null);
        await loadApprovals();
        await refreshOverview();
      } finally {
        setBusyId(null);
      }
    },
    [loadApprovals, refreshOverview]
  );

  // Keyboard shortcuts: A = approve, D = deny, ArrowUp/ArrowDown = navigate
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (pending.length === 0) return;

      const target = pending[Math.min(selectedIdx, pending.length - 1)];
      if (!target) return;

      if (e.key.toLowerCase() === 'a') {
        e.preventDefault();
        void handleApprove(target);
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void handleDeny(target);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(pending.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pending, selectedIdx, handleApprove, handleDeny]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-display">Approval Queue</h1>
          <p className="text-sm text-ink-secondary mt-0.5">
            Stage C human-in-the-loop sign-off. Proposed payloads live encrypted in RAM and wipe upon resolution.
          </p>
        </div>
        <div className="text-[11px] font-mono text-ink-tertiary">
          Shortcuts: <span className="px-1.5 py-0.5 rounded border border-hairline bg-surface">A</span> Approve ·{' '}
          <span className="px-1.5 py-0.5 rounded border border-hairline bg-surface">D</span> Deny
        </div>
      </div>

      {/* Pending Requests */}
      {pending.length === 0 ? (
        <div className="border border-hairline rounded bg-surface p-10 text-center space-y-2">
          <div className="inline-flex p-2.5 rounded border border-hairline bg-canvas text-emerald-matte">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="text-sm font-medium text-ink-primary">No pending approvals</div>
          <p className="text-xs text-ink-secondary">
            Actions matching <span className="font-mono">ask_first_actions</span> will appear here in real time.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((item, idx) => {
            const focused = idx === selectedIdx;
            const isEditing = editingId === item.id;
            const preview = item.ephemeral_preview;

            return (
              <div
                key={item.id}
                onClick={() => setSelectedIdx(idx)}
                className={`border rounded bg-surface transition-colors duration-150 ${
                  focused ? 'border-ink-secondary' : 'border-hairline'
                }`}
              >
                <div className="grid grid-cols-1 lg:grid-cols-12">
                  {/* Left: Action & Preview */}
                  <div className="lg:col-span-8 p-4 lg:p-5 space-y-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <DecisionBadge decision={item.status} />
                        <span className="text-sm font-semibold">{item.agent_name}</span>
                        <span className="font-mono text-xs px-2 py-0.5 rounded border border-hairline bg-canvas">
                          {item.mcp_tool}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-xs text-amber-matte tabular-nums">
                        <Clock className="w-3.5 h-3.5" />
                        {formatCountdown(item.expires_at, nowMs)}
                      </div>
                    </div>

                    <div className="px-3 py-2 rounded border border-hairline bg-canvas text-xs text-ink-secondary">
                      <span className="font-mono uppercase text-[10px] text-ink-tertiary mr-2">
                        Trigger Rule
                      </span>
                      “{item.rule_citation}”
                    </div>

                    {preview && (
                      <div className="border border-hairline rounded bg-canvas p-3.5 space-y-2 text-xs">
                        {isEditing ? (
                          <div className="space-y-2">
                            <input
                              value={editForm.to}
                              onChange={(e) =>
                                setEditForm((f) => ({ ...f, to: e.target.value }))
                              }
                              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs"
                              placeholder="To"
                            />
                            <input
                              value={editForm.subject}
                              onChange={(e) =>
                                setEditForm((f) => ({ ...f, subject: e.target.value }))
                              }
                              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs"
                              placeholder="Subject"
                            />
                            <textarea
                              rows={4}
                              value={editForm.body}
                              onChange={(e) =>
                                setEditForm((f) => ({ ...f, body: e.target.value }))
                              }
                              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-xs"
                            />
                          </div>
                        ) : (
                          <>
                            {preview.to && (
                              <div>
                                <span className="text-ink-tertiary font-mono mr-2">TO:</span>
                                <span className="text-ink-primary font-mono">{preview.to}</span>
                              </div>
                            )}
                            {preview.subject && (
                              <div>
                                <span className="text-ink-tertiary font-mono mr-2">SUBJECT:</span>
                                <span className="text-ink-primary font-medium">
                                  {preview.subject}
                                </span>
                              </div>
                            )}
                            {preview.label && (
                              <div>
                                <span className="text-ink-tertiary font-mono mr-2">LABEL:</span>
                                <span className="text-ink-primary font-mono">{preview.label}</span>
                              </div>
                            )}
                            {preview.body && (
                              <pre className="whitespace-pre-wrap font-sans text-xs text-ink-secondary pt-1 border-t border-hairline">
                                {preview.body}
                              </pre>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        onClick={() => handleApprove(item)}
                        disabled={busyId === item.id}
                        className="btn-primary inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-medium"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {isEditing ? 'Approve with Edit' : 'Approve'}
                      </button>

                      {preview && (preview.body !== undefined || preview.subject !== undefined) && (
                        <button
                          onClick={() => {
                            if (isEditing) {
                              setEditingId(null);
                            } else {
                              setEditingId(item.id);
                              setEditForm({
                                to: preview.to ?? '',
                                subject: preview.subject ?? '',
                                body: preview.body ?? '',
                              });
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-hairline bg-canvas text-xs text-ink-primary hover:bg-elevated"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          {isEditing ? 'Cancel Edit' : 'Edit Before Approve'}
                        </button>
                      )}

                      <button
                        onClick={() => handleDeny(item)}
                        disabled={busyId === item.id}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded border border-crimson-matte/30 bg-crimson-fill text-crimson-matte text-xs font-medium hover:opacity-90"
                      >
                        <X className="w-3.5 h-3.5" />
                        Deny
                      </button>
                    </div>
                  </div>

                  {/* Right: Channel Delivery Strip */}
                  <div className="lg:col-span-4 border-t lg:border-t-0 lg:border-l border-hairline bg-canvas p-4 lg:p-5 space-y-3">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-ink-tertiary">
                      Channel Dispatch Status
                    </div>
                    <div className="space-y-2 text-xs">
                      {(
                        [
                          ['In-App Queue', item.delivery_status.app],
                          ['Slack', item.delivery_status.slack],
                          ['Telegram', item.delivery_status.telegram],
                          ['WhatsApp', item.delivery_status.whatsapp],
                        ] as const
                      ).map(([label, st]) => (
                        <div
                          key={label}
                          className="flex items-center justify-between px-3 py-2 rounded border border-hairline bg-surface"
                        >
                          <span className="font-medium text-ink-primary">{label}</span>
                          <span
                            className={`font-mono text-[11px] uppercase ${
                              st.status === 'delivered'
                                ? 'text-emerald-matte'
                                : st.status === 'failed'
                                  ? 'text-crimson-matte'
                                  : 'text-ink-tertiary'
                            }`}
                            title={st.detail}
                          >
                            {st.status === 'not_configured' ? 'unconfigured' : st.status}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="text-[11px] font-mono text-ink-tertiary pt-1">
                      Ticket: {item.id}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolved History */}
      {resolved.length > 0 && (
        <div className="border border-hairline rounded bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
            <h2 className="text-sm font-medium">Resolved & Expired History</h2>
            <span className="text-[11px] font-mono text-emerald-matte">
              All resolved payloads wiped from RAM
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-hairline bg-canvas font-mono text-[11px] uppercase text-ink-tertiary">
                  <th className="py-2.5 px-4 font-medium">Ticket</th>
                  <th className="py-2.5 px-4 font-medium">Agent</th>
                  <th className="py-2.5 px-4 font-medium">Tool</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">Channel</th>
                  <th className="py-2.5 px-4 font-medium">Memory State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {resolved.slice(0, 25).map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary tabular-nums">
                      {r.id}
                    </td>
                    <td className="py-2.5 px-4 font-medium">{r.agent_name}</td>
                    <td className="py-2.5 px-4 font-mono">{r.mcp_tool}</td>
                    <td className="py-2.5 px-4">
                      <DecisionBadge decision={r.status} />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-secondary">
                      {r.resolved_by ?? '—'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-emerald-matte">
                      {r.payload_wiped ? 'WIPED FROM RAM' : 'ACTIVE'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
