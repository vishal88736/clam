import type { InboxCalendarEvent, InboxIntent, InboxPolicy } from '@clam/shared';
import type { Change, ProposedAction, Snapshot } from '../contracts.js';
import { address, validDateTime, validDay } from '../reader.js';
import { sha256 } from '../trace.js';

export const playbooks = [
  { id: 'travel_delay_cascade', trigger: 'flight_update', autonomy_tiers: [0, 1, 2], policy_rules: ['TRUSTED_BOOKING', 'VIP_RECIPIENT'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 1 } },
  { id: 'autonomous_meeting_scheduler', trigger: 'meeting_request', autonomy_tiers: [0, 1, 2], policy_rules: ['WORKING_HOURS', 'EXTERNAL_CALENDAR_GUESTS'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 1 } },
  { id: 'bills_trials_spoof_guard', trigger: 'bill_invoice or subscription_notice', autonomy_tiers: [0, 2], policy_rules: ['INVOICE_CONFLICT', 'LOW_CONFIDENCE'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 0 } },
  { id: 'hostile_input_quarantine', trigger: 'hostile_suspected', autonomy_tiers: [0], policy_rules: ['QUARANTINE'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 0, outbound: 0 } },
  { id: 'pre_meeting_dossier', trigger: 'upcoming meeting', autonomy_tiers: [0, 2], policy_rules: ['EXTERNAL_CALENDAR_GUESTS'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 0 } },
  { id: 'commitment_radar_and_chaser', trigger: 'commitment_deadline', autonomy_tiers: [0, 1, 2], policy_rules: ['CONFLICT', 'TAINT_RECIPIENT'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 1 } },
  { id: 'order_delivery_tracker', trigger: 'delivery_update', autonomy_tiers: [0, 2], policy_rules: ['DELIVERY_SEQUENCE'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 1, outbound: 0 } },
  { id: 'ephemeral_otp_expiry', trigger: 'otp_ephemeral older than 20 minutes', autonomy_tiers: [0], policy_rules: ['EXCLUDE_SECURITY_ALERTS'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 0, outbound: 0 } },
  { id: 'newsletter_outreach_rollup', trigger: 'newsletter_promo or cold_outreach', autonomy_tiers: [0], policy_rules: ['REVERSIBLE_LABEL'], verification_check: 'target_readback', rollback_handler: 'restore_before', budget_cost: { calendar: 0, outbound: 0 } },
] as const;

type Calendar = InboxCalendarEvent;
type PlaybookId = (typeof playbooks)[number]['id'];
const iso = (value: string | number) => new Date(value).toISOString();
const minutes = (value: number) => value * 60_000;
const overlaps = (left: Calendar, right: Calendar) =>
  Date.parse(left.start) < Date.parse(right.end) && Date.parse(right.start) < Date.parse(left.end);
const contactIn = (contact: string, list: string[]) => list.some((item) => item.toLowerCase() === contact);
const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hashId = (...parts: string[]) => sha256(parts.join('\0')).slice(0, 24);

interface PlanInput {
  intents: InboxIntent[];
  calendar: Calendar[];
  mailStates: Record<string, Snapshot>;
  bills: Snapshot[];
  now: Date;
  policy: InboxPolicy;
}

