import type { AgentConfig, ModelUsage } from './agentConfig.js';

/** The usage fields each provider reports, as returned on the wire. */
export interface ProviderWire {
  model?: string;
  modelVersion?: string;
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  content?: { text?: string }[];
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function providerUsage(config: AgentConfig, wire: ProviderWire | undefined, latencyMs: number): ModelUsage {
  let prompt: number | null = null;
  let completion: number | null = null;
  if (config.provider === 'gemini') {
    prompt = count(wire?.usageMetadata?.promptTokenCount);
    const output = count(wire?.usageMetadata?.candidatesTokenCount);
    completion = output === null ? null : output + (count(wire?.usageMetadata?.thoughtsTokenCount) ?? 0);
  } else if (config.provider === 'ollama') {
    prompt = count(wire?.prompt_eval_count);
    completion = count(wire?.eval_count);
  } else {
    prompt = count(wire?.usage?.prompt_tokens ?? wire?.usage?.input_tokens);
    completion = count(wire?.usage?.completion_tokens ?? wire?.usage?.output_tokens);
  }
  return {
    provider: config.provider, model: wire?.modelVersion ?? wire?.model ?? config.model,
    prompt_tokens: prompt, completion_tokens: completion, latency_ms: latencyMs,
    estimated_usd: config.rates.input !== null && config.rates.output !== null &&
      prompt !== null && completion !== null ? (prompt * config.rates.input + completion * config.rates.output) / 1e6 : null,
  };
}
