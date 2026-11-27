import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inboxCalendarSchema, inboxPolicySchema, scanOutboundSecrets, scanPromptInjection, verificationNotice, type EphemeralEmail } from '@siftvane/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GoogleAccounts, McpGrant } from '../auth/google.js';
import { GoogleCalendarLiveAdapter } from '../calendar/google.js';
import { safeAttachmentBytes, stageWorkspaceAttachment } from '../inbox/attachmentWorkspace.js';
import { readAttachments, type ReaderAttachment } from '../inbox/attachments.js';
import type { Mode, SafeAction } from '../inbox/contracts.js';
import type { InboxEngine } from '../inbox/engine.js';
import { address, domain, stripHtml } from '../inbox/reader.js';
import { canonicalJson, sha256 } from '../inbox/trace.js';
import { GmailLiveAdapter } from '../mail/gmail.js';
import type { CalendarAdapter, MailboxAdapter } from '../mail/inboxAdapter.js';
import { SandboxInboxAdapter } from '../mail/sandboxInbox.js';
import { consumeVerification, extractVerification } from './verification.js';
import { mcpCaller } from './caller.js';
import { sandboxClock } from '../sandbox/seed.js';
import type { MissionRunner } from '../platform/runner.js';
import type { PlatformService } from '../platform/service.js';
import { registerPlatformTools } from './platformTools.js';

const messageId = z.string().regex(/^[\w-]{1,160}$/);
const emailAddress = z.string().email().max(254).transform((value) => value.toLowerCase());
const text = z.string().trim().min(1).max(1700);
const subject = z.string().trim().min(1).max(180).regex(/^[^\r\n\0]+$/);
const messageFields = { to: emailAddress, subject, text, message_id: messageId.optional() };
const lookup = { query: z.string().max(500).optional(), max_results: z.number().int().min(1).max(20).optional() };
const otp = { expected_sender_domain: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,245}[a-z0-9])?\.[a-z]{2,24}$/),
  max_age_minutes: z.number().int().min(1).max(60).default(15) };

