import { siftvaneEnvironment } from '@siftvane/shared';

export const agentProviders = ['gemini', 'openai', 'anthropic', 'groq', 'ollama'] as const;
export type AgentProvider = typeof agentProviders[number];
export type AgentMode = 'llm' | 'offline-smoke';

const keyNames = {
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY',
} as const;

const defaults: Record<AgentProvider, string> = {
  gemini: 'gemini-3.1-flash-lite', openai: 'gpt-4o-mini',
  anthropic: '', groq: 'openai/gpt-oss-20b', ollama: 'qwen2.5:7b',
};

export interface ModelUsage {
  provider: AgentProvider | 'local';
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number;
  estimated_usd: number | null;
}

export interface AgentConfig {
  mode: AgentMode;
  provider: ModelUsage['provider'];
  model: string;
  key?: string;
  endpoint?: string;
  timeoutMs: number;
  rates: { input: number | null; output: number | null };
}

const rate = (value?: string, fallback: number | null = null) =>
  value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;

export function resolveAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  env = siftvaneEnvironment({ ...env });
  const requestedMode = env.SIFTVANE_AGENT_MODE?.trim();
  if (requestedMode && requestedMode !== 'llm' && requestedMode !== 'offline-smoke') {
    throw new Error('Invalid SIFTVANE_AGENT_MODE. Use llm or offline-smoke.');
  }

  const name = env.SIFTVANE_LLM_PROVIDER?.trim().toLowerCase();
  const selected = agentProviders.find((provider) => provider === name);
  const automatic = agentProviders.find((provider) => provider === 'ollama'
    ? Boolean(env.OLLAMA_BASE_URL?.trim())
    : Boolean(env[keyNames[provider]]?.trim()));
  const provider = selected ?? automatic;
  const mode: AgentMode = requestedMode === 'llm' || requestedMode === 'offline-smoke' ? requestedMode : automatic || selected === 'ollama' ? 'llm' : 'offline-smoke';
  if (mode === 'offline-smoke') {
    return { mode, provider: 'local', model: 'deterministic-parser', timeoutMs: 0, rates: { input: 0, output: 0 } };
  }
  if (!provider || (name && name !== 'local_heuristic' && !selected)) {
    throw new Error('Set a supported SIFTVANE_LLM_PROVIDER and its key or Ollama endpoint.');
  }
  const key = provider === 'ollama' ? undefined : env[keyNames[provider]]?.trim();
  if (provider !== 'ollama' && !key) throw new Error('Missing ' + keyNames[provider] + ' for LLM mode.');
  const model = env.SIFTVANE_LLM_MODEL?.trim() || defaults[provider];
  if (!model) throw new Error('Set SIFTVANE_LLM_MODEL for the selected provider.');
  const pricing = provider === 'gemini' && model.replace(/^models\//, '') === defaults.gemini
    ? { input: 0.25, output: 1.5 } : { input: null, output: null };
  const timeout = Number(env.SIFTVANE_AGENT_TIMEOUT_MS || (provider === 'ollama' ? 180_000 : 45_000));
  return {
    mode, provider, model, key,
    endpoint: provider === 'ollama' ? env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434' : undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(300_000, timeout) : 45_000,
    rates: provider === 'ollama' ? { input: 0, output: 0 } : {
      input: rate(env.SIFTVANE_MODEL_INPUT_USD_PER_M, pricing.input),
      output: rate(env.SIFTVANE_MODEL_OUTPUT_USD_PER_M, pricing.output),
    },
  };
}

export function emptyUsage(config: AgentConfig): ModelUsage {
  return {
    provider: config.provider, model: config.model,
    prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, estimated_usd: 0,
  };
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const sum = (left: number | null, right: number | null) =>
    left === null || right === null ? null : left + right;
  return {
    ...a, prompt_tokens: sum(a.prompt_tokens, b.prompt_tokens),
    completion_tokens: sum(a.completion_tokens, b.completion_tokens),
    latency_ms: a.latency_ms + b.latency_ms, estimated_usd: sum(a.estimated_usd, b.estimated_usd),
  };
}
