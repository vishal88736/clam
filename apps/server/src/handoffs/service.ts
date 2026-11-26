import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { handoffDefaults, handoffId, scanOutboundSecrets, scanPromptInjection, type HandoffInput } from '@clam/shared';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import type { InboxStore } from '../inbox/store.js';
import type { Snapshot } from '../inbox/contracts.js';
import { isPodCaseThread, podCase } from './sample.js';

export const podScopes = ['handoff:send', 'handoff:read', 'attachment:extract'] as const;
export type PodGrant = { tokenId: string; inboxId: string; scopes: string[] };
type Member = { id: string; pod_id: string; email: string; role: string };
type HandoffStatus = 'DELIVERED' | 'COMPLETED' | 'LOOP_HALTED' | 'REJECTED';
export type SignedHandoff = {
  id: string; pod_id: string; thread_id: string; from_inbox_id: string; to_inbox_id: string;
  hop_count: number; max_hops: number; task_summary: string; created_at: string;
  payload: { trust_level: 'untrusted_external'; data: Record<string, unknown>; attachment_ids: string[] };
  headers: Record<string, string>;
};
export type HandoffResult =
  | { status: 'DELIVERED'; thread_id: string; handoff_id: string; headers: Record<string, string>; trace_step_id: string }
  | { status: 'LOOP_HALTED'; thread_id: string; rule_id: string; approval_id: string; trace_step_id: string };
type StoredHandoff = Omit<SignedHandoff, 'payload' | 'headers'> & {
  ordinal: number; payload_json: string; status: HandoffStatus; trace_step_id: string | null;
};

export function handoffReceipt(message: SignedHandoff): Snapshot {
  return { handoff_id: message.id, thread_id: message.thread_id, hop_count: message.hop_count,
    max_hops: message.max_hops, payload_hash: handoffPayloadHash(message), status: 'DELIVERED' };
}

export function handoffPayloadHash(message: Omit<SignedHandoff, 'headers'>) {
  return sha256(canonicalJson({ id: message.id, max_hops: message.max_hops,
    task_summary: message.task_summary, created_at: message.created_at, ...message.payload }));
}

const protectedContent = /\b(?:verification code|one[- ]time code|magic link|sign.in link|password reset)\b/i;
function cleanPayload(payload: Record<string, unknown>) {
  const pending: { value: unknown; depth: number }[] = [{ value: payload, depth: 0 }];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { value, depth } = pending[cursor];
    if (depth > 6 || pending.length > 180) throw new Error('HANDOFF_PAYLOAD_TOO_COMPLEX');
    if (Array.isArray(value)) value.forEach((item) => pending.push({ value: item, depth: depth + 1 }));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__','constructor','prototype'].includes(key)) throw new Error('INVALID_HANDOFF_PAYLOAD');
        pending.push({ value: item, depth: depth + 1 });
      }
    }
  }
  if (Buffer.byteLength(canonicalJson(payload)) > 8192) throw new Error('HANDOFF_PAYLOAD_TOO_LARGE');
  const markUntrusted = (value: unknown): unknown => Array.isArray(value) ? value.map(markUntrusted) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, key.toLowerCase() === 'trust_level' ? 'untrusted_external' : markUntrusted(item)])) : value;
  return markUntrusted(payload) as Record<string, unknown>;
}

export class HandoffService {
  constructor(private readonly store: InboxStore, private readonly key: Buffer = randomBytes(32)) {}

  member(inboxId: string) {
    return this.store.sqlite.prepare('SELECT * FROM pod_inboxes WHERE id=?').get(inboxId) as Member | undefined;
  }

  members() {
    return this.store.sqlite.prepare('SELECT * FROM pod_inboxes ORDER BY rowid').all() as unknown as Member[];
  }

  provision(id: string) {
    const member = this.member(id);
    if (member) return member;
    const email = id + '@clam.local';
    this.store.sqlite.prepare("INSERT INTO pod_inboxes VALUES (?, 'sandbox-pod', ?, 'agent')").run(id, email);
    return this.member(id)!;
  }

  mint(inboxId: string, scopes: string[]) {
    if (!this.member(inboxId)) throw new Error('INBOX_NOT_AVAILABLE');
    if (!scopes.length || scopes.some((scope) => !podScopes.some((allowed) => scope === allowed))) throw new Error('MCP_SCOPE_REQUIRED');
    const token = 'clm_pod_' + randomBytes(32).toString('base64url');
    const expiry = Date.now() + 7 * 86_400_000;
    this.store.sqlite.prepare('INSERT INTO pod_mcp_tokens VALUES (?,?,?,?,?)')
      .run(sha256(token), randomUUID(), inboxId, JSON.stringify([...new Set(scopes)]), expiry);
    return { token, expires_at: new Date(expiry).toISOString() };
  }