const structured = (value: unknown, isError = false) => ({
  isError, content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const authNotice = verificationNotice;
const sensitive = (entry: EphemeralEmail) => authNotice.test(entry.subject + '\n' + entry.body) || scanOutboundSecrets(entry.body);

export function createInboxMcpServer(args: {
  grant: McpGrant; accounts: GoogleAccounts; inbox: InboxEngine; calendarId: string; stagingDir: string; verificationRedirects: Record<string, string[]>;
  platform?: PlatformService; missions?: MissionRunner;
}) {
  const { grant, accounts, inbox, calendarId, stagingDir } = args;
  const mode: Mode = grant.inboxId === 'sandbox' ? 'sandbox' : `live:${grant.inboxId}`;
  const gmail: MailboxAdapter = mode === 'sandbox' ? new SandboxInboxAdapter(inbox.store, inbox.guard) :
    new GmailLiveAdapter(accounts, grant.inboxId, inbox.guard);
  const calendar: CalendarAdapter = mode === 'sandbox' ? {
    list: async () => inboxCalendarSchema.array().parse((await inbox.calendar('sandbox')).events),
    get: async (id) => inboxCalendarSchema.nullable().parse(inbox.store.entity('sandbox', 'calendar', id)),
  } : new GoogleCalendarLiveAdapter(accounts, grant.inboxId, calendarId, inbox.guard);
  const server = new McpServer({ name: 'siftvane-inbox', version: '2.2.0' });
  const caller = (tool: string) => {
    const attribution = mcpCaller(server, grant, tool);
    if (mode !== 'sandbox' && accounts.redact(grant.inboxId, attribution.client) !== attribution.client) {
      attribution.client = 'MCP client';
    }
    return attribution;
  };
  const workflow = (tool: string, grantName: string, work: () => Promise<unknown>, audit?: Record<string, unknown>) => {
    return (async () => {
      try {
        inbox.guard();
        if (!grant.scopes.includes(grantName) || (grantName === 'inbox:manage' && mode !== 'sandbox')) throw new Error('MCP_SCOPE_REQUIRED');
        const result = await work();
        if (audit) await inbox.recordMcpRead(mode, caller(tool), audit);
        return structured(result);
      } catch (failure) {
        const value = failure instanceof Error ? failure.message : '';
        const error = /^[A-Z][A-Z0-9_]{2,70}$/.test(value) ? value : 'INBOX_OPERATION_FAILED';
        if (error !== 'INBOX_HALTED' && !inbox.halted()) await inbox.recordMcpRead(mode, caller(tool), {}, error).catch(() => undefined);
        const action = error === 'SCOPE_UPGRADE_REQUIRED' ? 'Upgrade this inbox to Read + Actions in Siftvane Connections.' :
          error === 'GOOGLE_API_DISABLED' ? 'Enable the requested API in the Google Cloud project for this OAuth client.' :
          error === 'GOOGLE_PHOTOS_SETUP_REQUIRED' ? 'Complete Google Photos setup on the connected Google account.' :
          error === 'PHOTOS_PICKER_SELECTION_REQUIRED' ? 'Call photos_start_picker, open picker_uri, choose the receipts, then retry.' :
          error === 'GOOGLE_REAUTH_REQUIRED' ? 'Reconnect this inbox in Siftvane Connections.' : undefined;
        return structured({ error, action }, true);
      }
    })();
  };

  const safeMessage = (entry: EphemeralEmail, includeBody = false) => {
    const concealed = entry.quarantined || sensitive(entry);
    return {
      id: entry.id, thread_id: entry.threadId, from: entry.from, date: entry.date,
      subject: concealed ? '[redacted]' : stripHtml(entry.subject),
      ...(includeBody && mode === 'sandbox' ? { body: concealed ? '[redacted]' : stripHtml(entry.body).slice(0, 20_000) } : {}),
      ...(includeBody && mode !== 'sandbox' ? { excerpt: concealed ? '[redacted]' : stripHtml(entry.body).replace(/\s+/g, ' ').slice(0, 500) } : {}),
      has_attachments: entry.hasAttachments, trust_level: 'untrusted_external', threat_signals: entry.threat_signals ?? [],
      quarantined: Boolean(entry.quarantined),
    };
  };
  const getMessage = async (id: string) => {
    const entry = await gmail.getMessage(id);
    if (!entry) throw new Error('MESSAGE_NOT_AVAILABLE');
    return entry;
  };
  const checkAttachment = async (id: string) => {
    const entry = await getMessage(id);
    if (entry.quarantined || sensitive(entry)) throw new Error('MESSAGE_QUARANTINED');
  };
  const safeAttachment = async (id: string, part: ReaderAttachment, index: number) => {
    const parent = path.join(stagingDir, id);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staged = await mkdtemp(path.join(parent, 'extract-'));
    try {
      const file = path.join(staged, 'part-' + index);
      await writeFile(file, safeAttachmentBytes(part), { mode: 0o600, flag: 'wx' });
      const data = (await readFile(file)).toString('base64url');
      const content = accounts.redact(grant.inboxId, await readAttachments([{ ...part, data }]));
      const signals = scanPromptInjection(content);
      const quarantined = signals.detected || Boolean(scanOutboundSecrets(content)) || authNotice.test(content);
      return {
        name: accounts.redact(grant.inboxId, part.name), mime: part.mime, text: quarantined ? '[redacted]' : stripHtml(content),
        trust_level: 'untrusted_external', threat_signals: signals.signals, quarantined,
      };
    } finally {
      await rm(staged, { force: true, recursive: true });
    }
  };

  if (mode === 'sandbox') {
    server.tool('list_inboxes', 'List this sandbox mailbox and the local agent Pod inboxes.', {}, () =>
      workflow('list_inboxes', 'inbox:manage', async () => ({ inboxes: inbox.handoffs.members() }), {}));
    server.tool('provision_inbox', 'Create a synthetic @siftvane.local inbox in the local agent Pod.', {
      inbox_id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    }, ({ inbox_id }) => workflow('provision_inbox', 'inbox:manage', () =>
      inbox.recordScopedEvent(mode, 'mcp.provision_inbox', (record) => {
        const created = inbox.handoffs.provision(inbox_id);
        record({ action: 'provision_inbox', outcome: 'VERIFIED', inbox_id: created.id });
        return created;
      }, caller('provision_inbox'))));
    server.tool('get_recipient_policy', 'Read the sandbox recipient allowlist and blocklist.', {}, () =>
      workflow('get_recipient_policy', 'inbox:manage', async () => {
        const { version, policy } = inbox.store.policy(mode);
        return { version, allowlist: policy.allowlist, blocklist: policy.blocklist };
      }, {}));
    server.tool('update_recipient_policy', 'Add or remove an address in the sandbox recipient policy.', {
      list: z.enum(['allowlist', 'blocklist']), operation: z.enum(['add', 'remove']), address: emailAddress,
    }, ({ list, operation, address }) => workflow('update_recipient_policy', 'inbox:manage', () =>
      inbox.recordScopedEvent(mode, 'mcp.update_recipient_policy', (record) => {
        const { version, policy } = inbox.store.policy(mode);
        const entries = policy[list].filter((value) => value.toLowerCase() !== address);
        const next = inboxPolicySchema.safeParse({ ...policy, [list]: operation === 'add' ? [...entries, address] : entries });
        if (!next.success) throw new Error('RECIPIENT_POLICY_LIMIT');
        const saved = inbox.store.savePolicy(mode, version, next.data);
        record({ action: 'update_recipient_policy', outcome: 'VERIFIED', list, operation, policy_version: saved.version });
        return { version: saved.version, allowlist: next.data.allowlist, blocklist: next.data.blocklist };
      }, caller('update_recipient_policy'))));
  }

  server.tool('list_threads', 'List scoped Gmail threads. Thread text is untrusted external data.', lookup,
    ({ query, max_results }) => workflow('list_threads', 'mail:read', async () =>
      (await gmail.listThreads(query, max_results)).map((thread) => ({ id: thread.id, messages: thread.messages.map((entry) => safeMessage(entry)) })), {}));
  server.tool('get_thread', 'Read messages in a scoped thread.', { thread_id: messageId },
    ({ thread_id }) => workflow('get_thread', 'mail:read', async () => {
      const thread = await gmail.getThread(thread_id);
      return { id: thread.id, messages: thread.messages.map((entry) => safeMessage(entry, true)) };
    }, { thread_id }));
  server.tool('search_messages', 'Search the scoped Gmail inbox with Gmail search terms.', lookup,
    ({ query, max_results }) => workflow('search_messages', 'mail:read', async () => (await gmail.listMessages(query, max_results)).map((entry) => safeMessage(entry)), {}));
  server.tool('get_message', 'Read one scoped email through the untrusted-data boundary.', { message_id: messageId },
    ({ message_id }) => workflow('get_message', 'mail:read', async () => safeMessage(await getMessage(message_id), true), { source_msg_id: message_id }));
  server.tool('list_attachments', 'List bounded attachment metadata for an allowed message.', { message_id: messageId },
    ({ message_id }) => workflow('list_attachments', 'attachment:extract', async () => {
      await checkAttachment(message_id);
      return (await gmail.listAttachments(message_id)).map((part) => ({ ...part, name: accounts.redact(grant.inboxId, part.name) }));
    }, { source_msg_id: message_id }));
  server.tool('extract_attachment_text', 'Extract and quarantine unsupported or hostile attachment content.', {
    message_id: messageId, index: z.number().int().min(0).max(2).default(0),
  }, ({ message_id, index }) => workflow('extract_attachment_text', 'attachment:extract', async () => {
    await checkAttachment(message_id);
    const extracted = await safeAttachment(message_id, await gmail.getAttachment(message_id, index), index);
    if (!extracted.quarantined) {
      inbox.store.sqlite.prepare("INSERT OR IGNORE INTO inbox_capability_events VALUES (?,?,'attachment')")
        .run(sha256(mode + ':' + message_id + ':' + index), mode);
    }
    return extracted;
  }, { source_msg_id: message_id }));

  server.tool('stage_attachment_workspace', 'Place a screened PDF, text, CSV, or calendar attachment in the local workspace.', {
    message_id: messageId, index: z.number().int().min(0).max(2).default(0),
  }, ({ message_id, index }) => workflow('stage_attachment_workspace', 'attachment:extract', async () => {
    await checkAttachment(message_id);
    const part = await gmail.getAttachment(message_id, index);
    const inspected = await safeAttachment(message_id, part, index);
    if (inspected.quarantined) throw new Error('MESSAGE_QUARANTINED');
    return stageWorkspaceAttachment(stagingDir, message_id, part, inbox.guard);
  }, { source_msg_id: message_id }));

  const findCode = async (sender: string, age: number, tool: string) => {
    const messages = await gmail.listMessages('from:@' + sender + ' newer_than:1h -in:spam -in:trash', 12);
    const now = mode === 'sandbox' ? Date.parse(sandboxClock) : Date.now();
    const since = now - age * 60_000;
    for (const entry of messages.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))) {
      if (!entry.verifiedSender || domain(entry.from) !== sender || entry.quarantined || Date.parse(entry.date) < since ||
          Date.parse(entry.date) > now || !Number.isFinite(Date.parse(entry.date))) continue;
      const result = extractVerification(entry, sender, args.verificationRedirects);
      if (!result) continue;
      if (inbox.store.sqlite.prepare('SELECT 1 FROM verification_consumptions WHERE inbox_id=? AND message_id=?').get(grant.inboxId, entry.id)) continue;
      const consumed = await consumeVerification(inbox, {
        mode, inboxId: grant.inboxId, message: entry, sender, caller: grant.tokenId, result, attribution: caller(tool),
      });
      if (consumed) return consumed;
    }
    return null;
  };
  server.tool('get_verification_code', 'Look up a recent, authenticated verification email from the exact token-scoped sender domain.', otp,
    ({ expected_sender_domain, max_age_minutes }) => workflow('get_verification_code', 'otp:read:' + expected_sender_domain, async () => {
      const result = await findCode(expected_sender_domain, max_age_minutes, 'get_verification_code');
      if (!result) await inbox.recordMcpRead(mode, caller('get_verification_code'), { found: false });
      return result ?? { found: false };
    }));
  server.tool('wait_for_verification_email', 'Briefly wait for a recent verification email from the exact token-scoped sender domain.', {
    ...otp, wait_seconds: z.number().int().min(1).max(20).default(10),
  }, ({ expected_sender_domain, max_age_minutes, wait_seconds }) => workflow('wait_for_verification_email', 'otp:read:' + expected_sender_domain, async () => {
    const end = Date.now() + wait_seconds * 1000;
    do {
      const result = await findCode(expected_sender_domain, max_age_minutes, 'wait_for_verification_email');
      if (result) return result;
      if (Date.now() >= end) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2000, end - Date.now())));
      inbox.guard();
    } while (Date.now() <= end);
    await inbox.recordMcpRead(mode, caller('wait_for_verification_email'), { found: false });
    return { found: false };
  }));

  type Mail = { to: string; subject: string; text: string; message_id?: string };
  const prepare = async (input: Mail, kind: 'send' | 'draft', forced = false): Promise<SafeAction> => {
    const payload = input.subject + '\n' + input.text;
    if (payload !== accounts.redact(grant.inboxId, payload)) throw new Error('OUTBOUND_CONTENT_BLOCKED');
    const source = input.message_id ? await getMessage(input.message_id) : undefined;
    if (source && (source.quarantined || sensitive(source))) throw new Error('MESSAGE_QUARANTINED');
    const sender = source ? address(source.from) : '';
    const bodyOnly = Boolean(source && sender !== input.to && !source.to.some((value) => address(value) === input.to) &&
      (source.body + '\n' + (source.html ?? '')).toLowerCase().includes(input.to));
    const after = { subject: input.subject, text: input.text };
    const version = sha256(canonicalJson({ ...after, to: input.to, source: input.message_id }));
    return {
      threadId: source?.threadId, sourceId: input.message_id ?? 'mcp:' + version, playbook: 'mcp_outbound', kind, target: kind + '-' + version.slice(0, 24),
      requestedTier: forced || kind === 'draft' ? 2 : 1, reason: forced ? 'MCP_BATCH_APPROVAL' : 'MCP_DRAFT_APPROVAL',
      confidence: 1, effectiveContact: input.to, version, after, bodyOnlyRecipient: bodyOnly,
    };
  };
  server.tool('send_message', 'Send an allowlisted message or request a Tier 2 approval.', messageFields,
    (input) => workflow('send_message', 'mail:send', async () => {
      inbox.requireMutationScope(mode, 'send');
      return inbox.submitActions(mode, [await prepare(input, 'send')], false, caller('send_message'));
    }));
  server.tool('reply_message', 'Reply in the original thread through the inbox policy.', { message_id: messageId, text },
    ({ message_id, text }) => workflow('reply_message', 'mail:send', async () => {
      inbox.requireMutationScope(mode, 'send');
      const source = await getMessage(message_id);
      const to = address(source.from);
      if (!to || source.quarantined || sensitive(source)) throw new Error('MESSAGE_QUARANTINED');
      const originalSubject = source.subject.replace(/^(?:re\s*:\s*)+/i, '').replace(/[\r\n]/g, ' ');
      if (!originalSubject || originalSubject.length > 176) throw new Error('INVALID_OUTBOUND_PAYLOAD');
      return inbox.submitActions(mode, [await prepare({ message_id, to, subject: 'Re: ' + originalSubject, text }, 'send')], false, caller('reply_message'));
    }));
  server.tool('forward_message', 'Queue a bounded forward for operator approval.', {
    message_id: messageId, to: emailAddress, note: z.string().trim().max(300).default(''),
  }, ({ message_id, to, note }) => workflow('forward_message', 'mail:send', async () => {
    inbox.requireMutationScope(mode, 'send');
    const source = await getMessage(message_id);
    if (source.quarantined || sensitive(source)) throw new Error('MESSAGE_QUARANTINED');
    const action = await prepare({ message_id, to, subject: ('Fwd: ' + source.subject.replace(/[\r\n]/g, ' ')).slice(0, 180),
      text: [note, 'Forwarded message', stripHtml(source.body)].filter(Boolean).join('\n\n').slice(0, 1700) }, 'send', true);
    return inbox.submitActions(mode, [{ ...action, reason: 'MCP_FORWARD_APPROVAL' }], false, caller('forward_message'));
  }));
  server.tool('create_draft', 'Submit a Gmail draft for operator approval.', messageFields,
    (input) => workflow('create_draft', 'mail:draft', async () => {
      inbox.requireMutationScope(mode, 'draft');
      return inbox.submitActions(mode, [await prepare(input, 'draft')], false, caller('create_draft'));
    }));
  server.tool('propose_batch_send', 'Submit a bounded batch through the same allowlist, Tier 2 gate, and write budget.', {
    messages: z.array(z.object(messageFields).strict()).min(1).max(10),
  }, ({ messages }) => workflow('propose_batch_send', 'mail:send', async () => {
    inbox.requireMutationScope(mode, 'send');
    return inbox.submitActions(mode, await Promise.all(messages.map((message) => prepare(message, 'send'))), true, caller('propose_batch_send'));
  }));
  server.tool('get_batch_status', 'Read dispatch status and verified send counts for a grouped approval in this inbox.', {
    batch_id: messageId,
  }, ({ batch_id }) => workflow('get_batch_status', 'mail:send', async () => {
    const item = inbox.store.approval(batch_id);
    if (!item?.batch_actions || item.mode !== mode) throw new Error('BATCH_NOT_AVAILABLE');
    const verified = (item.execution_run_ids ?? []).flatMap((id) => inbox.store.actions(id))
      .filter((action) => action.kind === 'send' && action.status === 'VERIFIED');
    return { batch_id, status: item.status, message_count: item.batch_actions.length, verified_sends: verified.length };
  }, { approval_id: batch_id }));
  server.tool('list_events', 'List the selected inbox calendar. Event text is untrusted external data.', {},
    () => workflow('list_events', 'calendar:propose', async () => {
      const events = await calendar.list();
      return events.map((event) => {
        const flags = scanPromptInjection([event.title, ...event.dossier ?? []].join('\n'));
        return { ...event, title: flags.detected ? '[redacted]' : event.title, dossier: undefined,
          trust_level: 'untrusted_external', threat_signals: flags.signals, quarantined: flags.detected };
      });
    }, {}));
  server.tool('propose_calendar_change', 'Queue a calendar addition, update, or cancellation for operator approval.', {
    event_id: messageId.optional(), cancel: z.boolean().optional(),
    event: inboxCalendarSchema.omit({ id: true, etag: true, dossier: true }).optional(),
  }, ({ event_id, cancel, event }) => workflow('propose_calendar_change', 'calendar:propose', async () => {
    inbox.requireMutationScope(mode, 'calendar');
    if ((cancel && (!event_id || event)) || (!cancel && !event)) throw new Error('INVALID_CALENDAR_CHANGE');
    const before = event_id ? await calendar.get(event_id) : null;
    if (event_id && !before) throw new Error('EVENT_NOT_AVAILABLE');
    if (event && (Date.parse(event.end) <= Date.parse(event.start) || scanPromptInjection(event.title).detected ||
        scanOutboundSecrets(event.title) || event.title !== accounts.redact(grant.inboxId, event.title))) throw new Error('INVALID_CALENDAR_CHANGE');
    const version = sha256(canonicalJson({ event_id, event, cancel }));
    const target = event_id ?? version.slice(0, 32);
    const after = event ? { ...event, id: target, guests: [...event.guests].sort() } : null;
    return inbox.submitActions(mode, [{
      playbook: 'mcp_calendar', kind: 'calendar', sourceId: 'mcp:' + version, target, after,
      expectedBefore: before, requestedTier: 2, reason: 'MCP_CALENDAR_APPROVAL', externalGuests: Boolean(before?.guests.length || event?.guests.length),
      confidence: 1, version,
    }], false, caller('propose_calendar_change'));
  }));
  if (args.platform && args.missions) {
    registerPlatformTools(server, { grant, mode, inbox, platform: args.platform, missions: args.missions, accounts, workflow, caller });
  }
  return server;
}
