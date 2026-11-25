# AGENT.md — Clam Autonomous Inbox & Itinerary Agent

## 1. Overview & Architecture

Clam combines two tightly coupled systems in one monorepo:

1. **Clam Firewall (`apps/server`)**: A zero-retention Model Context Protocol (`@modelcontextprotocol/sdk`) permission proxy supporting Streamable HTTP (`/mcp`) and SSE (`/mcp/sse`).
2. **Clam Autonomous Inbox Agent (`apps/agent`)**: A standalone unattended worker (`Travel & Bills Triage Agent`, `ag_autonomous`) that connects **strictly over real MCP** with a scoped Bearer token (`clm_ag_...`) and holds zero Gmail OAuth credentials or direct database access.

```text
+-----------------------------------+       MCP (Streamable HTTP /mcp)       +----------------------------------------+
|  Clam Autonomous Inbox Agent      |  --- Authorization: Bearer clm_ag_... -> |  Clam MCP Permission Firewall          |
|  (@clam/agent)                    |  <-- Silently filtered SafeEmail JSON -- |  (apps/server)                         |
|                                   |                                        |                                        |
|  - Zero direct mail/DB access     |                                        |  0. Kill Switch & Circuit Breaker      |
|  - Conflict resolution (latest ts)|                                        |  1. Stage A: Deterministic Hard Gates  |
|  - Generates .md / .json / .ics   |                                        |  2. Stage B: Semantic + Injection Scan |
|  - Creates safe review draft      |                                        |  3. Stage C: Conditional HITL Queue    |
+-----------------------------------+                                        +-------------------+--------------------+
                                                                                                 | Ephemeral RAM only
                                                                                                 v
                                                                             +----------------------------------------+
                                                                             | Sandbox Inbox (20+ msgs) / Gmail OAuth |
                                                                             +----------------------------------------+
```

## 2. Supported Models & Providers

| Provider | Env / Setting Value | Default Model | Notes |
| --- | --- | --- | --- |
| Local Heuristic (Default) | `local_heuristic` | Deterministic TS Extractor + Concept Scorer | Zero API keys, offline, fail-closed |
| OpenAI | `openai` | `gpt-4o-mini` | Optional classifier + host reply polish |
| Anthropic | `anthropic` | `claude-3-5-haiku-latest` | Optional classifier + host reply polish |
| Gemini | `gemini` | `gemini-2.5-flash` | Optional classifier + host reply polish |
| Ollama | `ollama` | `llama3.1` | Self-hosted local LLM (`OLLAMA_BASE_URL`) |

## 3. Exposed MCP Tools

- `list_emails(query?, maxResults?)` — Evaluates every candidate email in ephemeral RAM and silently strips sensitive or injected emails without leaking counts or senders.
- `search_emails(query, maxResults?)` — Same silent semantic & injection filtering over filtered search results.
- `read_email(messageId)` — Re-verifies Stage A + Stage B + Indirect Prompt-Injection Detector before returning message content.
- `create_draft(to, subject, body, threadId?)` — Scans outbound content for secrets/OTPs and prompt injections; executes or pauses at Stage C HITL depending on agent rules.
- `send_email(to, subject, body, threadId?)` — Deterministically blocked (`HARD_DENIED_SEND`) whenever `Never send` is configured.
- `delete_email(messageId)` — Deterministically blocked (`HARD_DENIED_DELETE` / `DEFAULT_DENY_DELETE`).
- `archive_email(messageId)` / `apply_label(messageId, label)` — Subject to Stage C HITL (`ask_first`) on `ag_autonomous`.
- `save_itinerary_artifact(filename, content)` — Scoped workspace export (`.md`, `.json`, `.ics`, `.txt`) guarded by path-traversal validation and `NO_CREDENTIALS_OR_OTP`.

## 4. Unattended Autonomous Loop (Zero Human Intervention)

From a single trigger (`pnpm agent:run`, `POST /api/agent-runs/start`, or UI **Run Unattended Agent** button), `runAutonomousInboxAgent` runs end-to-end without human pauses:

1. Connects to `/mcp` via `StreamableHTTPClientTransport` with `X-Clam-Run-Id` and a Kill-Switch-linked `AbortSignal`.
2. Calls `tools/list` and `list_emails(maxResults: 50)`. Sensitive messages (bank OTPs, wire alerts, password resets, medical labs, legal NDAs) and indirect prompt injections are silently stripped in RAM by Clam before the agent sees them.
3. Calls `read_email` individually on every permitted message to re-verify Stage A + Stage B.
4. Sorts permitted items chronologically and resolves conflicting updates using `LATEST_TIMESTAMP_WINS` (e.g., superseding Delta `DL 402` `08:30 AM EST` Gate `B24` with the newer `10:15 AM EST` Gate `B28` update).
5. Extracts flights, stays, and bills/receipts (including unseen vendor domains such as `billing@new-unknown-utility.io`).
6. Calls `create_draft` to stage a safe review reply to the Airbnb host (`kenji.host@airbnb-messages.example`) without ever calling `send_email`.
7. Calls `save_itinerary_artifact` to write `artifacts/itinerary.md`, `artifacts/digest.json`, and `artifacts/trip.ics`.
8. Exports metadata-only execution trace to `traces/latest-run.jsonl`.

## 5. Autonomy vs. Human-in-the-Loop (HITL) Boundaries

| Action | `Travel & Bills Triage Agent` (`ag_autonomous`) | `Travel Itinerary Agent` (`ag_travel`) |
| --- | --- | --- |
| Read permitted travel & bill emails | **Unattended (ALLOW)** | **Unattended (ALLOW)** |
| Save `.md` / `.json` / `.ics` artifacts | **Unattended (ALLOW)** | **Unattended (ALLOW)** |
| Create reply draft (`create_draft`) | **Unattended (ALLOW — never sends)** | **HITL Paused (Stage C `PENDING_APPROVAL`)** |
| Archive or apply labels | **HITL Paused (Stage C `PENDING_APPROVAL`)** | **Denied (`DEFAULT_DENY`)** |
| Send email / Delete email | **Hard Denied (`STAGE_A_DETERMINISTIC`)** | **Hard Denied (`STAGE_A_DETERMINISTIC`)** |
| Read OTPs, resets, medical, legal, injections | **Hard/Semantic Denied & Stripped** | **Hard/Semantic Denied & Stripped** |

## 6. Per-Run Cost Breakdown

| Mode | Classifier + Synthesis Calls | Estimated Cost per Run |
| --- | --- | ---: |
| `local_heuristic` (Default Judge Mode) | 0 external LLM API calls | **$0.0000** |
| `ollama` (Local Self-Hosted) | Local inference (`llama3.1`) | **$0.0000** |
| `gemini` (`gemini-2.5-flash`) | ~14–20 small classification calls + 1 draft polish (~5k input / ~1k output tokens) | **~$0.0008 – $0.0015** |
| `openai` (`gpt-4o-mini`) | ~14–20 small classification calls + 1 draft polish (~5k input / ~1k output tokens) | **~$0.0014 – $0.0022** |
| `anthropic` (`claude-3-5-haiku-latest`) | ~14–20 small classification calls + 1 draft polish (~5k input / ~1k output tokens) | **~$0.0080 – $0.0120** |
