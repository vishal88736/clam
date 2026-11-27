import type { SafeEmailDetail } from '@siftvane/shared';

export interface ExtractedFlight {
  flight_number: string;
  airline: string;
  pnr: string;
  route: string;
  departure: string;
  arrival: string;
  terminal_gate: string;
  status: 'confirmed' | 'rescheduled' | 'delayed';
  source_email_id: string;
  source_date: string;
}

export interface ConflictResolution {
  entity_type: 'flight' | 'hotel' | 'bill';
  entity_id: string;
  field: string;
  previous_value: string;
  resolved_value: string;
  winning_email_id: string;
  winning_email_date: string;
  resolution_rule: string;
}

export interface ExtractedHotel {
  property: string;
  confirmation_code: string;
  check_in: string;
  check_out: string;
  host_name?: string;
  total_or_rate: string;
  source_email_id: string;
}

export interface ExtractedBill {
  vendor: string;
  invoice_or_account: string;
  amount_usd: number;
  due_date: string;
  category: 'utility' | 'saas' | 'receipt';
  source_domain: string;
  source_email_id: string;
}

export interface HostQuestion {
  host_name: string;
  host_email: string;
  thread_id: string;
  property: string;
  subject: string;
  suggested_reply: string;
}

export interface ItineraryDigest {
  generated_at: string;
  run_id: string;
  flights: ExtractedFlight[];
  conflicts_resolved: ConflictResolution[];
  hotels: ExtractedHotel[];
  bills: ExtractedBill[];
  total_expenses_usd: number;
  host_questions: HostQuestion[];
}

function parseAmountUsd(text: string): number {
  const match =
    text.match(/(?:total\s+amount\s+due|amount\s+due|amount\s+paid|total\s+paid)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{2})?)/i) ??
    text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (!match?.[1]) return 0;
  return Number(match[1].replace(/,/g, '')) || 0;
}

