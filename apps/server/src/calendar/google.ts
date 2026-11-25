import type { InboxCalendarEvent } from '@clam/shared';
import type { Snapshot } from '../inbox/contracts.js';

interface GoogleEvent {
  id: string;
  etag?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { email?: string; self?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
}

function fromGoogle(event: GoogleEvent): InboxCalendarEvent | null {
  if (event.status === 'cancelled' || !event.start?.dateTime || !event.end?.dateTime) return null;
  const tags = event.extendedProperties?.private ?? {};
  const kinds = ['flight', 'focus', 'meeting', 'reminder', 'buffer'] as const;
  return {
    id: event.id, etag: event.etag, title: event.summary ?? 'Calendar event',
    start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(),
    guests: (event.attendees ?? []).filter((guest) => guest.email && !guest.self)
      .map((guest) => guest.email!.toLowerCase()).sort(),
    kind: kinds.find((kind) => kind === tags.clamKind) ?? 'meeting',
    flexible: tags.clamFlexible === 'true',
    bookingRef: tags.clamBooking || undefined, domain: tags.clamDomain || undefined,
    dossier: tags.clamDossier ? tags.clamDossier.split('\n') : undefined,
  };
}

export class GoogleCalendar {
  constructor(private readonly token: () => Promise<string>, private readonly calendarId: string, private readonly guard: () => void) {}

  private async request(suffix: string, init?: RequestInit) {
    const token = await this.token();
    this.guard();
    init?.signal?.throwIfAborted();
    return fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events${suffix}`, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
    });
  }

  async list(): Promise<InboxCalendarEvent[]> {
    const query = new URLSearchParams({
      timeMin: new Date(Date.now() - 86_400_000).toISOString(),
      timeMax: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      maxResults: '250', singleEvents: 'true',
    });
    const events: InboxCalendarEvent[] = [];
    do {
      const response = await this.request('?' + query);
      if (!response.ok) throw new Error('CALENDAR_LIST_' + response.status);
      const parsed = await response.json() as { items: GoogleEvent[]; nextPageToken?: string };
      for (const event of parsed.items ?? []) {
        const normalized = fromGoogle(event);
        if (normalized) events.push(normalized);
      }
      if (!parsed.nextPageToken) return events;
      query.set('pageToken', parsed.nextPageToken);
    } while (events.length < 1000);
    throw new Error('CALENDAR_WINDOW_TOO_LARGE');
  }

  async get(id: string) {
    const response = await this.request('/' + encodeURIComponent(id));
    if ([404, 410].includes(response.status)) return null;
    if (!response.ok) throw new Error('CALENDAR_READ_' + response.status);
    return fromGoogle(await response.json() as GoogleEvent);
  }

  async write(id: string, before: Snapshot, after: Snapshot, signal: AbortSignal) {
    const current = before as InboxCalendarEvent | null;
    const target = after as InboxCalendarEvent | null;
    const suffix = (current ? '/' + encodeURIComponent(id) : '') + '?sendUpdates=none';
    const patch = target ? {
      ...(!current ? { id } : {}),
      summary: target.title, start: { dateTime: target.start }, end: { dateTime: target.end },
      ...(!current || JSON.stringify(current.guests) !== JSON.stringify(target.guests)
        ? { attendees: target.guests.map((email) => ({ email })) } : {}),
      extendedProperties: { private: {
        clamKind: target.kind, clamFlexible: String(target.flexible),
        clamBooking: target.bookingRef ?? '', clamDomain: target.domain ?? '', clamDossier: target.dossier?.join('\n') ?? '',
      } },
    } : null;
    const response = await this.request(suffix, {
      method: target ? current ? 'PATCH' : 'POST' : 'DELETE',
      headers: current?.etag ? { 'If-Match': current.etag } : undefined,
      body: patch ? JSON.stringify(patch) : undefined,
      signal,
    });
    if (!response.ok) throw new Error('CALENDAR_WRITE_' + response.status);
  }
}
