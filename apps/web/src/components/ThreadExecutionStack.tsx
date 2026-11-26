'use client';

import { ArrowUpRight, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ThreadReplay } from '@clam/shared';

const label = (value: string) => value.replace(/_/g, ' ').toLowerCase();
const readable = (date: string) => new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statusText = (status: string, tool: string) => {
  if (status === 'VERIFIED') return ['green', ['handoff_to_agent_inbox', 'reply_to_message', 'send_message', 'reply_message'].includes(tool) ? '✓ Verified sent' : '✓ Verified'];
  if (status === 'PENDING_APPROVAL') return ['amber', 'Pending approval'];
  if (status === 'LOOP_HALTED' || status === 'HALTED') return ['red', '✕ Halted'];
  return ['neutral', label(status)];
};

export function ThreadExecutionStack({ revision, runId, onTrace }: {
  revision: number; runId?: string | null; onTrace: (runId: string, stepId: string) => void;
}) {
  const [threads, setThreads] = useState<ThreadReplay[] | null>(null);
  const [error, setError] = useState(false);
  const [preferred, setPreferred] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => setPreferred(new URLSearchParams(window.location.search).get('thread')), []);
  useEffect(() => {
    if (!preferred || focused.current) return;
    const item = document.getElementById('thread-' + preferred);
    if (item) {
      focused.current = true;
      item.scrollIntoView({ block: 'start' });
    }
  }, [preferred, threads]);
  useEffect(() => {
    const controller = new AbortController();
    const query = runId ? '?run_id=' + encodeURIComponent(runId) : '';
    void fetch('/api/inbox/threads' + query, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('THREAD_REPLAY_UNAVAILABLE');
        return response.json() as Promise<{ threads: ThreadReplay[] }>;
      }).then((result) => { setThreads(result.threads); setError(false); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision, runId]);

  return <section className="inbox-panel" aria-label="Thread execution stack">
    <h2><GitBranch size={18} /> Thread execution stack</h2>
    {error ? <p className="inbox-error" role="alert">Thread history could not be loaded.</p> : !threads ? <p>Loading thread history.</p> :
      !threads.length ? <p>Thread activity appears here after a run or a Pod handoff.</p> :
        <div className="thread-list">{threads.map((entry) => <details className="thread-item" id={'thread-' + entry.thread_id} key={entry.thread_id}
          open={preferred === entry.thread_id ? true : undefined}>
          <summary><strong>{entry.thread_id.replace(/[-_]/g, ' ')}</strong><span>{entry.hops.length} recorded steps</span></summary>
          <ol className="thread-stack">{entry.hops.map((hop, index) => {
            const action = hop.action && statusText(hop.action.status, hop.action.tool);
            return <li key={hop.step_id + ':' + index} className="thread-card">
              {hop.inbound && <div className="thread-card-main">
                <strong>{hop.inbound.sender}</strong>
                <time dateTime={hop.inbound.received_at}>{readable(hop.inbound.received_at)}</time>
                <span className="inbox-tag" data-tone={hop.inbound.trust_level === 'verified_agent_handoff' ? 'green' : 'neutral'}>
                  {hop.inbound.trust_level === 'verified_agent_handoff' ?
                    `Verified agent handoff · Hop ${hop.inbound.hop_count}/${hop.inbound.max_hops}` : 'Untrusted external'}
                </span>
                {hop.inbound.threat_signals.map((signal) => <span key={signal} className="inbox-tag" data-tone="red">{signal}</span>)}
              </div>}
              {hop.gate && <div className="thread-card-main">
                <span className="inbox-tag" data-tone={hop.gate.blocked ? 'red' : hop.gate.tier === 2 ? 'amber' : 'neutral'}>
                  {hop.gate.blocked ? 'Blocked' : 'Tier ' + hop.gate.tier}
                </span>
                <code>{hop.gate.rule_id}</code>
                {hop.gate.confidence !== null && <span>{Math.round(hop.gate.confidence * 100)}% confidence</span>}
                <small>Taint {label(hop.gate.taint)} · secret scan {label(hop.gate.secret_scan)}</small>
              </div>}
              {hop.action && action && <div className="thread-card-main">
                <strong>{label(hop.action.tool)}</strong>
                <span className="inbox-tag" data-tone={action[0]}>{action[1]}</span>
              </div>}
              <button type="button" className="inbox-text-link" onClick={() => onTrace(hop.run_id, hop.step_id)}>View trace step <ArrowUpRight size={14} /></button>
            </li>;
          })}</ol>
        </details>)}</div>}
  </section>;
}