  authenticate(token: string): PodGrant | undefined {
    if (!/^clm_pod_[\w-]{43}$/.test(token)) return undefined;
    const row = this.store.sqlite.prepare('SELECT * FROM pod_mcp_tokens WHERE token_hash=? AND expires_at>?').get(sha256(token), Date.now());
    if (!row) return undefined;
    return { tokenId: String(row.token_id), inboxId: String(row.inbox_id), scopes: JSON.parse(String(row.scopes)) as string[] };
  }

  private signature(message: Omit<SignedHandoff, 'headers'>) {
    const input = [message.pod_id, message.thread_id, message.from_inbox_id, message.to_inbox_id,
      message.hop_count, handoffPayloadHash(message)].join('|');
    return createHmac('sha256', this.key).update(input).digest('hex');
  }

  private headers(message: Omit<SignedHandoff, 'headers'>) {
    return {
      'X-Clam-Agent-Origin': message.from_inbox_id,
      'X-Clam-Handoff-Id': message.id,
      'X-Clam-Hop-Count': String(message.hop_count),
      'X-Clam-Max-Hops': String(message.max_hops),
      'X-Clam-Handoff-Sig': this.signature(message),
    };
  }

  verify(message: SignedHandoff) {
    if (message.payload.trust_level !== 'untrusted_external') return false;
    const expected = this.headers(message);
    return Object.entries(expected).every(([key, value]) => {
      const provided = message.headers[key];
      return typeof provided === 'string' && provided.length === value.length &&
        timingSafeEqual(Buffer.from(provided), Buffer.from(value));
    });
  }

  private rows(podId: string, threadId: string, after = 0) {
    return this.store.sqlite.prepare(`SELECT rowid AS ordinal,* FROM agent_handoffs WHERE pod_id=? AND thread_id=?
      AND rowid>? AND status IN ('DELIVERED','COMPLETED') ORDER BY rowid`)
      .all(podId, threadId, after) as unknown as StoredHandoff[];
  }

  prepare(caller: string, input: HandoffInput) {
    const from = this.member(input.from_inbox_id);
    const to = this.member(input.to_inbox_id);
    if (caller !== input.from_inbox_id || !from || !to || from.id === to.id || from.pod_id !== to.pod_id) {
      throw new Error('HANDOFF_INBOX_NOT_AUTHORIZED');
    }
    const thread = input.thread_id ? handoffId.parse(input.thread_id) : randomUUID();
    const at = new Date().toISOString();
    const reset = this.store.sqlite.prepare('SELECT max(after_row) AS marker FROM agent_handoff_resets WHERE pod_id=? AND thread_id=?')
      .get(from.pod_id, thread);
    const history = this.rows(from.pod_id, thread, Number(reset?.marker ?? 0));
    const paused = this.store.sqlite.prepare("SELECT 1 FROM agent_handoffs WHERE pod_id=? AND thread_id=? AND rowid>? AND status='LOOP_HALTED'")
      .get(from.pod_id, thread, Number(reset?.marker ?? 0));
    const last = history.at(-1);
    const owner = last ?? this.rows(from.pod_id, thread).at(-1);
    if ((owner && owner.to_inbox_id !== from.id) || (!owner && isPodCaseThread(thread) && from.id !== 'triage')) {
      throw new Error('HANDOFF_THREAD_NOT_AUTHORIZED');
    }
    const budget = last ? Math.min(last.max_hops, input.max_hops ?? last.max_hops) : input.max_hops ?? handoffDefaults.maxHops;
    const previous = last?.hop_count ?? 0;
    const [ab, ba] = history.slice(-2);
    // Stop the proposed A→B hop once A→B→A is already in the committed path.
    const pingPong = ab && ba && ab.from_inbox_id === from.id && ab.to_inbox_id === to.id &&
      ba.from_inbox_id === to.id && ba.to_inbox_id === from.id;
    const halted = previous >= budget || Boolean(pingPong || paused);
    const summary = input.task_summary.trim();
    const payload = { trust_level: 'untrusted_external' as const, data: cleanPayload(input.structured_payload), attachment_ids: input.attachment_ids ?? [] };
    const inspected = [summary, canonicalJson(payload.data)].join('\n');
    if (scanOutboundSecrets(inspected) || protectedContent.test(inspected) || scanPromptInjection(inspected).detected) {
      throw new Error('OUTBOUND_CONTENT_BLOCKED');
    }
    for (const id of payload.attachment_ids) {
      const seeded = id === podCase.attachmentId && isPodCaseThread(thread) && from.id === 'triage' &&
        this.store.sqlite.prepare('SELECT 1 FROM inbox_capability_events WHERE id=?').get('pod:' + thread + ':' + id);
      const forwarded = Boolean(owner && (JSON.parse(owner.payload_json) as { payload?: SignedHandoff['payload'] })
        .payload?.attachment_ids.includes(id));
      if (!seeded && !forwarded) throw new Error('TAINT_DESTINATION');
    }
    const base: Omit<SignedHandoff, 'headers'> = {
      id: randomUUID(), pod_id: from.pod_id, thread_id: thread, from_inbox_id: from.id, to_inbox_id: to.id,
      hop_count: halted ? previous : previous + 1, max_hops: budget, payload, task_summary: summary, created_at: at,
    };
    return { message: { ...base, headers: this.headers(base) }, halted, reason: paused ? 'The thread is paused for operator review' :
      pingPong ? 'Repeated A → B → A → B sequence' : 'Hop budget exhausted' };
  }

