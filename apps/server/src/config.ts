import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siftvaneEnvironment } from '@siftvane/shared';

siftvaneEnvironment(process.env);
export const workspaceRoot = process.env.SIFTVANE_WORKSPACE_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
if (process.env.NODE_ENV !== 'test') dotenv.config({ path: path.join(workspaceRoot, '.env') });
siftvaneEnvironment(process.env);

export interface SiftvaneConfig {
  port: number;
  bindHost: string;
  webPort: number;
  publicUrl: string;
  databasePath: string;
  tracesDir: string;
  lockfile: string;
  inboxLive: boolean;
  calendarId: string;
  operatorToken: string;
  webOrigin: string;
  encryptionKey: Buffer;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  mailAttachmentsDir: string;
  googleTokenKey: string;
  sessionSecret: string;
  circuitBreaker: {
    violationThreshold: number;
    windowSeconds: number;
    maxCallsPerMin: number;
    tripOnCriticalInjection: boolean;
  };

}

function existingLocalPath(input: string, filename: string, legacyFilename: string) {
  const resolved = path.resolve(workspaceRoot, input);
  if (path.basename(resolved) !== filename || fs.existsSync(resolved)) return resolved;
  const legacy = path.join(path.dirname(resolved), legacyFilename);
  return fs.existsSync(legacy) ? legacy : resolved;
}

function resolveEncryptionKey(databasePath: string): Buffer {
  const raw = process.env.SIFTVANE_ENCRYPTION_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
  }

  if (databasePath === ':memory:') {
    return crypto.randomBytes(32);
  }

  const keyFile = existingLocalPath(process.env.SIFTVANE_KEY_FILE?.trim() || '.siftvane.key', '.siftvane.key', '.clam.key');
  try {
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        return Buffer.from(hex, 'hex');
      }
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, generated.toString('hex') + '\n', { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32);
  }
}

export function resolveDatabasePath(): string {
  const databaseInput = process.env.DATABASE_PATH?.trim() || 'data/siftvane.db';
  return databaseInput === ':memory:' ? databaseInput : existingLocalPath(databaseInput, 'siftvane.db', 'clam.db');
}

export function loadConfig(): SiftvaneConfig {
  const databasePath = resolveDatabasePath();

  return {
    port: Number(process.env.PORT || 4000),
    bindHost: process.env.SIFTVANE_BIND_HOST?.trim() || '127.0.0.1',
    webPort: Number(process.env.WEB_PORT || 3000),
    publicUrl: process.env.SIFTVANE_PUBLIC_URL?.trim() || 'http://localhost:4000',
    databasePath,
    tracesDir: path.resolve(workspaceRoot, process.env.SIFTVANE_TRACES_DIR?.trim() || 'traces'),
    lockfile: path.resolve(workspaceRoot, process.env.SIFTVANE_KILLSWITCH_FILE?.trim() || '.killswitch'),
    inboxLive: process.env.SIFTVANE_INBOX_LIVE === 'true',
    calendarId: process.env.SIFTVANE_GOOGLE_CALENDAR_ID?.trim() || 'primary',
    operatorToken: process.env.SIFTVANE_OPERATOR_TOKEN?.trim() || '',
    webOrigin: process.env.SIFTVANE_WEB_ORIGIN?.trim() || `http://localhost:${Number(process.env.WEB_PORT || 3000)}`,
    encryptionKey: resolveEncryptionKey(databasePath),
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
    googleRedirectUri:
      process.env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:4000/api/auth/google/callback',
    mailAttachmentsDir: path.resolve(workspaceRoot, process.env.SIFTVANE_MAIL_ATTACHMENTS_DIR?.trim() || 'workspace/mail-attachments'),
    googleTokenKey: process.env.SIFTVANE_TOKEN_ENCRYPTION_KEY?.trim() || '',
    sessionSecret: process.env.SIFTVANE_SESSION_SECRET?.trim() || '',
    circuitBreaker: {
      violationThreshold: Number(process.env.SIFTVANE_CB_VIOLATION_THRESHOLD || 3),
      windowSeconds: Number(process.env.SIFTVANE_CB_WINDOW_SECONDS || 30),
      maxCallsPerMin: Number(process.env.SIFTVANE_CB_MAX_CALLS_PER_MIN || 25),
      tripOnCriticalInjection: process.env.SIFTVANE_CB_TRIP_CRITICAL_INJECTION !== 'false',
    },
  };
}
