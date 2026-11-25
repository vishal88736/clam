import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmProvider, MailMode } from '@clam/shared';

export const workspaceRoot = process.env.CLAM_WORKSPACE_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(workspaceRoot, '.env') });

export interface ClamConfig {
  port: number;
  bindHost: string;
  webPort: number;
  publicUrl: string;
  databasePath: string;
  artifactsDir: string;
  tracesDir: string;
  lockfile: string;
  inboxLive: boolean;
  calendarId: string;
  operatorToken: string;
  webOrigin: string;
  encryptionKey: Buffer;
  defaultMailMode: MailMode;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  llmProvider: LlmProvider;
  llmModel: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  ollamaBaseUrl: string;
  classifierTimeoutMs: number;
  approvalTtlSeconds: number;
  circuitBreaker: {
    violationThreshold: number;
    windowSeconds: number;
    maxCallsPerMin: number;
    tripOnCriticalInjection: boolean;
  };
  slack: {
    botToken: string;
    channelId: string;
    webhookUrl: string;
    signingSecret: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
    webhookSecret: string;
  };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    recipientNumber: string;
    verifyToken: string;
    appSecret: string;
  };
}

function resolveEncryptionKey(databasePath: string): Buffer {
  const raw = process.env.CLAM_ENCRYPTION_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
  }

  if (databasePath === ':memory:') {
    return crypto.randomBytes(32);
  }

  const keyFile = path.resolve(workspaceRoot, process.env.CLAM_KEY_FILE?.trim() || '.clam.key');
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

export function loadConfig(): ClamConfig {
  const databaseInput = process.env.DATABASE_PATH?.trim() || 'data/clam.db';
  const databasePath = databaseInput === ':memory:' ? databaseInput : path.resolve(workspaceRoot, databaseInput);
  const mailModeEnv = process.env.CLAM_MAIL_MODE?.trim().toLowerCase();
  const defaultMailMode: MailMode = mailModeEnv === 'gmail' ? 'gmail' : 'sandbox';

  const llmEnv = process.env.CLAM_LLM_PROVIDER?.trim().toLowerCase();
  const validProviders: LlmProvider[] = ['local_heuristic', 'openai', 'anthropic', 'gemini', 'ollama'];
  const llmProvider: LlmProvider = validProviders.includes(llmEnv as LlmProvider)
    ? (llmEnv as LlmProvider)
    : 'local_heuristic';

  return {
    port: Number(process.env.PORT || 4000),
    bindHost: process.env.CLAM_BIND_HOST?.trim() || '127.0.0.1',
    webPort: Number(process.env.WEB_PORT || 3000),
    publicUrl: process.env.CLAM_PUBLIC_URL?.trim() || 'http://localhost:4000',
    databasePath,
    artifactsDir: path.resolve(workspaceRoot, process.env.CLAM_ARTIFACTS_DIR?.trim() || 'artifacts'),
    tracesDir: path.resolve(workspaceRoot, process.env.CLAM_TRACES_DIR?.trim() || 'traces'),
    lockfile: path.resolve(workspaceRoot, process.env.CLAM_KILLSWITCH_FILE?.trim() || '.killswitch'),
    inboxLive: process.env.CLAM_INBOX_LIVE === 'true',
    calendarId: process.env.CLAM_GOOGLE_CALENDAR_ID?.trim() || 'primary',
    operatorToken: process.env.CLAM_OPERATOR_TOKEN?.trim() || '',
    webOrigin: process.env.CLAM_WEB_ORIGIN?.trim() || `http://localhost:${Number(process.env.WEB_PORT || 3000)}`,
    encryptionKey: resolveEncryptionKey(databasePath),
    defaultMailMode,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
    googleRedirectUri:
      process.env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:4000/api/auth/gmail/callback',
    llmProvider,
    llmModel: process.env.CLAM_LLM_MODEL?.trim() || '',
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || '',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434',
    classifierTimeoutMs: Number(process.env.CLAM_CLASSIFIER_TIMEOUT_MS || 8000),
    approvalTtlSeconds: Number(process.env.CLAM_APPROVAL_TTL_SECONDS || 900),
    circuitBreaker: {
      violationThreshold: Number(process.env.CLAM_CB_VIOLATION_THRESHOLD || 3),
      windowSeconds: Number(process.env.CLAM_CB_WINDOW_SECONDS || 30),
      maxCallsPerMin: Number(process.env.CLAM_CB_MAX_CALLS_PER_MIN || 25),
      tripOnCriticalInjection: process.env.CLAM_CB_TRIP_CRITICAL_INJECTION !== 'false',
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN?.trim() || '',
      channelId: process.env.SLACK_CHANNEL_ID?.trim() || '',
      webhookUrl: process.env.SLACK_WEBHOOK_URL?.trim() || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET?.trim() || '',
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || '',
      chatId: process.env.TELEGRAM_CHAT_ID?.trim() || '',
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || '',
    },
    whatsapp: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() || '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '',
      recipientNumber: process.env.WHATSAPP_RECIPIENT_NUMBER?.trim() || '',
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || '',
      appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || '',
    },
  };
}
