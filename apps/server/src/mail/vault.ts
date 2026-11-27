import crypto from 'node:crypto';

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export class CryptoVault {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('AES-256-GCM key must be exactly 32 bytes');
    }
    this.key = Buffer.from(key);
  }

  encryptString(plaintext: string): EncryptedBlob {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  decryptString(blob: EncryptedBlob): string {
    const iv = Buffer.from(blob.iv, 'base64');
    const authTag = Buffer.from(blob.authTag, 'base64');
    const encrypted = Buffer.from(blob.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  encryptJson(value: unknown): EncryptedBlob {
    return this.encryptString(JSON.stringify(value));
  }

  decryptJson<T>(blob: EncryptedBlob): T {
    return JSON.parse(this.decryptString(blob)) as T;
  }
}

export interface EphemeralCipherBox {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Encrypts sensitive ephemeral payloads strictly in RAM with a per-process random key.
 * Allows wiping the buffer on resolution or expiry so zero payload bytes linger.
 */
export class EphemeralRamVault {
  private readonly ephemeralKey: Buffer;

  constructor() {
    this.ephemeralKey = crypto.randomBytes(32);
  }

  seal<T>(value: T): EphemeralCipherBox {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.ephemeralKey, iv);
    const jsonBuf = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(jsonBuf), cipher.final()]);
    jsonBuf.fill(0);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
  }

  unseal<T>(box: EphemeralCipherBox): T {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.ephemeralKey, box.iv);
    decipher.setAuthTag(box.authTag);
    const decrypted = Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8')) as T;
    decrypted.fill(0);
    return parsed;
  }

  wipe(box: EphemeralCipherBox | undefined): void {
    if (!box) return;
    box.ciphertext.fill(0);
    box.iv.fill(0);
    box.authTag.fill(0);
  }
}

export function hashOpaqueId(value: string, salt = 'clam-zero-retention'): string {
  return crypto.createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 24);
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateAgentToken(): { raw: string; prefix: string; hash: string } {
  const secret = crypto.randomBytes(20).toString('hex');
  const raw = `siftvane_ag_${secret}`;
  const prefix = `siftvane_ag_${secret.slice(0, 6)}...${secret.slice(-4)}`;
  const hash = hashToken(raw);
  return { raw, prefix, hash };
}