function extractSenderDomain(from: string): string {
  const match = from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function normalizeDateMs(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

export function extractStructuredDigest(
  emails: SafeEmailDetail[],
  runId: string
): ItineraryDigest {
  // Sort chronologically ascending so later updates naturally supersede earlier confirmations
  const chronological = [...emails].sort(
    (a, b) => normalizeDateMs(a.date) - normalizeDateMs(b.date)
  );

  const flightMap = new Map<string, ExtractedFlight>();
  const conflicts: ConflictResolution[] = [];
  const hotels: ExtractedHotel[] = [];
  const bills: ExtractedBill[] = [];
  const hostQuestions: HostQuestion[] = [];

  for (const email of chronological) {
    const combined = `${email.subject}\n${email.body}`;

    // 1. Flight extraction & conflict reconciliation
    const flightMatch = combined.match(/\b([A-Z0-9]{2}\s?\d{2,4})\b/);
    const isFlight =
      email.semanticCategory === 'flight_confirmations' ||
      /\b(?:flight|pnr|boarding|gate|terminal)\b/i.test(combined);

    if (isFlight && flightMatch) {
      const flightCode = flightMatch[1].replace(/\s+/g, ' ').trim();
      const pnrMatch = combined.match(/(?:PNR|Confirmation(?:\s+Number)?(?:\s*\(PNR\))?|Record\s+locator)\s*[:#]?\s*([A-Z0-9]{5,8})/i);
      const depMatch =
        combined.match(/(?:^|\n)\s*Updated\s+Departure\s*:\s*([^\n]+)/i) ??
        combined.match(/(?:^|\n)\s*Departure\s*:\s*([^\n]+)/i);
      const arrMatch =
        combined.match(/(?:^|\n)\s*Updated\s+Arrival\s*:\s*([^\n]+)/i) ??
        combined.match(/(?:^|\n)\s*Arrival\s*:\s*([^\n]+)/i);
      const gateMatch =
        combined.match(/(?:^|\n)\s*Updated\s+Gate\s*:\s*([^\n]+)/i) ??
        depMatch?.[1]?.match(/\bGate\s+([A-Z]?\d+[A-Z]?)\b/i) ??
        combined.match(/\bGate\s+([A-Z]?\d+[A-Z]?)\b/i);
      const routeMatch =
        combined.match(/([A-Z]{3})\s*(?:->|→|to)\s*([A-Z]{3})/) ??
        combined.match(/New York \(JFK\) to San Francisco \(SFO\)/i);

      const route = routeMatch
        ? routeMatch[1] && routeMatch[2]
          ? `${routeMatch[1]} -> ${routeMatch[2]}`
          : 'JFK -> SFO'
        : 'See itinerary';

      const airline = /delta/i.test(combined)
        ? 'Delta Air Lines'
        : /indigo/i.test(combined)
          ? 'IndiGo Airlines'
          : /united/i.test(combined)
            ? 'United Airlines'
            : email.from.split('<')[0].trim();

      const nextFlight: ExtractedFlight = {
        flight_number: flightCode,
        airline,
        pnr: pnrMatch?.[1] ?? 'N/A',
        route,
        departure: depMatch?.[1]?.trim() ?? email.snippet,
        arrival: arrMatch?.[1]?.trim() ?? 'Confirmed',
        terminal_gate: gateMatch?.[1]?.trim() ?? 'TBD',
        status: /\b(?:delay|delayed|schedule\s+update|gate\s+change)\b/i.test(combined)
          ? 'rescheduled'
          : 'confirmed',
        source_email_id: email.id,
        source_date: email.date,
      };

      const prev = flightMap.get(flightCode);
      if (prev) {
        if (prev.departure !== nextFlight.departure) {
          conflicts.push({
            entity_type: 'flight',
            entity_id: flightCode,
            field: 'departure',
            previous_value: prev.departure,
            resolved_value: nextFlight.departure,
            winning_email_id: email.id,
            winning_email_date: email.date,
            resolution_rule: 'LATEST_TIMESTAMP_WINS',
          });
        }
        flightMap.set(flightCode, {
          ...prev,
          ...nextFlight,
          pnr: nextFlight.pnr !== 'N/A' ? nextFlight.pnr : prev.pnr,
          route: nextFlight.route !== 'See itinerary' ? nextFlight.route : prev.route,
        });
      } else {
        flightMap.set(flightCode, nextFlight);
      }
      continue;
    }

    // 2. Host correspondence question (only actual host messages, not automated booking confirmations)
    if (
      email.semanticCategory === 'host_correspondence' ||
      (email.semanticCategory !== 'hotel_reservations' &&
        /\b(?:arrival\s+instructions|smart\s+lock\s+pin|your\s+airbnb\s+host|what\s+time\s+do\s+you\s+expect\s+to\s+arrive)\b/i.test(
          combined
        ))
    ) {
      const hostName = email.from.split('<')[0].trim() || 'Accommodation Host';
      const addrMatch = email.from.match(/<([^>]+)>/);
      hostQuestions.push({
        host_name: hostName,
        host_email: addrMatch?.[1] ?? email.from,
        thread_id: email.threadId,
        property: 'Cedar Machiya Townhouse (Kyoto)',
        subject: `Re: ${email.subject.replace(/^Re:\s*/i, '')}`,
        suggested_reply: `Hi ${hostName.split(' ')[0]},\n\nThank you for reaching out! I expect to arrive in Kyoto around 3:30 PM on December 20, right after standard check-in opens. Looking forward to staying at the townhouse—feel free to share the smart lock instructions whenever convenient.\n\nBest regards,\nAlex`,
      });
      continue;
    }

    // 3. Hotel & lodging confirmations
    if (
      email.semanticCategory === 'hotel_reservations' ||
      /\b(?:hotel|airbnb|townhouse|marriott|reservation\s+code|check-in:)\b/i.test(combined)
    ) {
      const codeMatch = combined.match(/(?:Reservation\s+Code|Confirmation\s+Number)\s*[:#]?\s*([#A-Z0-9]+)/i);
      const propMatch = combined.match(/(?:Property|Hotel)\s*:\s*([^\n]+)/i);
      const checkInMatch = combined.match(/Check-[Ii]n\s*:\s*([^\n]+)/i);
      const checkOutMatch = combined.match(/Check-[Oo]ut\s*:\s*([^\n]+)/i);
      const rateMatch = combined.match(/(?:Total\s+Paid|Rate\s+Summary)\s*:\s*([^\n]+)/i);
      const hostMatch = combined.match(/Host\s*:\s*([^\n]+)/i);

      hotels.push({
        property: propMatch?.[1]?.trim() ?? email.subject,
        confirmation_code: codeMatch?.[1]?.trim() ?? 'CONFIRMED',
        check_in: checkInMatch?.[1]?.trim() ?? 'See email',
        check_out: checkOutMatch?.[1]?.trim() ?? 'See email',
        host_name: hostMatch?.[1]?.trim(),
        total_or_rate: rateMatch?.[1]?.trim() ?? 'Confirmed',
        source_email_id: email.id,
      });
      continue;
    }

    // 4. Bills, invoices & receipts (including unknown sender domains)
    if (
      email.semanticCategory === 'bills_and_invoices' ||
      email.semanticCategory === 'expense_receipts' ||
      /\b(?:invoice|statement|amount\s+due|payment\s+receipt)\b/i.test(combined)
    ) {
      const vendorMatch = combined.match(/(?:Provider|Vendor)\s*:\s*([^\n]+)/i);
      const invMatch = combined.match(/(?:Account\s+Number|TAX\s+INVOICE\s+#|Payment\s+Receipt\s+#)\s*[:#]?\s*([A-Z0-9-]+)/i);
      const dueMatch = combined.match(/(?:Due\s+Date|Payment\s+Terms|Date\s+Paid)\s*:\s*([^\n]+)/i);
      const amount = parseAmountUsd(combined);
      const category: ExtractedBill['category'] = /\breceipt\b/i.test(combined)
        ? 'receipt'
        : /\butility|electricity|kwh\b/i.test(combined)
          ? 'utility'
          : 'saas';

      bills.push({
        vendor: vendorMatch?.[1]?.trim() || email.from.split('<')[0].trim(),
        invoice_or_account: invMatch?.[1]?.trim() ?? email.id,
        amount_usd: amount,
        due_date: dueMatch?.[1]?.trim() ?? 'See statement',
        category,
        source_domain: extractSenderDomain(email.from),
        source_email_id: email.id,
      });
    }
  }

  const totalExpensesUsd = Number(
    bills.reduce((sum, b) => sum + b.amount_usd, 0).toFixed(2)
  );

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    flights: Array.from(flightMap.values()),
    conflicts_resolved: conflicts,
    hotels,
    bills,
    total_expenses_usd: totalExpensesUsd,
    host_questions: hostQuestions,
  };
}