  write(message: SignedHandoff, status: HandoffStatus, traceStep?: string) {
    if (!this.verify(message)) throw new Error('HANDOFF_SIGNATURE_INVALID');
    this.store.sqlite.prepare('INSERT INTO agent_handoffs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      message.id, message.pod_id, message.thread_id, message.from_inbox_id, message.to_inbox_id,
      message.hop_count, message.max_hops, status === 'DELIVERED' ? message.task_summary : '[withheld]',
      status === 'DELIVERED' ? canonicalJson({ payload: message.payload, headers: message.headers }) : '{}',
      status, traceStep ?? null, message.created_at,
    );
  }

  reject(caller: string, input: HandoffInput, step: string) {
    const from = this.member(caller);
    const to = this.member(input.to_inbox_id);
    if (!from || !to || from.pod_id !== to.pod_id || from.id !== input.from_inbox_id || from.id === to.id || !input.thread_id) return;
    this.store.sqlite.prepare("INSERT INTO agent_handoffs VALUES (?,?,?,?,?,0,?,'[withheld]','{}','REJECTED',?,?)")
      .run(randomUUID(), from.pod_id, input.thread_id, from.id, to.id, input.max_hops ?? handoffDefaults.maxHops, step, new Date().toISOString());
  }

  delivery(id: string) {
    const row = this.store.sqlite.prepare(`SELECT * FROM agent_handoffs WHERE id=? AND status IN ('DELIVERED','COMPLETED')`).get(id) as StoredHandoff | undefined;
    if (!row) return null;
    const { payload_json, ordinal: _ordinal, ...facts } = row;
    const signed = { ...facts, ...JSON.parse(payload_json) } as SignedHandoff & { status: HandoffStatus; trace_step_id: string | null };
    return this.verify(signed) ? signed : null;
  }

  list(inboxId: string) {
    return this.store.sqlite.prepare(`SELECT id FROM agent_handoffs WHERE to_inbox_id=? AND status IN ('DELIVERED','COMPLETED') ORDER BY rowid DESC LIMIT 40`)
      .all(inboxId).map((row) => this.delivery(String(row.id))).filter((row) => row !== null)
      .map((row) => ({ ...row, trust_level: 'verified_agent_handoff' as const, threat_signals: [] }));
  }

  saveTrace(id: string, step: string) {
    this.store.sqlite.prepare('UPDATE agent_handoffs SET trace_step_id=? WHERE id=?').run(step, id);
  }

  reset(approvalId: string, podId: string, threadId: string, trace: string) {
    const latest = this.store.sqlite.prepare('SELECT max(rowid) AS marker FROM agent_handoffs WHERE pod_id=? AND thread_id=?')
      .get(podId, threadId);
    return Number(this.store.sqlite.prepare('INSERT OR IGNORE INTO agent_handoff_resets VALUES (?,?,?,?,?)')
      .run(approvalId, podId, threadId, Number(latest?.marker ?? 0), trace).changes) === 1;
  }

  complete(inboxId: string, id: string) {
    return Number(this.store.sqlite.prepare("UPDATE agent_handoffs SET status='COMPLETED' WHERE id=? AND to_inbox_id=? AND status='DELIVERED'")
      .run(id, inboxId).changes) === 1;
  }
}
