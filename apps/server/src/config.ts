import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LlmProvider, MailMode } from '@clam/shared';

export interface ClamConfig {
  port: number;
  webPort: number;
  publicUrl: string;
  databasePath: string;
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

  const keyFile = path.resolve(process.cwd(), '.clam.key');
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
  const databasePath = process.env.DATABASE_PATH?.trim() || path.resolve(process.cwd(), 'data/clam.db');
  const mailModeEnv = process.env.CLAM_MAIL_MODE?.trim().toLowerCase();
  const defaultMailMode: MailMode = mailModeEnv === 'gmail' ? 'gmail' : 'sandbox';

  const llmEnv = process.env.CLAM_LLM_PROVIDER?.trim().toLowerCase();
  const validProviders: LlmProvider[] = ['local_heuristic', 'openai', 'anthropic', 'gemini', 'ollama'];
  const llmProvider: LlmProvider = validProviders.includes(llmEnv as LlmProvider)
    ? (llmEnv as LlmProvider)
    : 'local_heuristic';

  return {
    port: Number(process.env.PORT || 4000),
    webPort: Number(process.env.WEB_PORT || 3000),
    publicUrl: process.env.CLAM_PUBLIC_URL?.trim() || 'http://localhost:4000',
    databasePath,
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
