import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { agentProviders, resolveAgentConfig, type AgentConfig, type AgentProvider } from '../inbox/agentConfig.js';
import { callModel } from './llmPlanner.js';

/** Suggested models per provider; the user may type any model the provider offers. */
export const providerModels: Record<AgentProvider, string[]> = {
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.1-pro'],
  openai: ['gpt-4o-mini', 'gpt-4.1'],
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
  groq: ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
  ollama: ['qwen2.5:7b', 'llama3.1:8b'],
};

const keyNames: Record<Exclude<AgentProvider, 'ollama'>, string> = {
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY',
};

type Row = { provider: string; model: string; endpoint: string | null; key_data: string | null; key_iv: string | null; key_tag: string | null; updated_at: string };
export type AiChoice = { provider: AgentProvider | 'off'; model?: string; api_key?: string; endpoint?: string };

/**
 * The AI provider that powers agent planning and reading, chosen in the website (one per Siftvane server).
 * API keys are stored AES-256-GCM encrypted and never returned; without a saved choice the .env configuration applies.
 */
export class AiSettings {
  constructor(private readonly db: DatabaseSync, private readonly secret: string, private readonly fallback: AgentConfig,
    private readonly apply: (config: AgentConfig) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT,
      key_data TEXT, key_iv TEXT, key_tag TEXT, updated_at TEXT NOT NULL)`);
  }

  private row() { return this.db.prepare('SELECT * FROM ai_settings WHERE id=1').get() as Row | undefined; }

  private cipherKey() {
    if (!/^[0-9a-f]{64}$/i.test(this.secret)) throw new Error('AI_KEY_STORAGE_UNAVAILABLE');
    return Buffer.from(this.secret, 'hex');
  }

  private seal(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey(), iv).setAAD(Buffer.from('ai_settings:key'));
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return { data: data.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }

  private open(row: Row) {
    if (!row.key_data || !row.key_iv || !row.key_tag) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.cipherKey(), Buffer.from(row.key_iv, 'base64url')).setAAD(Buffer.from('ai_settings:key'));
    decipher.setAuthTag(Buffer.from(row.key_tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(row.key_data, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Builds a runnable model configuration (throws a readable code when something is missing). */
  private build(choice: AiChoice, key?: string): AgentConfig {
    if (choice.provider === 'off') return resolveAgentConfig({ SIFTVANE_AGENT_MODE: 'offline-smoke' });
    const env: Record<string, string> = { SIFTVANE_AGENT_MODE: 'llm', SIFTVANE_LLM_PROVIDER: choice.provider };
    if (choice.model) env.SIFTVANE_LLM_MODEL = choice.model;
    if (choice.provider === 'ollama') env.OLLAMA_BASE_URL = choice.endpoint || 'http://127.0.0.1:11434';
    else if (key) env[keyNames[choice.provider]] = key;
    else throw new Error('AI_KEY_REQUIRED');
    try { return resolveAgentConfig(env); } catch { throw new Error('AI_SETTINGS_INVALID'); }
  }

  /** Applies the saved choice at startup; a broken saved choice leaves the .env configuration in place. */
  load() {
    const row = this.row();
    if (!row) return;
    try { this.apply(this.build({ provider: row.provider as AiChoice['provider'], model: row.model, endpoint: row.endpoint ?? undefined }, this.open(row))); }
    catch { /* keep the environment configuration */ }
  }

  view(current: AgentConfig) {
    const row = this.row();
    return {
      source: row ? 'website' : 'environment',
      provider: current.mode === 'llm' ? current.provider : 'off',
      model: current.mode === 'llm' ? current.model : null,
      endpoint: current.provider === 'ollama' ? current.endpoint ?? null : null,
      has_key: Boolean(row?.key_data) || (current.mode === 'llm' && current.provider !== 'ollama' && current.provider !== 'local'),
      providers: [...agentProviders], suggestions: providerModels,
    };
  }

  /** Saves and applies a new choice. An omitted key keeps the saved one when the provider is unchanged. */
  save(choice: AiChoice) {
    const row = this.row();
    const keep = !choice.api_key && row && row.provider === choice.provider ? this.open(row) : undefined;
    const key = choice.api_key?.trim() || keep;
    const config = this.build(choice, key);
    const sealed = key && choice.provider !== 'ollama' && choice.provider !== 'off' ? this.seal(key) : null;
    this.db.prepare(`INSERT INTO ai_settings VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model,
      endpoint=excluded.endpoint, key_data=excluded.key_data, key_iv=excluded.key_iv, key_tag=excluded.key_tag, updated_at=excluded.updated_at`)
      .run(choice.provider, config.model, choice.provider === 'ollama' ? config.endpoint ?? null : null,
        sealed?.data ?? null, sealed?.iv ?? null, sealed?.tag ?? null, new Date().toISOString());
    this.apply(config);
    return config;
  }

  /** Forgets the website choice and goes back to the .env configuration. */
  reset() {
    this.db.prepare('DELETE FROM ai_settings WHERE id=1').run();
    this.apply(this.fallback);
  }

  /** One tiny call to check the provider answers (the key and model work). */
  async test(config: AgentConfig) {
    const started = Date.now();
    try {
      const output = await callModel(config, 'Reply with JSON only: {"ok": true}', undefined, 50) as { ok?: unknown };
      return { ok: output?.ok === true, latency_ms: Date.now() - started, error: output?.ok === true ? null : 'UNEXPECTED_ANSWER' };
    } catch (error) {
      return { ok: false, latency_ms: Date.now() - started, error: error instanceof Error ? error.message : 'MODEL_UNAVAILABLE' };
    }
  }
}
