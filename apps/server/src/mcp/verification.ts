import { z } from 'zod';
import { recoveryNotice, verificationNotice, type EphemeralEmail } from '@clam/shared';
import type { InboxEngine } from '../inbox/engine.js';
import type { McpCaller, Mode } from '../inbox/contracts.js';
import { stripHtml } from '../inbox/reader.js';

const host = /^[a-z0-9]+(?:[a-z0-9-]*\.[a-z0-9]+)+$/;
const redirectSchema = z.record(z.array(z.string().regex(host)).max(10));
const redirectParameter = /^(redirect.*|return.*|next|target|continue|url|uri|destination|callback.*|goto|r)$/i;

export function verificationRedirects(value?: string) {
  if (!value) return {};
  const rules = redirectSchema.parse(JSON.parse(value));
  if (!Object.keys(rules).every((sender) => host.test(sender))) throw new Error('INVALID_VERIFICATION_REDIRECTS');
  return rules;
}

export function extractVerification(entry: EphemeralEmail, sender: string, redirects: Record<string, string[]>):
  { code: string } | { verification_url: string } | null {
  const observed = entry.subject + '\n' + entry.body;
  if (!verificationNotice.test(observed) || recoveryNotice.test(observed)) return null;
  const content = stripHtml(entry.body);
  for (const match of content.matchAll(/\b(?:code|passcode|pin)\s*(?:is\s+)?[:#-]?\s*([a-zA-Z0-9]{4,12})\b/gi)) {
    const code = match[1];
    if (/^\d{4,8}$/.test(code) || (/\d/.test(code) && /[a-z]/i.test(code))) return { code };
  }
  const candidates = [
    ...entry.body.matchAll(/https:\/\/[^\s<>"']+/gi),
    ...(entry.html ?? '').matchAll(/href\s*=\s*["'](https:\/\/[^"'< >]+)["']/gi),
  ];
  const allowed = new Set([sender, ...(redirects[sender] ?? [])]);
  for (const candidate of candidates) {
    const raw = (candidate[1] ?? candidate[0]).replace(/&amp;/gi, '&').replace(/[.,;)]+$/, '');
    if (!URL.canParse(raw)) continue;
    const url = new URL(raw);
    const text = url.pathname.toLowerCase();
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed.has(url.hostname) ||
        url.pathname.includes('%') || /(?:reset|recover|redirect)/i.test(text) ||
        !/(?:^|[\/_-])(?:verification|verify|confirm|magic[-_]?link)(?=[\/_-]|$)/.test(text) ||
        [...url.searchParams.keys()].some((key) => redirectParameter.test(key))) continue;
    return { verification_url: url.toString() };
  }
  return null;
}

export async function consumeVerification(inbox: InboxEngine, input: {
  mode: Mode; inboxId: string; message: EphemeralEmail; sender: string; caller: string;
  attribution?: McpCaller;
  result: { code: string } | { verification_url: string };
}) {
  return inbox.recordScopedEvent(input.mode, 'mcp.verification_consumption', (record) => {
    const inserted = inbox.store.sqlite.prepare('INSERT OR IGNORE INTO verification_consumptions VALUES (?,?,?,?,?)')
      .run(input.message.id, input.caller, input.inboxId, input.sender, new Date().toISOString());
    if (!inserted.changes) return null;
    const { result } = input;
    record({
      thread_id: input.message.threadId, action: 'verification_consumption', outcome: 'VERIFIED',
      domain: input.sender, caller_token_id: input.caller,
      ...('code' in result ? { code_redacted: result.code.length >= 6 ? '***' + result.code.slice(-3) : '***' }
        : { verification_url_redacted: '[redacted]' }),
    });
    return result;
  }, input.attribution);
}
