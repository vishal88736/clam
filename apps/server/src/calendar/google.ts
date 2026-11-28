import type { InboxCalendarEvent } from '@siftvane/shared';
import type { Snapshot } from '../inbox/contracts.js';
import type { GoogleAccounts } from '../auth/google.js';
import type { CalendarAdapter } from '../mail/inboxAdapter.js';

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
  return {
    id: event.id, etag: event.etag, title: event.summary ?? 'Calendar event',
    start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(),
    guests: (event.attendees ?? []).filter((guest) => guest.email && !guest.self)
      .map((guest) => guest.email!.toLowerCase()).sort(),
    kind: ((tags.siftvaneKind ?? tags.clamKind) || 'event').slice(0, 40),
    flexible: (tags.siftvaneFlexible ?? tags.clamFlexible) === 'true',
  };
}

export class GoogleCalendar implements CalendarAdapter {
  constructor(private readonly token: () => Promise<string>, private readonly calendarId: string, private readonly guard: () => void,
    private readonly transport?: (url: string, init?: RequestInit) => Promise<Response>,
    private readonly redact?: (text: string) => string) {}

  private async request(suffix: string, init?: RequestInit) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events${suffix}`;
    if (this.transport) return this.transport(url, init);
    const token = await this.token();
    this.guard();
    init?.signal?.throwIfAborted();
    return fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
    });
  }

  private normalize(event: GoogleEvent) {
    const result = fromGoogle(event);
    if (!result || !this.redact) return result;
    return { ...result, title: this.redact(result.title) };
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
        const normalized = this.normalize(event);
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
    return this.normalize(await response.json() as GoogleEvent);
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
        siftvaneKind: target.kind, siftvaneFlexible: String(target.flexible),
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

export class GoogleCalendarLiveAdapter extends GoogleCalendar {
  constructor(accounts: GoogleAccounts, inboxId: string, calendarId: string, guard: () => void) {
    super(async () => { throw new Error('GOOGLE_AUTH_UNAVAILABLE'); }, calendarId, guard,
      (url, init) => accounts.api(inboxId, init?.method && init.method !== 'GET' ? 'calendar:write' : 'calendar:read', url, guard, init),
      (value) => accounts.redact(inboxId, value));
  }
}
