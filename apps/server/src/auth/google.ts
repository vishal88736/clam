import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { DatabaseSync } from 'node:sqlite';
import type { ClamConfig } from '../config.js';

const scopes = {
  identity: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
  readonly: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'],
  readwrite: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'],
  // Least-privilege Workspace grant: drive.file only reaches files Clam created or the user opened with Clam;
  // Photos is strictly read-only. Docs/Sheets scopes are requested only for edits of pre-existing files.
  workspace: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'],
  workspace_edit: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'],
} as const;
export const workspaceScopes = {
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  documents: 'https://www.googleapis.com/auth/documents',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  photosReadonly: 'https://www.googleapis.com/auth/photoslibrary.readonly',
  photosAppCreated: 'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
  // Google Photos Picker: the user selects items in Google's UI; Clam reads only the selection.
  photosPicker: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
} as const;
/** Hard ban: unrestricted Drive and any Photos write/share scope can never be stored for an inbox. */
export const bannedScopes = new Set<string>([
  'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.scripts', 'https://www.googleapis.com/auth/drive.apps.readonly',
  'https://www.googleapis.com/auth/photoslibrary', 'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata', 'https://www.googleapis.com/auth/photoslibrary.sharing',
]);
const acceptedScopes = new Set<string>([...scopes.identity, ...scopes.readonly, ...scopes.readwrite, ...scopes.workspace_edit,
  workspaceScopes.photosAppCreated, workspaceScopes.photosReadonly, 'email', 'profile']);
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const retiring = 30_000;
export const sessionCookie = 'clam_session';
export const flowCookie = 'clam_google_flow';
export const mcpScopes = ['mail:read', 'attachment:extract', 'mail:draft', 'mail:send', 'calendar:propose', 'inbox:manage',
  'agent:manage', 'workspace:write', 'photos:read'] as const;
export const sandboxMcpOwner = 'clam-local-sandbox';
export type AuthStage = keyof typeof scopes;
export type GoogleCapability = 'mail:read' | 'mail:write' | 'calendar:read' | 'calendar:write' | 'drive:write' | 'docs:write' | 'sheets:write' | 'photos:read';
export type McpGrant = { inboxId: string; userId: string; scopes: string[]; tokenId: string };
export type OperatorSession = { token_hash: string; user_id: string; inbox_id: string; expires_at: number };
type Identity = { sub: string; email: string; email_verified: boolean; name?: string; picture?: string; nonce?: string };
type Flow = {
  id: string; browser_hash: string; code_verifier: string; nonce: string; intent: AuthStage;
  session_hash: string | null; inbox_id: string | null; expires_at: number; expected_sub: string | null;
};
type Connection = {
  id: string; user_id: string; inbox_id: string; google_sub: string; email: string; granted_scopes: string;
  encrypted_access_token: string; encrypted_refresh_token: string; iv: string; auth_tag: string;
  expires_at: number; status: 'active' | 'reauth_required' | 'revoked';
};
type GoogleTokens = { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string };
type Options = { fetch?: typeof fetch; verifyIdentity?: (token: string) => Promise<Identity | undefined> };
export const opaque = () => randomBytes(32).toString('base64url');
const hash = (text: string, encoding: 'hex' | 'base64url' = 'hex') => createHash('sha256').update(text).digest(encoding);
const nowIso = () => new Date().toISOString();
const sessionAge = 12 * 60 * 60;
export const cookie = (name: string, value: string, maxAge: number, secure: boolean) =>
  name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
const readCookie = (cookies: string | undefined, name: string) =>
  cookies?.split(/;\s*/).find((entry) => entry.startsWith(name + '='))?.slice(name.length + 1) ?? '';

const strongKey = (encoded: string) => {
  if (!/^[a-f0-9]{64}$/i.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'hex');
  return new Set(bytes).size >= 16 ? bytes : null;
};