export function buildPlan({ intents, calendar, mailStates, bills, now, policy }: PlanInput) {
  const actions: ProposedAction[] = [];
  const conflicts: Change[] = [];
  const proposedCalendar = [...calendar];
  const excluded = new Set<string>();
  const find = (kind: InboxIntent['kind']) => intents.filter((intent) => intent.kind === kind);
  const add = (playbook: PlaybookId, intent: InboxIntent, kind: ProposedAction['kind'], target: string,
    after: Snapshot, requestedTier: ProposedAction['requestedTier'] = 0,
    options: Partial<Pick<ProposedAction, 'reason' | 'contact' | 'externalGuests' | 'sensitiveTarget' | 'expectedBefore'>> = {}) => {
    actions.push({
      playbook, intent, kind, target, version: sha256(JSON.stringify(after)),
      after, requestedTier, ...options,
    });
  };
  const review = (playbook: PlaybookId, intent: InboxIntent, target: string, reason: string, after: Snapshot) =>
    add(playbook, intent, 'review', target, after, 2, { reason });
  const conflict = (kind: string, entity: string, field: string, prior: unknown, next: unknown, sourceIds: string[]) => {
    conflicts.push({
      type: kind, entity, diff: { [field]: { before: prior, after: next } },
      source_msg_ids: sourceIds, conflict_flag: true, next_action: 'Review both sources',
    });
  };
  const setCalendar = (playbook: PlaybookId, intent: InboxIntent, event: Calendar, tier: ProposedAction['requestedTier'] = 0,
    reason?: string) => {
    const existing = proposedCalendar.find((item) => item.id === event.id);
    const externalGuests = Boolean(existing && existing.guests.some((guest) => !contactIn(guest, policy.allowlist)));
    add(playbook, intent, 'calendar', event.id, { ...event, etag: undefined }, tier, { externalGuests, reason, expectedBefore: existing ?? null });
    if (!externalGuests && tier < 2 && intent.confidence >= policy.confidenceThreshold) {
      if (existing) proposedCalendar.splice(proposedCalendar.indexOf(existing), 1);
      proposedCalendar.push(event);
    }
  };
  const labels = (playbook: PlaybookId, intent: InboxIntent, remove: string[], append: string[] = [], reason?: string) => {
    const existing = mailStates[intent.messageId]?.labels;
    if (!Array.isArray(existing)) return;
    add(playbook, intent, 'mail', intent.messageId, {
      labels: [...new Set([...existing.filter((label) => !remove.includes(String(label))), ...append])].sort(),
    }, 0, { reason });
  };
  const send = (playbook: PlaybookId, intent: InboxIntent, contact: string, subject: string, text: string) => {
    add(playbook, intent, 'send', hashId(playbook, intent.messageId, contact), { subject, text }, 1, { contact });
  };
  const reminder = (playbook: PlaybookId, intent: InboxIntent, key: string, date: string, title: string) => {
    if (!validDay(date)) return;
    const start = Date.parse(date + 'T09:00:00Z');
    setCalendar(playbook, intent, {
      id: 'clam' + hashId(key), title: title.slice(0, 140), start: iso(start), end: iso(start + minutes(15)),
      kind: 'reminder', guests: [], flexible: true,
    });
  };

  for (const item of find('hostile_suspected')) {
    labels('hostile_input_quarantine', item, ['INBOX'], ['CLAM_QUARANTINE'], 'quarantine');
  }

  const flightUpdates = find('flight_update').sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
  const seenFlights = new Set<string>();
  for (const item of flightUpdates) {
    const { booking, domain, start, end, cancelled } = item.fields;
    const flightKey = booking ? booking.toLowerCase() + '/' + domain : item.messageId;
    if (seenFlights.has(flightKey)) continue;
    seenFlights.add(flightKey);
    const tied = flightUpdates.find((other) => other !== item && other.fields.booking?.toLowerCase() === booking?.toLowerCase() &&
      other.fields.domain === domain && Date.parse(other.receivedAt) === Date.parse(item.receivedAt) &&
      (other.fields.start !== start || other.fields.cancelled !== cancelled));
    if (tied) {
      conflict('flight', booking, 'start', start, tied.fields.start, [item.messageId, tied.messageId]);
      review('travel_delay_cascade', item, flightKey, 'FLIGHT_CONFLICT', { booking, dates: [start, tied.fields.start] });
      continue;
    }
    const event = proposedCalendar.find((entry) => entry.kind === 'flight' &&
      entry.bookingRef?.toLowerCase() === booking?.toLowerCase() && entry.domain === domain);
    if (!event || (!cancelled && (!validDateTime(start) || !validDateTime(end) || Date.parse(end) <= Date.parse(start)))) {
      review('travel_delay_cascade', item, booking ?? item.messageId, 'FLIGHT_MATCH_REQUIRED', { booking, start, end });
      continue;
    }
    if (cancelled) {
      add('travel_delay_cascade', item, 'calendar', event.id, null, 2, { reason: 'FLIGHT_CANCELLATION', externalGuests: event.guests.length > 0, expectedBefore: event });
      continue;
    }
    const updated = { ...event, start: iso(start), end: iso(end) };
    if (Date.parse(event.start) === Date.parse(start) && Date.parse(event.end) === Date.parse(end)) continue;
    const affected = proposedCalendar.filter((entry) => entry.id !== event.id && overlaps(updated, entry));
    setCalendar('travel_delay_cascade', item, updated);
    for (const entry of affected) {
      const duration = Date.parse(entry.end) - Date.parse(entry.start);
      const shifted = { ...entry, start: iso(Date.parse(updated.start) - duration - minutes(15)),
        end: iso(Date.parse(updated.start) - minutes(15)) };
      const clear = !proposedCalendar.some((other) => other.id !== entry.id && overlaps(other, shifted));
      if (entry.flexible && entry.guests.length === 0 && clear && Date.parse(shifted.start) >= now.getTime()) {
        setCalendar('travel_delay_cascade', item, shifted);
      }
      const remote = entry.guests.some((guest) => !contactIn(guest, policy.allowlist));
      if (remote) {
        const alternate = clear ? shifted : {
          ...entry, start: iso(Date.parse(entry.start) + minutes(1440)), end: iso(Date.parse(entry.end) + minutes(1440)),
        };
        const available = !proposedCalendar.some((other) => other.id !== entry.id && overlaps(other, alternate));
        if (available) setCalendar('travel_delay_cascade', item, alternate, 2, 'FLIGHT_MEETING_COLLISION');
        else review('travel_delay_cascade', item, entry.id, 'FLIGHT_MEETING_COLLISION', { title: entry.title, start: entry.start });
      }
      for (const guest of entry.guests) {
        send('travel_delay_cascade', item, address(guest), 'Running late due to a travel change',
          `My travel schedule changed and may overlap our meeting. Could we confirm a new time?`);
      }
    }
  }

  const meetings = find('meeting_request');
  for (const item of meetings) {
    const { start, duration, title, event: eventId, cancelled } = item.fields;
    if (eventId || cancelled) {
      const existing = proposedCalendar.find((entry) => entry.id === eventId);
      if (!existing || item.fields.trustedSender !== 'true' || !existing.guests.includes(item.sender)) {
        review('autonomous_meeting_scheduler', item, eventId ?? item.threadId, 'MEETING_TARGET_UNVERIFIED', { title, eventId });
      } else if (cancelled) {
        add('autonomous_meeting_scheduler', item, 'calendar', existing.id, null, 2,
          { expectedBefore: existing, reason: 'CALENDAR_CANCELLATION', externalGuests: true });
      } else if (validDateTime(start)) {
        const durationMs = Date.parse(existing.end) - Date.parse(existing.start);
        setCalendar('autonomous_meeting_scheduler', item, {
          ...existing, start: iso(start), end: iso(Date.parse(start) + durationMs),
        }, 2, 'MEETING_CHANGE');
      } else {
        review('autonomous_meeting_scheduler', item, eventId, 'MEETING_DETAILS_REQUIRED', { title, start });
      }
      continue;
    }
    const minutesRequested = Number(duration);
    if (!validDateTime(start) || !Number.isInteger(minutesRequested) || minutesRequested < 5 || minutesRequested > 480) {
      review('autonomous_meeting_scheduler', item, item.threadId, 'MEETING_DETAILS_REQUIRED', { start, duration });
      continue;
    }
    const sameThread = meetings.filter((other) => other.threadId === item.threadId);
    if (new Set(sameThread.map((other) => other.fields.start)).size > 1) {
      if (!excluded.has(item.threadId)) {
        excluded.add(item.threadId);
        const other = sameThread.find((entry) => entry.fields.start !== start)!;
        conflict('meeting', title, 'start', start, other.fields.start, [item.messageId, other.messageId]);
        review('autonomous_meeting_scheduler', item, item.threadId, 'MEETING_CONFLICT', { proposed: [start, other.fields.start] });
      }
      continue;
    }
    const startMs = Date.parse(start);
    const endMs = startMs + minutes(minutesRequested);
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: policy.timeZone, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const local = (value: number) => Object.fromEntries(clock.formatToParts(value).map(({ type, value }) => [type, value]));
    const localStart = local(startMs);
    const localEnd = local(endMs);
    const outside = Number(localStart.hour) * 60 + Number(localStart.minute) < policy.workStart * 60 ||
      Number(localEnd.hour) * 60 + Number(localEnd.minute) > policy.workEnd * 60 ||
      localEnd.day !== localStart.day || ['Sat', 'Sun'].includes(localStart.weekday);
    const event: Calendar = {
      id: 'clam' + hashId('meeting', item.threadId), title, start: iso(startMs), end: iso(endMs),
      kind: 'meeting', guests: item.sender ? [item.sender] : [], flexible: false,
    };
    const buffer: Calendar = {
      id: event.id + 'b', title: 'Prep for ' + title.slice(0, 130), start: iso(startMs - minutes(15)), end: iso(startMs),
      kind: 'buffer', guests: [], flexible: false,
    };
    if (proposedCalendar.some((entry) => entry.id === event.id)) continue;
    const collision = proposedCalendar.some((entry) => overlaps(entry, event) || overlaps(entry, buffer));
    const allowed = item.fields.trustedSender === 'true' && contactIn(item.sender, policy.allowlist) && !contactIn(item.sender, policy.vips);
    if (!allowed || outside || minutesRequested > policy.maxMeetingMinutes || collision || item.confidence < policy.confidenceThreshold) {
      setCalendar('autonomous_meeting_scheduler', item, event, 2,
        collision ? 'CALENDAR_COLLISION' : outside ? 'OFF_HOURS' : minutesRequested > policy.maxMeetingMinutes ? 'MEETING_TOO_LONG' : 'EXTERNAL_MEETING');
      continue;
    }
    setCalendar('autonomous_meeting_scheduler', item, buffer);
    setCalendar('autonomous_meeting_scheduler', item, event, 1);
    send('autonomous_meeting_scheduler', item, item.sender, 'Meeting time confirmed',
      `I reserved ${new Date(startMs).toISOString()} for ${minutesRequested} minutes.`);
  }

  for (const item of intents.filter(({ kind }) => kind === 'bill_invoice' || kind === 'subscription_notice')) {
    const { vendor, invoice, amount, due, currency, account, domain } = item.fields;
    const key = slug(vendor ?? '') + ':' + slug(invoice ?? '');
    const historical = bills.filter((bill) => bill?.vendor === vendor && bill.type === 'history').at(-1);
    const previous = bills.find((bill) => bill?.invoice === invoice && bill.vendor === vendor);
    const older = intents.find((other) => other !== item && other.fields.invoice === invoice && other.fields.vendor === vendor &&
      Date.parse(other.receivedAt) < Date.parse(item.receivedAt));
    const accountHash = account ? sha256(account) : undefined;
    const priorAccount = older?.fields.account ? sha256(older.fields.account) : previous?.accountFingerprint;
    const changedAccount = Boolean(priorAccount && accountHash && priorAccount !== accountHash);
    const priorAmount = older ? Number(older.fields.amount) : previous?.amount;
    const priorDomain = older?.fields.domain ?? previous?.domain;
    const matchingInvoice = Boolean(older || previous);
    if (matchingInvoice && (changedAccount || (priorDomain && priorDomain !== domain) || priorAmount !== Number(amount))) {
      conflict('bill', invoice, 'amount', priorAmount ?? null, Number(amount), [older?.messageId ?? String(previous?.sourceId ?? ''), item.messageId].filter(Boolean));
      const flag = { vendor, invoice, previousAmount: priorAmount, amount: Number(amount), changedAccount, changedDomain: priorDomain !== domain };
      const contact = older?.sender ?? item.sender;
      if (contact && (!changedAccount || contactIn(contact, policy.contacts))) {
        add('bills_trials_spoof_guard', item, 'draft', hashId('invoice-dispute', key), {
          ...flag, subject: 'Please verify invoice ' + invoice, text: 'Could you confirm the correct invoice amount and billing information through our usual channel?',
        }, 2, { contact, reason: 'DUPLICATE_OR_SPOOFED_INVOICE' });
      } else {
        review('bills_trials_spoof_guard', item, key, 'DUPLICATE_OR_SPOOFED_INVOICE', flag);
      }
      continue;
    }
    if (item.confidence < policy.confidenceThreshold || !validDay(due) || !Number.isFinite(Number(amount))) {
      review('bills_trials_spoof_guard', item, key, 'BILL_DETAILS_REQUIRED', { vendor, invoice, due });
      continue;
    }
    const priceHike = historical?.currency === currency && Number(historical?.amount) < Number(amount);
    add('bills_trials_spoof_guard', item, 'bill', key, {
      vendor, invoice, amount: Number(amount), currency, due, domain, accountFingerprint: accountHash,
      sourceId: item.messageId, priceHike, previousAmount: priceHike ? historical?.amount : null,
      type: item.kind === 'subscription_notice' ? 'subscription' : 'invoice',
    });
    if (item.kind === 'subscription_notice') {
      reminder('bills_trials_spoof_guard', item, 'renewal:' + key, iso(Date.parse(due) - minutes(2880)).slice(0, 10), 'Renewal due · ' + vendor);
      if (priceHike) add('bills_trials_spoof_guard', item, 'draft', hashId('renewal-review', key), {
        vendor, invoice, from: historical?.amount, to: Number(amount),
        subject: 'Confirm subscription renewal options',
        text: 'Could you confirm the new renewal price and how to cancel before the next charge?',
      }, 2, { contact: item.sender, reason: 'SUBSCRIPTION_PRICE_INCREASE' });
    }
  }

  const commitments = find('commitment_deadline');
  for (const item of commitments) {
    const { project, deadline, waitingOn, sent } = item.fields;
    if (!deadline) continue;
    const key = slug(project ?? '');
    const other = commitments.find((entry) => entry.fields.project === project && entry.fields.deadline && entry.fields.deadline !== deadline);
    if (other) {
      if (!excluded.has(key)) {
        excluded.add(key);
        conflict('commitment', project, 'deadline', deadline, other.fields.deadline, [item.messageId, other.messageId]);
        review('commitment_radar_and_chaser', item, key, 'DEADLINE_CONFLICT', { project, deadlines: [deadline, other.fields.deadline] });
      }
      continue;
    }
    if (!validDay(deadline)) {
      review('commitment_radar_and_chaser', item, key, 'DEADLINE_DETAILS_REQUIRED', { project, deadline });
      continue;
    }
    const recipient = address(waitingOn ?? '');
    const replied = Boolean(recipient && intents.some((entry) => entry.sender === recipient &&
      Date.parse(entry.receivedAt) > Date.parse(item.receivedAt) &&
      (entry.threadId === item.threadId || slug(entry.fields.project ?? '') === key)));
    add('commitment_radar_and_chaser', item, 'commitment', key, { project, deadline, waitingOn: recipient, replied });
    if (!sent) reminder('commitment_radar_and_chaser', item, 'deadline:' + key, deadline, 'Deadline · ' + project);
    const elapsed = now.getTime() - Date.parse(item.receivedAt);
    if (sent && recipient && !replied && elapsed >= minutes(48 * 60) && elapsed <= minutes(72 * 60)) {
      send('commitment_radar_and_chaser', item, recipient, 'Following up',
        'A quick follow-up on the item we discussed. Could you share an update when you have a chance?');
    }
  }

  const deliveries = find('delivery_update');
  const progression = ['confirmed', 'shipped', 'delivered'];
  for (const order of new Set(deliveries.map((item) => item.fields.order))) {
    const chain = deliveries.filter((item) => item.fields.order === order)
      .sort((left, right) => progression.indexOf(right.fields.status?.toLowerCase()) - progression.indexOf(left.fields.status?.toLowerCase()) ||
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
    const latest = chain[0];
    const state = latest.fields.status?.toLowerCase();
    const returnBy = latest.fields.returnBy;
    add('order_delivery_tracker', latest, 'delivery', order, { order, status: state, returnBy: returnBy ?? null });
    if (state === 'delivered') {
      if (returnBy) reminder('order_delivery_tracker', latest, 'return:' + order, returnBy, 'Return deadline · ' + order);
      for (const superseded of chain.slice(1)) labels('order_delivery_tracker', superseded, ['INBOX']);
    }
  }

  for (const item of find('otp_ephemeral')) {
    if (now.getTime() - Date.parse(item.receivedAt) >= minutes(20)) labels('ephemeral_otp_expiry', item, ['INBOX'], ['CLAM_EXPIRED_OTP']);
  }
  for (const item of find('newsletter_promo')) {
    add('newsletter_outreach_rollup', item, 'newsletter', item.messageId, { title: item.fields.title, sender: item.sender });
    labels('newsletter_outreach_rollup', item, [], ['CLAM_NEWSLETTER']);
  }
  for (const item of find('cold_outreach')) labels('newsletter_outreach_rollup', item, ['INBOX'], ['CLAM_COLD_OUTREACH', 'MUTED']);

  const newMeetings = actions.filter((action) => action.playbook === 'autonomous_meeting_scheduler' &&
    action.kind === 'calendar' && action.after?.kind === 'meeting' && action.requestedTier === 1);
  const times = [
    ...calendar.filter((event) => event.kind === 'meeting' && event.guests.length > 0 && !event.dossier &&
      Date.parse(event.start) > now.getTime() && Date.parse(event.start) <= now.getTime() + minutes(120)),
    ...newMeetings.map((action) => action.after as Calendar),
  ];
  for (const event of times) {
    const context = commitments.filter((item) => event.guests.includes(item.sender) && (item.fields.file || item.fields.commitment))
      .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt)).slice(0, 3);
    if (!context.length) continue;
    const booked = newMeetings.find((action) => action.target === event.id);
    if (!booked && actions.filter((action) =>
      action.kind === 'calendar' && action.requestedTier < 2).length >= policy.calendarBudget) continue;
    const dossier = context.map((item) => [
      'Thread ' + item.threadId, item.fields.commitment && 'Commitment: ' + item.fields.commitment,
      item.fields.file && 'File: ' + item.fields.file,
    ].filter(Boolean).join(' · '));
    if (booked?.after) {
      booked.after = { ...booked.after, dossier };
      booked.version = sha256(JSON.stringify(booked.after));
    } else {
      setCalendar('pre_meeting_dossier', context[0], { ...event, dossier });
    }
  }
  return { actions, conflicts };
}
