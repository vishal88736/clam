import type { EphemeralEmail } from '@clam/shared';
import type {
  CreateDraftInput,
  MailActionResult,
  MailProvider,
  SendMessageInput,
} from './types.js';

export interface StoredGmailTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope: string;
  email?: string;
}

export interface GmailTokenStore {
  getTokens(): Promise<StoredGmailTokens | null>;
  saveTokens(tokens: StoredGmailTokens): Promise<void>;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: { name: string; value: string }[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
}

function decodeBase64Url(input?: string): string {
  if (!input) return '';
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function extractBodyAndAttachments(part?: GmailMessagePart): {
  text: string;
  html: string;
  attachments: string[];
} {
  if (!part) return { text: '', html: '', attachments: [] };
  let text = '';
  let html = '';
  const attachments: string[] = [];

  if (part.filename) {
    attachments.push(part.filename);
  }
  if (part.mimeType === 'text/plain' && part.body?.data) {
    text += decodeBase64Url(part.body.data);
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    html += decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const sub = extractBodyAndAttachments(child);
    if (sub.text) text += (text ? '\n' : '') + sub.text;
    if (sub.html) html += (html ? '\n' : '') + sub.html;
    attachments.push(...sub.attachments);
  }
  return { text, html, attachments };
}

function parseGmailMessage(raw: GmailRawMessage): EphemeralEmail {
  const headers = raw.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const extracted = extractBodyAndAttachments(raw.payload);
  const plainBody =
    extracted.text ||
    extracted.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
    raw.snippet ||
    '';

  const toHeader = getHeader('To');
  const toList = toHeader
    ? toHeader.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    id: raw.id,
    threadId: raw.threadId,
    from: getHeader('From') || 'unknown@sender',
    to: toList,
    subject: getHeader('Subject') || '(No Subject)',
    date: getHeader('Date') || new Date(Number(raw.internalDate || Date.now())).toISOString(),
    snippet: raw.snippet || plainBody.slice(0, 140),
    body: plainBody,
    labels: raw.labelIds ?? [],
    hasAttachments: extracted.attachments.length > 0,
    attachmentNames: extracted.attachments,
    isUnread: raw.labelIds?.includes('UNREAD') ?? false,
  };
}

export class GmailMailProvider implements MailProvider {
  public readonly mode = 'gmail' as const;

  constructor(
    private readonly oauth: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
    private readonly tokenStore: GmailTokenStore
  ) {}

  static buildAuthUrl(params: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
  }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('scope', params.scopes.join(' '));
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<StoredGmailTokens> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        redirect_uri: this.oauth.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gmail OAuth token exchange failed (${res.status}): ${txt}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    // Fetch profile email address (metadata only, zero message retention)
    let email: string | undefined;
    try {
      const profRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (profRes.ok) {
        const prof = (await profRes.json()) as { emailAddress?: string };
        email = prof.emailAddress;
      }
    } catch {
      // Ignore optional profile lookup failure
    }

    const tokens: StoredGmailTokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in - 60) * 1000,
      scope: json.scope ?? '',
      email,
    };
    await this.tokenStore.saveTokens(tokens);
    return tokens;
  }

  private async getValidAccessToken(): Promise<string> {
    const tokens = await this.tokenStore.getTokens();
    if (!tokens) {
      throw new Error('Gmail is not connected. Authorize via Settings -> Connect Gmail.');
    }
    if (Date.now() < tokens.expires_at) {
      return tokens.access_token;
    }
    if (!tokens.refresh_token) {
      throw new Error('Gmail access token expired and no refresh_token is available.');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      throw new Error(`Gmail token refresh failed (${res.status})`);
    }
    const refreshed = (await res.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };
    const updated: StoredGmailTokens = {
      ...tokens,
      access_token: refreshed.access_token,
      expires_at: Date.now() + (refreshed.expires_in - 60) * 1000,
      scope: refreshed.scope ?? tokens.scope,
    };
    await this.tokenStore.saveTokens(updated);
    return updated.access_token;
  }

  private async gmailFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getValidAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail API error ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  async listMessages(query?: string, maxResults = 20): Promise<EphemeralEmail[]> {
    const qs = new URLSearchParams({
      maxResults: String(Math.max(1, Math.min(maxResults, 50))),
    });
    if (query?.trim()) qs.set('q', query.trim());

    const list = await this.gmailFetch<{ messages?: { id: string }[] }>(
      `/messages?${qs.toString()}`
    );
    const ids = list.messages ?? [];
    const results = await Promise.all(ids.map((m) => this.getMessage(m.id)));
    return results.filter((m): m is EphemeralEmail => m !== null);
  }

  async getMessage(messageId: string): Promise<EphemeralEmail | null> {
    try {
      const raw = await this.gmailFetch<GmailRawMessage>(
        `/messages/${encodeURIComponent(messageId)}?format=full`
      );
      return parseGmailMessage(raw);
    } catch {
      return null;
    }
  }

  private buildRawMime(input: { to: string; subject: string; body: string }): string {
    const lines = [
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      input.body,
    ];
    return encodeBase64Url(lines.join('\r\n'));
  }

  async createDraft(input: CreateDraftInput): Promise<MailActionResult> {
    const raw = this.buildRawMime(input);
    const res = await this.gmailFetch<{ id: string }>('/drafts', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          raw,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      }),
    });
    return {
      ok: true,
      provider: 'gmail',
      id: res.id,
      detail: `Gmail draft created (${res.id})`,
    };
  }

  async sendMessage(input: SendMessageInput): Promise<MailActionResult> {
    const raw = this.buildRawMime(input);
    const res = await this.gmailFetch<{ id: string }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        raw,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
    });
    return {
      ok: true,
      provider: 'gmail',
      id: res.id,
      detail: `Gmail message sent (${res.id})`,
    };
  }

  async archiveMessage(messageId: string): Promise<MailActionResult> {
    await this.gmailFetch(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    });
    return {
      ok: true,
      provider: 'gmail',
      id: messageId,
      detail: `Archived Gmail message ${messageId}`,
    };
  }

  async applyLabel(messageId: string, label: string): Promise<MailActionResult> {
    const labelsRes = await this.gmailFetch<{ labels?: { id: string; name: string }[] }>('/labels');
    let labelId = labelsRes.labels?.find(
      (l) => l.name.toLowerCase() === label.trim().toLowerCase()
    )?.id;

    if (!labelId) {
      const created = await this.gmailFetch<{ id: string }>('/labels', {
        method: 'POST',
        body: JSON.stringify({
          name: label.trim(),
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        }),
      });
      labelId = created.id;
    }

    await this.gmailFetch(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
    return {
      ok: true,
      provider: 'gmail',
      id: messageId,
      detail: `Applied Gmail label ${label}`,
    };
  }
}
