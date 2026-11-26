import { createHash } from 'node:crypto';
import { inboxStages } from '@clam/shared';
import type { RunTrace, TraceStep } from './contracts.js';

export const genesisHash = '0'.repeat(64);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashStep(step: Omit<TraceStep, 'step_hash'>): string {
  return sha256(step.prev_hash + canonicalJson(step));
}

export function verifyTrace(value: unknown): value is RunTrace {
  if (!value || typeof value !== 'object') return false;
  const trace = value as RunTrace;
  if (typeof trace.run_id !== 'string' || !Array.isArray(trace.steps) || !trace.steps.length ||
      trace.step_count !== trace.steps.length) return false;
  let head = genesisHash;
  for (const [index, step] of trace.steps.entries()) {
    if (!step || typeof step !== 'object') return false;
    const { step_hash, ...data } = step;
    if (data.id !== `${trace.run_id}:${index + 1}` || data.run_id !== trace.run_id ||
        !inboxStages.includes(data.stage) || data.prev_hash !== head || step_hash !== hashStep(data)) return false;
    head = step_hash;
  }
  const terminal = trace.steps.at(-1)!;
  if (terminal.mode !== trace.mode || (trace.mode && trace.steps.some((step) => step.mode !== trace.mode)) ||
      (terminal.mode && canonicalJson(terminal.model_usage) !== canonicalJson(trace.model_usage))) return false;
  return trace.steps[0].stage === 'TRIGGER' && trace.steps.at(-1)?.stage === 'REPORT' &&
    trace.head_hash === head;
}
