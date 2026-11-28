import { createServer, type Server } from 'node:http';
import type { AgentConfig } from '../../apps/server/src/inbox/agentConfig.js';

/**
 * A local stand-in for an AI provider (Ollama wire format). The first planner prompt gets `plan`; every other prompt
 * gets `answer(prompt)`. Every prompt is recorded so tests can check what the AI was shown.
 */
export async function fakeModel(plan: unknown, answer: (prompt: string) => unknown = () => ({ reasoning: 'Done.', done: true })) {
  const prompts: string[] = [];
  let planned = false;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const prompt = JSON.parse(body).prompt as string;
      prompts.push(prompt);
      const isPlan = prompt.startsWith('You are the planner') && (!planned || Array.isArray(plan));
      const reply = isPlan ? (Array.isArray(plan) ? plan.shift() : plan) : answer(prompt);
      if (isPlan) planned = true;
      response.end(JSON.stringify({ response: JSON.stringify(reply) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent: AgentConfig = { mode: 'llm', provider: 'ollama', model: 'fake-planner', timeoutMs: 5000, rates: { input: 0, output: 0 },
    endpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port };
  return { agent, prompts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
