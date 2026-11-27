import { eq } from 'drizzle-orm';
import type { MailMode } from '@siftvane/shared';
import type { SiftvaneConfig } from '../config.js';
import type { SiftvaneDatabase } from '../db/index.js';
import { vaultSecrets } from '../db/schema.js';
import { SandboxMailProvider } from './sandbox.js';
import type { MailProvider } from './types.js';
import { CryptoVault } from './vault.js';

const VAULT_MAIL_MODE_KEY = 'mail_mode_config';

export class MailService {
  public readonly sandbox = new SandboxMailProvider();
  constructor(
    private readonly db: SiftvaneDatabase,
    private readonly vault: CryptoVault,
    private readonly config: SiftvaneConfig
  ) {}

  getMode(): MailMode { return 'sandbox'; }

  async setMode(mode: MailMode): Promise<MailMode> {
    if (mode === 'gmail') throw new Error('Use Connections to select an authorized Gmail inbox.');
    await this.setVaultJson(VAULT_MAIL_MODE_KEY, { mode });
    return 'sandbox';
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

  async getGmailStatus() {
    return {
      mode: 'sandbox' as const,
      oauthConfigured: Boolean(this.config.googleClientId && this.config.googleClientSecret),
      connected: false, email: null, scopes: [],
    };
  }

  legacyMutationAllowed(): boolean { return true; }
  getActiveProvider(): MailProvider { return this.sandbox; }
}
