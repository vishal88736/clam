import { z } from 'zod';
import type { InboxIntent } from '@clam/shared';
import type { ClassifierRuntimeConfig } from '../policy/classifier.js';

type Usage = { input?: number; output?: number };
type ProviderWire = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  content?: { text?: string }[];
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};
type ProviderReply = { text: string; usage: Usage };
const assessmentSchema = z.object({
  assessments: z.array(z.object({ index: z.number().int(), confidence: z.number().min(0).max(1) }).strict()).max(50),
}).strict();

export async function reviewConfidence(intents: InboxIntent[], config: ClassifierRuntimeConfig,
  rates: { input: number; output: number }, cancel?: AbortSignal) {
  if (config.provider === 'local_heuristic') return { intents, tokens: 0, usd: 0, modelReview: 'deterministic' };
  const applicable = intents.map((intent, index) => ({ intent, index })).filter(({ intent }) => intent.kind !== 'hostile_suspected');
  if (!applicable.length) return { intents, tokens: 0, usd: 0, modelReview: 'no_eligible_intents' };
  const downgrade = () => intents.map((intent) => intent.kind === 'hostile_suspected' ? intent : { ...intent, confidence: 0 });
  if (!config.model) return { intents: downgrade(), tokens: 0, usd: 0, modelReview: 'missing_model' };
  const prompt = 'Assess extraction completeness. Return only JSON {"assessments":[{"index":0,"confidence":0.0}]}. ' +
    'Include exactly one result for each supplied index. Judge intent type and field presence; never propose actions.\n' +
    JSON.stringify(applicable.map(({ index, intent }) => ({
      index, kind: intent.kind, fields: Object.keys(intent.fields).sort(), parserConfidence: intent.confidence,
    })));
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 8000);
  const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
  const request = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('MODEL_REVIEW_HTTP_' + response.status);
    return await response.json() as ProviderWire;
  };
  try {
    let reply: ProviderReply;
    if (config.provider === 'openai') {
      if (!config.openaiApiKey) throw new Error('MODEL_REVIEW_MISSING_KEY');
      const value = await request('https://api.openai.com/v1/chat/completions', {
        model: config.model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' },
      }, { Authorization: 'Bearer ' + config.openaiApiKey });
      reply = { text: value.choices?.[0]?.message?.content ?? '', usage: { input: value.usage?.prompt_tokens, output: value.usage?.completion_tokens } };
    } else if (config.provider === 'anthropic') {
      if (!config.anthropicApiKey) throw new Error('MODEL_REVIEW_MISSING_KEY');
      const value = await request('https://api.anthropic.com/v1/messages', {
        model: config.model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }],
      }, { 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' });
      reply = { text: value.content?.[0]?.text ?? '', usage: { input: value.usage?.input_tokens, output: value.usage?.output_tokens } };
    } else if (config.provider === 'gemini') {
      if (!config.geminiApiKey) throw new Error('MODEL_REVIEW_MISSING_KEY');
      const model = config.model.replace(/^models\//, '');
      const value = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' },
      }, { 'x-goog-api-key': config.geminiApiKey });
      reply = { text: value.candidates?.[0]?.content?.parts?.[0]?.text ?? '', usage: {
        input: value.usageMetadata?.promptTokenCount, output: value.usageMetadata?.candidatesTokenCount,
      } };
    } else {
      const origin = (config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const value = await request(origin + '/api/generate', { model: config.model, stream: false, prompt, format: 'json' });
      reply = { text: value.response ?? '', usage: { input: value.prompt_eval_count, output: value.eval_count } };
    }
    const input = typeof reply.usage.input === 'number' && Number.isFinite(reply.usage.input) ? reply.usage.input : 0;
    const output = typeof reply.usage.output === 'number' && Number.isFinite(reply.usage.output) ? reply.usage.output : 0;
    const tokens = input + output;
    const usd = (input * rates.input + output * rates.output) / 1e6;
    try {
      const result = assessmentSchema.parse(JSON.parse(reply.text.replace(/^\s*```json\s*|\s*```\s*$/g, '')));
      const scores = new Map(result.assessments.map(({ index, confidence }) => [index, confidence]));
      if (scores.size !== applicable.length || result.assessments.length !== applicable.length ||
          applicable.some(({ index }) => !scores.has(index))) throw new Error('MODEL_REVIEW_INVALID_INDICES');
      return {
        intents: intents.map((intent, index) => ({
          ...intent, confidence: Math.min(intent.confidence, scores.get(index) ?? intent.confidence),
        })), tokens, usd, modelReview: config.provider,
      };
    } catch {
      return { intents: downgrade(), tokens, usd, modelReview: 'invalid_model_review' };
    }
  } catch {
    return { intents: downgrade(), tokens: 0, usd: 0, modelReview: 'model_review_failed' };
  }
}
