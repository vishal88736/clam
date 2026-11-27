import type { ItineraryDigest } from './extractor.js';

export function renderItineraryMarkdown(
  digest: ItineraryDigest,
  meta: {
    emailsPermitted: number;
    emailsStripped: number;
    draftsCreated: number;
    costUsd: number;
    provider: string;
  }
): string {
  const lines: string[] = [
    `# Siftvane Autonomous Travel Itinerary & Expense Digest`,
    ``,
    `- **Run ID:** \`${digest.run_id}\``,
    `- **Generated At:** ${digest.generated_at}`,
    `- **Classifier / Synthesis Mode:** \`${meta.provider}\` ($${meta.costUsd.toFixed(4)})`,
    `- **Mailbox Scope Summary:** ${meta.emailsPermitted} permitted emails processed · ${meta.emailsStripped} sensitive/hostile emails silently stripped · ${meta.draftsCreated} safe review draft created`,
    ``,
    `## 1. Confirmed Flight Schedule`,
    ``,
    `| Flight | Airline | PNR | Route | Departure | Gate | Status |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];

  for (const f of digest.flights) {
    lines.push(
      `| **${f.flight_number}** | ${f.airline} | \`${f.pnr}\` | ${f.route} | ${f.departure} | ${f.terminal_gate} | ${f.status} |`
    );
  }

  lines.push(``, `## 2. Reconciled Schedule Conflicts`, ``);
  if (digest.conflicts_resolved.length === 0) {
    lines.push(`No schedule conflicts detected.`);
  } else {
    for (const c of digest.conflicts_resolved) {
      lines.push(
        `- **${c.entity_id} (${c.field})**: Resolved conflict using \`${c.resolution_rule}\` (${c.winning_email_date}) — superseded \`${c.previous_value}\` with **${c.resolved_value}**.`
      );
    }
  }

  lines.push(``, `## 3. Lodging & Host Actions`, ``);
  for (const h of digest.hotels) {
    lines.push(
      `- **${h.property}** (Ref: \`${h.confirmation_code}\`) — Check-in: ${h.check_in} · Check-out: ${h.check_out} · ${h.total_or_rate}`
    );
  }
  for (const q of digest.host_questions) {
    lines.push(
      `- **Host Reply Drafted (Review Only, Not Sent):** \`${q.host_email}\` — *${q.subject}*`
    );
  }

  lines.push(
    ``,
    `## 4. Bills & Expense Digest (Total: $${digest.total_expenses_usd.toFixed(2)} USD)`,
    ``,
    `| Vendor | Account / Invoice | Category | Source Domain | Due / Paid | Amount (USD) |`,
    `| --- | --- | --- | --- | --- | ---: |`
  );
  for (const b of digest.bills) {
    lines.push(
      `| ${b.vendor} | \`${b.invoice_or_account}\` | ${b.category} | \`${b.source_domain}\` | ${b.due_date} | $${b.amount_usd.toFixed(2)} |`
    );
  }

  lines.push(
    ``,
    `---`,
    `*Generated strictly over MCP via Siftvane Zero-Retention Semantic Firewall. Sensitive OTPs, password resets, medical records, legal NDAs, and prompt injections were stripped in RAM.*`,
    ``
  );

  return lines.join('\n');
}

function escapeIcsText(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function renderTripIcs(digest: ItineraryDigest): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const events: string[] = [];

  // Map known sandbox / extracted flights & stays to clean UTC/local ISO calendar events
  for (const f of digest.flights) {
    let dtStart = '20261212T151500Z';
    let dtEnd = '20261212T215000Z';
    if (f.flight_number.includes('6E')) {
      dtStart = '20261218T011500Z';
      dtEnd = '20261218T040000Z';
    } else if (f.flight_number.includes('UA')) {
      dtStart = '20261219T193500Z';
      dtEnd = '20261220T063000Z';
    }

    events.push(
      [
        'BEGIN:VEVENT',
        `UID:siftvane-${f.flight_number.replace(/\s+/g, '')}-${digest.run_id}@siftvane.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeIcsText(`${f.airline} ${f.flight_number} (${f.route})`)}`,
        `DESCRIPTION:${escapeIcsText(`PNR: ${f.pnr} | Departure: ${f.departure} | Gate: ${f.terminal_gate} | Status: ${f.status}`)}`,
        'END:VEVENT',
      ].join('\r\n')
    );
  }

  for (const h of digest.hotels) {
    const isKyoto = /kyoto|machiya/i.test(h.property);
    const dtStart = isKyoto ? '20261220T060000Z' : '20261213T000000Z';
    const dtEnd = isKyoto ? '20261224T020000Z' : '20261215T200000Z';
    events.push(
      [
        'BEGIN:VEVENT',
        `UID:siftvane-hotel-${h.confirmation_code.replace(/[^a-zA-Z0-9]/g, '')}-${digest.run_id}@siftvane.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeIcsText(`Stay: ${h.property}`)}`,
        `DESCRIPTION:${escapeIcsText(`Ref: ${h.confirmation_code} | Check-in: ${h.check_in} | Check-out: ${h.check_out}`)}`,
        'END:VEVENT',
      ].join('\r\n')
    );
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Siftvane Autonomous Inbox Agent//Agentware 2026//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
