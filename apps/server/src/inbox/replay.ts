import type { ThreadReplay, ThreadReplayHop } from '@siftvane/shared';
import type { Mode } from './contracts.js';
import type { InboxStore } from './store.js';

const toolNames: Record<string, string> = {
  calendar: 'update_calendar_event', send: 'reply_to_message', draft: 'create_draft',
  handoff: 'handoff_to_agent_inbox', mail: 'update_message_labels', bill: 'record_bill',
  commitment: 'record_commitment', delivery: 'record_delivery', newsletter: 'add_to_digest', review: 'request_approval',
};
const toolName = (action: unknown) => toolNames[String(action)] ?? String(action ?? 'inbox_action');

export function threadReplay(store: InboxStore, mode: Mode, runId?: string): ThreadReplay[] {
  const history = store.runs(mode);
  const recent = history.slice(0, 30);
  if (runId && !recent.some((run) => run.id === runId)) {
    const older = store.run(runId);
    if (older?.mode === mode) recent.push(older);
  }
  const runs = recent.reverse();
  const threads = new Map<string, ThreadReplayHop[]>();
  for (const run of runs) {
    const sources = new Map<string, string>();
    const actions = new Map<string, { thread: string; action: unknown }>();
    for (const step of store.trace(run.id).steps) {
      const detail = step.detail;
      const base = { run_id: step.run_id, step_id: step.id, timestamp: step.timestamp };
      const push = (thread: string, row: Omit<ThreadReplayHop, keyof typeof base>) => {
        const list = threads.get(thread) ?? [];
        list.push({ ...base, ...row });
        threads.set(thread, list);
      };
      if (step.stage === 'PLAN' && Array.isArray(detail.sources)) {
        for (const message of detail.sources) {
          if (typeof message?.msg_id !== 'string') continue;
          const thread = String(message.thread_id ?? message.msg_id);
          sources.set(message.msg_id, thread);
          push(thread, { inbound: {
            sender: String(message.sender ?? 'Sender recorded in mailbox'), received_at: String(message.received_at ?? step.timestamp),
            trust_level: 'untrusted_external', threat_signals: Array.isArray(message.rule_ids) ? message.rule_ids.map(String) : [],
          } });
        }
      }
      const claim = actions.get(String(detail.action_id));
      const thread = typeof detail.thread_id === 'string' ? detail.thread_id : sources.get(String(detail.source_msg_id)) ?? claim?.thread;
      if (!thread) continue;
      if (step.stage === 'PLAN' && detail.inbound && typeof detail.inbound === 'object') {
        push(thread, { inbound: detail.inbound as ThreadReplayHop['inbound'] });
      }
      if (step.stage === 'POLICY' && typeof detail.rule_id === 'string') {
        const rule = detail.rule_id;
        const blocked = detail.decision === 'BLOCKED';
        push(thread, { gate: {
          rule_id: rule, blocked, tier: Number(detail.tier ?? 2), confidence: typeof detail.confidence === 'number' ? detail.confidence : null,
          taint: String(detail.taint ?? (rule.startsWith('TAINT_') ? 'Blocked' : 'Checked by policy')),
          secret_scan: String(detail.secret_scan ?? (rule === 'OUTBOUND_CONTENT_BLOCKED' ? 'Blocked' :
            blocked ? 'Not reached' : ['send','draft','handoff'].includes(String(detail.action)) ? 'Passed' : 'Not applicable')),
        }, ...(detail.decision === 'APPROVAL_REQUIRED' ? { action: { tool: toolName(detail.action), status: 'PENDING_APPROVAL' } } : {}) });
      }
      if (step.stage === 'ACT' && typeof detail.action_id === 'string') actions.set(detail.action_id, { thread, action: detail.action });
      if (step.stage === 'CHECK' && typeof detail.outcome === 'string') {
        push(thread, { action: { tool: run.mcp_caller?.tool ?? toolName(detail.action ?? claim?.action), status: detail.outcome } });
      }
    }
  }
  return [...threads.entries()].reverse().filter(([, hops]) => !runId || hops.some((hop) => hop.run_id === runId))
    .slice(0, 24).map(([thread_id, hops]) => ({ thread_id, hops }));
}

export function capabilityCounts(store: InboxStore, mode: Mode) {
  const scalar = (sql: string, ...args: string[]) => Number(store.sqlite.prepare(sql).get(...args)?.n ?? 0);
  const actions = (where: string) => scalar(`SELECT count(*) AS n FROM inbox_actions WHERE mode=? AND ${where}`, mode);
  const batchRun = `SELECT run_id FROM inbox_steps WHERE json_extract(body,'$.detail.batch')=1`;
  const recentThreads = scalar(`SELECT count(DISTINCT id) AS n FROM (
    SELECT coalesce(json_extract(source.value,'$.thread_id'),json_extract(source.value,'$.msg_id')) AS id
    FROM inbox_runs r JOIN inbox_steps s ON s.run_id=r.id, json_each(s.body,'$.detail.sources') source WHERE r.mode=?
    UNION ALL SELECT json_extract(s.body,'$.detail.thread_id') FROM inbox_steps s JOIN inbox_runs r ON s.run_id=r.id WHERE r.mode=?
  )`, mode, mode);
  const pendingBatches = scalar(`SELECT count(*) AS n FROM inbox_approvals a JOIN inbox_runs r ON a.run_id=r.id
    WHERE r.mode=? AND a.status='PENDING' AND json_extract(a.body,'$.expires_at')>? AND a.run_id IN (${batchRun})`,
    mode, new Date().toISOString());
  return {
    threads: recentThreads,
    verified_replies: actions("kind='send' AND status='VERIFIED' AND json_extract(body,'$.plan.threadId') IS NOT NULL"),
    batch_sends: scalar(`SELECT count(DISTINCT coalesce(ap.run_id,a.run_id)) AS n FROM inbox_actions a
      JOIN inbox_runs r ON a.run_id=r.id LEFT JOIN inbox_approvals ap ON json_extract(r.body,'$.trigger')='approval:' || ap.id
      WHERE a.mode=? AND a.kind='send' AND a.status='VERIFIED' AND coalesce(ap.run_id,a.run_id) IN (${batchRun})`, mode),
    pending_batch_approvals: pendingBatches,
    parsed_attachments: scalar("SELECT count(*) AS n FROM inbox_capability_events WHERE mode=? AND capability='attachment'", mode),
    quarantined_threats: actions("kind='mail' AND status='VERIFIED' AND json_extract(body,'$.plan.playbook')='hostile_input_quarantine'"),
    verified_calendar_mutations: actions("kind='calendar' AND status IN ('VERIFIED','ROLLED_BACK')"),
    calendar_rollbacks: actions("kind='calendar' AND status='ROLLED_BACK'"),
    service_verifications: scalar('SELECT count(*) AS n FROM verification_consumptions WHERE inbox_id=?', mode.startsWith('live:') ? mode.slice(5) : mode),
    signed_handoffs: mode === 'sandbox' ? scalar("SELECT count(*) AS n FROM agent_handoffs WHERE status IN ('DELIVERED','COMPLETED')") : 0,
    prevented_loops: mode === 'sandbox' ? scalar("SELECT count(*) AS n FROM agent_handoffs WHERE status='LOOP_HALTED'") : 0,
  };
}
