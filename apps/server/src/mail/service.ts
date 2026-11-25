import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { MailMode } from '@clam/shared';
import type { ClamConfig } from '../config.js';
import type { ClamDatabase } from '../db/index.js';
import { vaultSecrets } from '../db/schema.js';
import { GmailMailProvider, type StoredGmailTokens } from './gmail.js';
import { SandboxMailProvider } from './sandbox.js';
import type { MailProvider } from './types.js';
import { CryptoVault } from './vault.js';

const VAULT_GMAIL_KEY = 'gmail_oauth_tokens';
const VAULT_MAIL_MODE_KEY = 'mail_mode_config';

export class MailService {
  public readonly sandbox = new SandboxMailProvider();
  private mode: MailMode;
  private pendingOauthStates = new Map<string, { scopes: string[]; createdAt: number }>();

  constructor(
    private readonly db: ClamDatabase,
    private readonly vault: CryptoVault,
    private readonly config: ClamConfig
  ) {
    this.mode = config.inboxLive ? config.defaultMailMode : 'sandbox';
  }

  async init(): Promise<void> {
    const existingMode = await this.getVaultJson<{ mode: MailMode }>(VAULT_MAIL_MODE_KEY);
    if ((this.config.inboxLive && existingMode?.mode === 'gmail') || existingMode?.mode === 'sandbox') {
      this.mode = existingMode.mode;
    }
  }

  getMode(): MailMode {
    return this.mode;
  }

  async setMode(mode: MailMode): Promise<MailMode> {
    if (mode === 'gmail') {
      if (!this.config.inboxLive) throw new Error('Enable CLAM_INBOX_LIVE to connect Gmail.');
      const tokens = await this.getGmailTokens();
      if (!tokens) {
        throw new Error('Cannot switch to Gmail mode before completing Google OAuth connection.');
      }
    }
    this.mode = mode;
    await this.setVaultJson(VAULT_MAIL_MODE_KEY, { mode });
    return this.mode;
  }

  async getVaultJson<T>(key: string): Promise<T | null> {
    const row = await this.db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.key, key))
      .get();
    if (!row) return null;
    try {
      return this.vault.decryptJson<T>({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      });
    } catch {
      return null;
    }
  }

  async setVaultJson(key: string, value: unknown): Promise<void> {
    const blob = this.vault.encryptJson(value);
    const now = new Date().toISOString();
    await this.db
      .insert(vaultSecrets)
      .values({
        key,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: vaultSecrets.key,
        set: {
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          updatedAt: now,
        },
      });
  }

  async deleteVaultKey(key: string): Promise<void> {
    await this.db.delete(vaultSecrets).where(eq(vaultSecrets.key, key));
  }

  async getGmailTokens(): Promise<StoredGmailTokens | null> {
    return this.getVaultJson<StoredGmailTokens>(VAULT_GMAIL_KEY);
  }

  async getGmailStatus() {
    const tokens = await this.getGmailTokens();
    return {
      mode: this.mode,
      oauthConfigured: Boolean(this.config.googleClientId && this.config.googleClientSecret),
      connected: Boolean(tokens),
      email: tokens?.email ?? null,
      scopes: tokens?.scope ? tokens.scope.split(' ').filter(Boolean) : [],
    };
  }

  createGmailProvider(): GmailMailProvider {
    return new GmailMailProvider(
      {
        clientId: this.config.googleClientId,
        clientSecret: this.config.googleClientSecret,
        redirectUri: this.config.googleRedirectUri,
      },
      {
        getTokens: () => this.getGmailTokens(),
        saveTokens: (tokens) => this.setVaultJson(VAULT_GMAIL_KEY, tokens),
      }
    );
  }

  startOAuthFlow(requestedScopes?: ('readonly' | 'compose' | 'modify')[]): {
    url: string;
    state: string;
  } {
    if (!this.config.inboxLive || !this.config.googleClientId || !this.config.googleClientSecret) {
      throw new Error(
        'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.'
      );
    }
    const scopeMap: Record<string, string> = {
      readonly: 'https://www.googleapis.com/auth/gmail.readonly',
      compose: 'https://www.googleapis.com/auth/gmail.compose',
      modify: 'https://www.googleapis.com/auth/gmail.modify',
    };
    const chosen = (requestedScopes?.length ? requestedScopes : ['readonly', 'compose', 'modify'])
      .map((s) => scopeMap[s])
      .filter(Boolean);
    if (this.config.inboxLive) chosen.push('https://www.googleapis.com/auth/calendar.events');

    const state = crypto.randomBytes(16).toString('hex');
    this.pendingOauthStates.set(state, { scopes: chosen, createdAt: Date.now() });

    const url = GmailMailProvider.buildAuthUrl({
      clientId: this.config.googleClientId,
      redirectUri: this.config.googleRedirectUri,
      scopes: chosen,
      state,
    });
    return { url, state };
  }

  async completeOAuthCallback(code: string, state: string): Promise<{ email: string | null }> {
    const entry = this.pendingOauthStates.get(state);
    if (!entry || Date.now() - entry.createdAt > 15 * 60 * 1000) {
      throw new Error('Invalid or expired OAuth state parameter.');
    }
    this.pendingOauthStates.delete(state);
    const provider = this.createGmailProvider();
    const tokens = await provider.exchangeCode(code);
    this.mode = 'gmail';
    await this.setVaultJson(VAULT_MAIL_MODE_KEY, { mode: 'gmail' });
    return { email: tokens.email ?? null };
  }

  async disconnectGmail(): Promise<void> {
    await this.deleteVaultKey(VAULT_GMAIL_KEY);
    this.mode = 'sandbox';
    await this.setVaultJson(VAULT_MAIL_MODE_KEY, { mode: 'sandbox' });
  }

  legacyMutationAllowed(): boolean {
    return this.mode === 'sandbox';
  }

  getActiveProvider(): MailProvider {
    if (this.mode === 'gmail') {
      return this.createGmailProvider();
    }
    return this.sandbox;
  }
}