export function validateGoogleConfig(config: ClamConfig) {
  if (!config.inboxLive && !config.googleClientId && !config.googleClientSecret) return false;
  if (!config.googleClientId || !config.googleClientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Google access.');
  if (!strongKey(config.googleTokenKey)) throw new Error('CLAM_TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters.');
  if (!strongKey(config.sessionSecret)) throw new Error('CLAM_SESSION_SECRET must be 32 random bytes encoded as 64 hex characters.');
  if (config.googleTokenKey.toLowerCase() === config.sessionSecret.toLowerCase()) {
    throw new Error('Generate separate values for CLAM_TOKEN_ENCRYPTION_KEY and CLAM_SESSION_SECRET.');
  }
  const uri = new URL(config.googleRedirectUri);
  const web = new URL(config.webOrigin);
  for (const entry of [uri, web]) {
    if (entry.protocol !== 'https:' && !(entry.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(entry.hostname))) {
      throw new Error('Google authentication requires HTTPS outside localhost.');
    }
  }
  if (uri.pathname !== '/api/auth/google/callback' || uri.search || uri.hash || uri.username || uri.password ||
      uri.hostname !== web.hostname || uri.protocol !== web.protocol) {
    throw new Error('GOOGLE_REDIRECT_URI must target /api/auth/google/callback on the same host and scheme as CLAM_WEB_ORIGIN.');
  }
  return true;
}

export function exactScopes(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GOOGLE_SCOPES_UNVERIFIED');
  const granted = [...new Set(value.trim().split(/\s+/))].sort();
  if (granted.some((scope) => bannedScopes.has(scope))) throw new Error('GOOGLE_SCOPE_BANNED');
  if (granted.some((scope) => !acceptedScopes.has(scope))) throw new Error('GOOGLE_SCOPE_NOT_ALLOWED');
  return granted;
}

const workspaceCapabilities: Partial<Record<GoogleCapability, string[]>> = {
  'drive:write': [workspaceScopes.driveFile],
  'docs:write': [workspaceScopes.driveFile, workspaceScopes.documents],
  'sheets:write': [workspaceScopes.driveFile, workspaceScopes.spreadsheets],
  'photos:read': [workspaceScopes.photosPicker, workspaceScopes.photosReadonly, workspaceScopes.photosAppCreated],
};

export function connectedServices(granted: string[]) {
  return [
    ...(mayUse(granted, 'mail:read') ? ['gmail'] : []), ...(mayUse(granted, 'calendar:read') ? ['calendar'] : []),
    ...(mayUse(granted, 'drive:write') ? ['drive'] : []), ...(mayUse(granted, 'docs:write') ? ['docs'] : []),
    ...(mayUse(granted, 'sheets:write') ? ['sheets'] : []), ...(mayUse(granted, 'photos:read') ? ['photos'] : []),
  ];
}

export function mayUse(granted: string[], operation: GoogleCapability) {
  const workspace = workspaceCapabilities[operation];
  if (workspace) return workspace.some((scope) => granted.includes(scope));
  const [service, access] = operation.split(':');
  const index = service === 'mail' ? 0 : 1;
  return granted.includes(scopes.readwrite[index]) || (access === 'read' && granted.includes(scopes.readonly[index]));
}

export class GoogleAccounts {
  readonly enabled: boolean;
  readonly secure: boolean;
  private readonly encryption: Buffer;
  private readonly signing: Buffer;
  private readonly request: typeof fetch;
  private readonly verifyIdentity: NonNullable<Options['verifyIdentity']>;
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly quota = new Map<string, { time: number; units: number }[]>();

  constructor(private readonly db: DatabaseSync, private readonly config: ClamConfig, options: Options = {}) {
    this.enabled = validateGoogleConfig(config);
    this.secure = config.googleRedirectUri.startsWith('https:');
    this.encryption = Buffer.from(config.googleTokenKey, 'hex');
    this.signing = Buffer.from(config.sessionSecret, 'hex');
    this.request = options.fetch ?? ((...args) => fetch(...args));
    const oidc = new OAuth2Client(config.googleClientId);
    this.verifyIdentity = options.verifyIdentity ?? (async (idToken) => {
      const verified = (await oidc.verifyIdToken({ idToken, audience: config.googleClientId })).getPayload();
      return verified?.email && verified.email_verified ? { ...verified, email: verified.email, email_verified: true } : undefined;
    });
  }

  private requireEnabled() {
    if (!this.enabled) throw new Error('GOOGLE_AUTH_NOT_CONFIGURED');
  }

  private sign(value: string) {
    return createHmac('sha256', this.signing).update(value).digest('base64url');
  }

  session(cookies?: string): OperatorSession | undefined {
    if (!this.enabled) return undefined;
    const token = readCookie(cookies, sessionCookie);
    if (!/^[\w-]{43}$/.test(token)) return undefined;
    return this.db.prepare('SELECT * FROM operator_sessions WHERE token_hash=? AND expires_at>?')
      .get(hash(token), Date.now()) as OperatorSession | undefined;
  }

  logout(session?: OperatorSession) {
    if (session) this.db.prepare('DELETE FROM operator_sessions WHERE token_hash=?').run(session.token_hash);
  }

  status(session?: OperatorSession) {
    const user = session ? this.db.prepare('SELECT id,email,name,picture FROM users WHERE id=?').get(session.user_id) : null;
    const inboxes = session && this.config.inboxLive ? this.db.prepare(`SELECT i.id,i.email,i.adapter_type,c.status,c.granted_scopes FROM inboxes i
      JOIN oauth_connections c ON i.id=c.inbox_id WHERE i.user_id=? ORDER BY i.email`).all(session.user_id).map((row) => ({
        id: row.id, email: row.email, adapter_type: row.adapter_type, status: row.status,
        scopes: JSON.parse(String(row.granted_scopes)) as string[],
        services: connectedServices(JSON.parse(String(row.granted_scopes)) as string[]),
      })) : [];
    return { google_enabled: this.enabled, live_enabled: this.enabled && this.config.inboxLive, user,
      active_inbox_id: this.config.inboxLive ? session?.inbox_id ?? 'sandbox' : 'sandbox', inboxes };
  }

  isOwned(inboxId: string, userId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM inboxes WHERE id=? AND user_id=?').get(inboxId, userId));
  }

  select(session: OperatorSession, inboxId: string) {
    if (inboxId !== 'sandbox' && (!this.config.inboxLive || !this.isOwned(inboxId, session.user_id) || !this.connection(inboxId))) {
      throw new Error('INBOX_NOT_AVAILABLE');
    }
    this.db.prepare('UPDATE operator_sessions SET inbox_id=? WHERE token_hash=?').run(inboxId, session.token_hash);
  }

  begin(stage: AuthStage, browserCookie?: string, session?: OperatorSession, inboxId?: string,
    linked?: { sub: string; email: string }) {
    this.requireEnabled();
    if (stage !== 'identity' && (!this.config.inboxLive || !session)) throw new Error('OPERATOR_SESSION_REQUIRED');
    if (inboxId && (!session || !this.isOwned(inboxId, session.user_id))) throw new Error('INBOX_NOT_AVAILABLE');
    const browser = /^[\w-]{43}$/.test(browserCookie ?? '') ? browserCookie! : opaque();
    const id = opaque();
    const verifier = opaque();
    const nonce = opaque();
    this.db.prepare('DELETE FROM google_oauth_flows WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO google_oauth_flows VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, hash(browser), verifier, nonce, stage, session?.token_hash ?? null, inboxId ?? null, Date.now() + 600_000, linked?.sub ?? null);
    const state = id + '.' + this.sign(id + '.' + browser);
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: this.config.googleClientId, redirect_uri: this.config.googleRedirectUri, response_type: 'code',
      scope: scopes[stage].join(' '), state, code_challenge: hash(verifier, 'base64url'), code_challenge_method: 'S256',
      ...(stage === 'identity' ? { nonce, ...(session ? { prompt: 'select_account' } : {}) } :
        { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', ...(linked ? { login_hint: linked.email } : {}) }),
    }).toString();
    return { url: auth.toString(), cookie: cookie(flowCookie, browser, 600, this.secure) };
  }

  private async tokens(data: Record<string, string>) {
    const response = await this.request(tokenEndpoint, {
      method: 'POST', signal: AbortSignal.timeout(12_000), redirect: 'error',
      body: new URLSearchParams({ ...data, client_id: this.config.googleClientId, client_secret: this.config.googleClientSecret }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(failure?.error === 'invalid_grant' ? 'GOOGLE_REAUTH_REQUIRED' : 'GOOGLE_TOKEN_EXCHANGE_FAILED');
    }
    const result = await response.json() as GoogleTokens;
    if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('GOOGLE_TOKENS_INVALID');
    return result;
  }

  async complete(code: string, state: string, cookies?: string) {
    this.requireEnabled();
    const browser = readCookie(cookies, flowCookie);
    const [id, signature, extra] = state.split('.');
    if (extra || !/^[\w-]{43}$/.test(id) || !/^[\w-]{43}$/.test(signature ?? '') ||
        !/^[\w-]{43}$/.test(browser) || !timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(id + '.' + browser)))) {
      throw new Error('INVALID_GOOGLE_STATE');
    }
    const flow = this.db.prepare('DELETE FROM google_oauth_flows WHERE id=? AND browser_hash=? AND expires_at>? RETURNING *')
      .get(id, hash(browser), Date.now()) as Flow | undefined;
    if (!flow || (flow.intent !== 'identity' && this.session(cookies)?.token_hash !== flow.session_hash)) {
      throw new Error('INVALID_GOOGLE_STATE');
    }
    const result = await this.tokens({
      grant_type: 'authorization_code', code, redirect_uri: this.config.googleRedirectUri, code_verifier: flow.code_verifier,
    });
    if (flow.intent === 'identity') {
      if (!result.id_token) throw new Error('GOOGLE_IDENTITY_INVALID');
      const identity = await this.verifyIdentity(result.id_token).catch(() => undefined);
      if (!identity?.sub || !identity.email_verified || !identity.email || identity.nonce !== flow.nonce) throw new Error('GOOGLE_IDENTITY_INVALID');
      if (flow.session_hash) {
        const current = this.session(cookies);
        if (!current || current.token_hash !== flow.session_hash) throw new Error('INVALID_GOOGLE_STATE');
        return { next: this.begin('readonly', browser, current, undefined, identity) };
      }
      this.logout(this.session(cookies));
      const user = this.db.prepare(`INSERT INTO users (id,google_sub,email,name,picture,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE
        SET email=excluded.email,name=excluded.name,picture=excluded.picture,updated_at=excluded.updated_at RETURNING id`)
        .get(randomUUID(), identity.sub, identity.email, identity.name ?? '', safePicture(identity.picture), nowIso())!;
      const raw = opaque();
      this.db.prepare('INSERT INTO operator_sessions VALUES (?,?,?,?)').run(hash(raw), user.id, 'sandbox', Date.now() + sessionAge * 1000);
      return { session: cookie(sessionCookie, raw, sessionAge, this.secure) };
    }
    const granted = exactScopes(result.scope);
    if (!mayUse(granted, 'mail:read') && !mayUse(granted, 'calendar:read')) throw new Error('GOOGLE_SCOPES_UNVERIFIED');
    const profile = await this.request('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + result.access_token }, redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (!profile.ok) throw new Error('GOOGLE_IDENTITY_INVALID');
    const identity = await profile.json() as Identity;
    if (!identity.sub || !identity.email || !identity.email_verified) throw new Error('GOOGLE_IDENTITY_INVALID');
    if (flow.expected_sub && flow.expected_sub !== identity.sub) throw new Error('GOOGLE_ACCOUNT_MISMATCH');
    const session = this.session(cookies);
    if (!session || session.token_hash !== flow.session_hash) throw new Error('INVALID_GOOGLE_STATE');
    const stored = this.db.prepare('SELECT id FROM inboxes WHERE user_id=? AND google_sub=?')
      .get(session.user_id, identity.sub);
    if (flow.inbox_id && stored?.id !== flow.inbox_id) throw new Error('GOOGLE_ACCOUNT_MISMATCH');
    const idForInbox = stored?.id ? String(stored.id) : randomUUID();
    const current = this.connection(idForInbox);
    if (current?.status === 'revoked') throw new Error('GOOGLE_REAUTH_REQUIRED');
    if (flow.intent !== 'readwrite') {
      const previous = current ? JSON.parse(current.granted_scopes) as string[] : [];
      if (scopes.readwrite.some((scope) => granted.includes(scope) && !previous.includes(scope))) throw new Error('GOOGLE_SCOPE_NOT_ALLOWED');
    }
    const refresh = result.refresh_token ?? (current ? this.decrypt(current, 'refresh') : '');
    if (!refresh) throw new Error('GOOGLE_OFFLINE_CONSENT_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO inboxes VALUES (?,?,'gmail_oauth',?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email`)
        .run(idForInbox, session.user_id, identity.sub, identity.email);
      this.save(idForInbox, session.user_id, identity, result, refresh, granted);
      this.select(session, idForInbox);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inboxId: idForInbox };
  }

  browser(cookies?: string) { return readCookie(cookies, flowCookie); }

  connection(inboxId: string) {
    return this.db.prepare('SELECT * FROM oauth_connections WHERE inbox_id=?').get(inboxId) as Connection | undefined;
  }

  activeInboxIds() {
    return this.db.prepare("SELECT inbox_id FROM oauth_connections WHERE status='active'").all().map((row) => String(row.inbox_id));
  }

  requireScope(inboxId: string, capability: GoogleCapability) {
    const row = this.connection(inboxId);
    if (!row || row.status !== 'active') throw new Error('GOOGLE_REAUTH_REQUIRED');
    if (!mayUse(JSON.parse(row.granted_scopes), capability)) throw new Error('SCOPE_UPGRADE_REQUIRED');
  }

  private encrypt(inboxId: string, field: string, value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryption, iv).setAAD(Buffer.from(inboxId + ':' + field));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return { data: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }

  private decrypt(row: Connection, field: 'access' | 'refresh') {
    const iv = JSON.parse(row.iv)[field];
    const tag = JSON.parse(row.auth_tag)[field];
    const cipher = createDecipheriv('aes-256-gcm', this.encryption, Buffer.from(iv, 'base64url'))
      .setAAD(Buffer.from(row.inbox_id + ':' + field)).setAuthTag(Buffer.from(tag, 'base64url'));
    const encrypted = field === 'access' ? row.encrypted_access_token : row.encrypted_refresh_token;
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
  }

  private save(inbox: string, user: string, identity: Pick<Identity, 'sub' | 'email'>, tokens: GoogleTokens, refreshToken: string, granted: string[]) {
    const access = this.encrypt(inbox, 'access', tokens.access_token);
    const refresh = this.encrypt(inbox, 'refresh', refreshToken);
    this.db.prepare(`INSERT INTO oauth_connections VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?) ON CONFLICT(inbox_id) DO UPDATE SET
      email=excluded.email,granted_scopes=excluded.granted_scopes,encrypted_access_token=excluded.encrypted_access_token,
      encrypted_refresh_token=excluded.encrypted_refresh_token,iv=excluded.iv,auth_tag=excluded.auth_tag,
      expires_at=excluded.expires_at,status='active',updated_at=excluded.updated_at`).run(
      randomUUID(), user, inbox, identity.sub, identity.email, JSON.stringify(granted), access.data, refresh.data,
      JSON.stringify({ access: access.iv, refresh: refresh.iv }), JSON.stringify({ access: access.tag, refresh: refresh.tag }),
      Date.now() + tokens.expires_in * 1000, nowIso(),
    );
  }

  private refresh(inboxId: string, rejected?: string) {
    const running = this.refreshing.get(inboxId);
    if (running) return running;
    const refresh = (async () => {
      const row = this.connection(inboxId);
      if (!row || row.status !== 'active') throw new Error('GOOGLE_REAUTH_REQUIRED');
      if (rejected && row.expires_at > Date.now() + retiring && this.decrypt(row, 'access') !== rejected) return this.decrypt(row, 'access');
      const key = this.decrypt(row, 'refresh');
      try {
        const result = await this.tokens({ grant_type: 'refresh_token', refresh_token: key });
        const granted = result.scope ? exactScopes(result.scope) : JSON.parse(row.granted_scopes) as string[];
        const latest = this.connection(inboxId);
        if (latest?.status !== 'active' || latest.encrypted_refresh_token !== row.encrypted_refresh_token) throw new Error('GOOGLE_REAUTH_REQUIRED');
        this.save(inboxId, row.user_id, { sub: row.google_sub, email: row.email }, result, result.refresh_token ?? key, granted);
        return result.access_token;
      } catch {
        this.db.prepare("UPDATE oauth_connections SET status='reauth_required', updated_at=? WHERE inbox_id=? AND encrypted_refresh_token=?")
          .run(nowIso(), inboxId, row.encrypted_refresh_token);
        throw new Error('GOOGLE_REAUTH_REQUIRED');
      }
    })().finally(() => this.refreshing.delete(inboxId));
    this.refreshing.set(inboxId, refresh);
    return refresh;
  }

  private token(inboxId: string) {
    const row = this.connection(inboxId);
    if (!row || row.status !== 'active') throw new Error('GOOGLE_REAUTH_REQUIRED');
    return row.expires_at > Date.now() + retiring ? Promise.resolve(this.decrypt(row, 'access')) : this.refresh(inboxId);
  }

  redact(inboxId: string, text: string) {
    const row = this.connection(inboxId);
    const secrets = [this.config.googleClientSecret, ...(row ? [this.decrypt(row, 'access'), this.decrypt(row, 'refresh')] : [])];
    text = text.replace(/\bAuthorization\s*:\s*Bearer\s+[^\s]+/gi, '[redacted authorization]');
    for (const value of secrets) if (value) text = text.replaceAll(value, '[redacted]');
    return text.replace(/\bBearer\s+[A-Za-z\d._~-]+/gi, 'Bearer [redacted]');
  }

  async api(inboxId: string, capability: GoogleCapability, url: string, guard: () => void, init: RequestInit = {}, cost = 10) {
    let token = await this.tokenFor(inboxId, capability, guard);
    for (let attempts = 0, refreshes = 0; ; ) {
      guard();
      init.signal?.throwIfAborted();
      this.requireScope(inboxId, capability);
      const time = Date.now();
      const account = this.connection(inboxId)!.google_sub + ':' + capability.split(':')[0];
      const events = (this.quota.get(account) ?? []).filter((item) => time - item.time < 60_000);
      if (events.reduce((sum, item) => sum + item.units, cost) > 6000) throw new Error('GOOGLE_RATE_LIMIT');
      events.push({ time, units: cost });
      this.quota.set(account, events);
      const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + token);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const response = await this.request(url, { ...init, headers, signal, redirect: 'error' }).catch(() => {
        init.signal?.throwIfAborted();
        throw new Error('GOOGLE_API_UNAVAILABLE');
      });
      if (response.status === 401 && refreshes++ === 0) {
        guard();
        token = await this.refresh(inboxId, token);
        continue;
      }
      if (response.status === 401) {
        this.db.prepare("UPDATE oauth_connections SET status='reauth_required',updated_at=? WHERE inbox_id=?").run(nowIso(), inboxId);
        throw new Error('GOOGLE_REAUTH_REQUIRED');
      }
      if (response.status === 403) {
        const forbidden = await response.clone().json().catch(() => null) as { error?: { errors?: { reason: string }[] } } | null;
        if (!forbidden?.error?.errors?.some((reason) => ['userRateLimitExceeded','rateLimitExceeded'].includes(reason.reason))) {
          throw new Error('SCOPE_UPGRADE_REQUIRED');
        }
      } else if (response.status !== 429) return response;
      if (attempts >= 2) throw new Error('GOOGLE_RATE_LIMIT');
      const after = response.headers.get('retry-after');
      const delay = after && /^\d+$/.test(after) ? Number(after) * 1000 : 200 * 2 ** attempts;
      if (delay > 5000) throw new Error('GOOGLE_RATE_LIMIT');
      await new Promise<void>((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 100)));
      attempts++;
    }
  }

  private tokenFor(inboxId: string, scope: GoogleCapability, guard: () => void) {
    guard();
    this.requireScope(inboxId, scope);
    return this.token(inboxId);
  }

  mint(session: OperatorSession, inboxId: string, scopes: string[]) {
    if (inboxId !== 'sandbox' && scopes.includes('inbox:manage')) throw new Error('MCP_SCOPE_REQUIRED');
    if (inboxId !== 'sandbox' && (!this.isOwned(inboxId, session.user_id) || this.connection(inboxId)?.status !== 'active')) {
      throw new Error('INBOX_NOT_AVAILABLE');
    }
    return this.issueInboxToken(session.user_id, inboxId, scopes);
  }

  mintSandbox(scopes: string[]) {
    this.db.prepare("INSERT OR IGNORE INTO users (id,google_sub,email,name,updated_at) VALUES (?,?,'sandbox@clam.local','Local sandbox',?)")
      .run(sandboxMcpOwner, 'local:' + sandboxMcpOwner, new Date().toISOString());
    return this.issueInboxToken(sandboxMcpOwner, 'sandbox', scopes);
  }

  private issueInboxToken(userId: string, inboxId: string, scopes: string[]) {
    const raw = 'clm_inbox_' + opaque();
    const expires = Date.now() + 30 * 86_400_000;
    const digest = hash(raw);
    this.db.prepare('INSERT INTO inbox_mcp_tokens VALUES (?,?,?,?,?)')
      .run(digest, userId, inboxId, JSON.stringify([...new Set(scopes)]), expires);
    return { token: raw, token_id: digest.slice(0, 24), expires_at: new Date(expires).toISOString() };
  }

  listInboxTokens(userId: string, inboxId: string) {
    return this.db.prepare('SELECT substr(token_hash,1,24) AS id, scopes, expires_at FROM inbox_mcp_tokens WHERE user_id=? AND inbox_id=? AND expires_at>? ORDER BY expires_at DESC')
      .all(userId, inboxId, Date.now()).map((row) => ({
        token_id: String(row.id), scopes: JSON.parse(String(row.scopes)) as string[],
        expires_at: new Date(Number(row.expires_at)).toISOString(),
      }));
  }

  revokeInboxToken(userId: string, inboxId: string, id: string) {
    return Number(this.db.prepare('DELETE FROM inbox_mcp_tokens WHERE user_id=? AND inbox_id=? AND substr(token_hash,1,24)=?')
      .run(userId, inboxId, id).changes) > 0;
  }

  authenticateMcp(token: string): McpGrant | undefined {
    if (!/^clm_inbox_[\w-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare('SELECT * FROM inbox_mcp_tokens WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    if (!row || (row.inbox_id !== 'sandbox' && (!this.config.inboxLive || !this.isOwned(String(row.inbox_id), String(row.user_id))))) return undefined;
    return { userId: String(row.user_id), inboxId: String(row.inbox_id), scopes: JSON.parse(String(row.scopes)) as string[],
      tokenId: hash(token).slice(0, 24) };
  }

  async disconnect(session: OperatorSession, inboxId: string, revokeMcp: boolean) {
    if (!this.isOwned(inboxId, session.user_id)) throw new Error('INBOX_NOT_AVAILABLE');
    const row = this.connection(inboxId);
    if (!row) throw new Error('INBOX_NOT_AVAILABLE');
    this.db.prepare("UPDATE oauth_connections SET status='revoked',updated_at=? WHERE inbox_id=?").run(nowIso(), inboxId);
    let remoteRevoked = false;
    try {
      const response = await this.request('https://oauth2.googleapis.com/revoke', {
        method: 'POST', body: new URLSearchParams({ token: this.decrypt(row, 'refresh') }),
        signal: AbortSignal.timeout(12_000), redirect: 'error',
      });
      remoteRevoked = response.ok;
    } catch {
      remoteRevoked = false;
    } finally {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM oauth_connections WHERE inbox_id=? AND status=?').run(inboxId, 'revoked');
        if (revokeMcp) this.db.prepare('DELETE FROM inbox_mcp_tokens WHERE inbox_id=?').run(inboxId);
        this.db.prepare("UPDATE operator_sessions SET inbox_id='sandbox' WHERE inbox_id=?").run(inboxId);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return remoteRevoked;
  }
}

function safePicture(value?: string) {
  if (!value) return null;
  const parsed = URL.canParse(value) ? new URL(value) : null;
  return parsed?.protocol === 'https:' && /(?:^|\.)googleusercontent\.com$/.test(parsed.hostname) ? parsed.toString() : null;
}
