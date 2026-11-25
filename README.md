# Clam — Autonomous Inbox Agent Behind a Zero-Retention Semantic MCP Firewall

**Agentware 2026 Track:** `Inbox & Calendar`

Clam pairs a **real Model Context Protocol (MCP) permission firewall** (`apps/server`) with an **unattended Autonomous Inbox & Itinerary Agent** (`apps/agent`) and a **matte hardware security console** (`apps/web`). On a single trigger, the autonomous agent connects strictly over MCP with a scoped Bearer token, strips OTPs, bank alerts, medical records, and indirect prompt injections in RAM, reconciles conflicting flight updates, generates structured deliverables (`itinerary.md`, `digest.json`, `trip.ics`), and stages a safe host review draft—with zero human pauses and zero email content retention on disk.

## Key Capabilities

1. **Unattended Autonomous Worker (`apps/agent`):** Connects strictly over real Streamable HTTP (`/mcp`) using `@modelcontextprotocol/sdk`. Triages the Sandbox Inbox (or optional Gmail), resolves flight schedule conflicts (`DL 402` delay update via `LATEST_TIMESTAMP_WINS`), extracts utility bills from unseen vendor domains (`billing@new-unknown-utility.io`), writes `.md` / `.json` / `.ics` artifacts, and drafts host replies without ever holding Gmail OAuth tokens.
2. **3-Stage Code-Enforced Firewall (`apps/server/src/policy`):**
   - **Stage A (Deterministic Hard Gates):** Blocks `send_email` (`HARD_DENIED_SEND`), `delete_email`, and outbound secret/OTP leaks (`NO_CREDENTIALS_OR_OTP`) in TypeScript before any LLM runs.
   - **Stage B (Fail-Closed Semantic & Prompt-Injection Shield):** Classifies email meaning rather than sender allowlists, strips protected categories (`otp_2fa`, `password_resets`, `bank_security_alerts`, `medical_records`, `legal_confidential`, `crypto_seed_recovery`), and blocks indirect prompt injections / hidden HTML directives (`PROMPT_INJECTION_BLOCKED`).
   - **Stage C (Conditional HITL Queue):** Pauses only actions configured as `ask_first` via In-App queue, Slack, Telegram, or WhatsApp webhooks while keeping core triage/itinerary/drafting zero-touch.
3. **Hardware-Grade Kill Switch & Auto-Trip Circuit Breaker (`apps/server/src/killswitch`):**
   - Instant **KILL SWITCH** button (`Shift+K`), CLI (`pnpm kill` / `pnpm resume`), and REST API (`/api/killswitch/engage`).
   - **Auto-Trip Circuit Breaker** trips automatically on repeated violations (`>= 3` in 30s), runaway tool loops (`> 25` calls/min), or critical outbound exfiltration attempts.
   - Immediately fires active `AbortController`s, returns HTTP `423 Locked` (`KILL_SWITCH_ENGAGED`) on `/mcp`, freezes pending approvals, and locks the reactive 5-state Clam mascot into `halted`.
4. **Zero-Retention Audit & JSONL Traces:** SQLite stores zero email subjects, bodies, or senders (`pnpm verify:zero-retention`). Export verifiable traces via UI or `/api/audit/export.jsonl`.

## Judge Quickstart (< 5 Minutes, Zero Credentials Required)

Clam boots in **Sandbox Mode** using a 20-email in-RAM test inbox (including flight conflict updates, unseen-domain utility bills, OTP/bank/medical traps, and indirect prompt injections) and `local_heuristic` classification (`$0.0000` per run).

```bash
cp .env.example .env
pnpm install
pnpm dev
```

- **Console UI:** `http://localhost:3000` (click **Run Unattended Agent**, **Run Trap Pack Suite**, or **KILL SWITCH** / `Shift+K`)
- **MCP Firewall & API:** `http://localhost:4000` (`/mcp`, `/mcp/sse`, `/api/health`)

## CLI Verification & Hackathon Commands

```bash
# Run full automated test suite (policy, MCP E2E, HITL, zero-retention, kill switch, injection & agent)
pnpm test

# Build all workspace packages (@clam/shared, @clam/agent, @clam/server, @clam/web)
pnpm build

# Run the unattended autonomous inbox agent end-to-end (writes artifacts/ and traces/latest-run.jsonl)
pnpm agent:run

# Run the adversarial Trap Pack suite across trap-pack/cases/ (writes traces/trap-pack-report.md & .jsonl)
pnpm trap-pack:run

# Engage or disarm the Emergency Kill Switch from CLI
pnpm kill
pnpm resume --reason="Verified clean"

# Forensic scan asserting 0 raw email bytes exist in SQLite or JSONL traces
pnpm verify:zero-retention
```

## Per-Run Cost Transparency

- **Default (`local_heuristic`) & Self-Hosted (`ollama`):** **`$0.0000` per run** (zero external API keys required).
- **Optional Cloud LLMs (`gemini-2.5-flash` / `gpt-4o-mini` / `claude-3-5-haiku-latest`):** ~$0.0008 – $0.0120 per full inbox triage run (see [`AGENT.md`](./AGENT.md) for breakdown).

## Environment Variables (`.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `WEB_PORT` | `4000` / `3000` | Fastify MCP/API server and Next.js console ports |
| `CLAM_MAIL_MODE` | `sandbox` | `sandbox` (zero credentials) or `gmail` (OAuth2) |
| `CLAM_LLM_PROVIDER` | `local_heuristic` | `local_heuristic`, `openai`, `anthropic`, `gemini`, `ollama` |
| `CLAM_ENCRYPTION_KEY` | auto-generated `.clam.key` | 32-byte key for AES-256-GCM vault sealing |
| `CLAM_ARTIFACTS_DIR` / `CLAM_TRACES_DIR` | `./artifacts` / `./traces` | Output directories for agent deliverables and JSONL traces |
| `CLAM_CB_VIOLATION_THRESHOLD` | `3` | Violations inside `CLAM_CB_WINDOW_SECONDS` (`30`) before auto-trip |
| `CLAM_CB_MAX_CALLS_PER_MIN` | `25` | Runaway loop threshold for Auto-Trip Circuit Breaker |
| `GOOGLE_CLIENT_ID` / `SECRET` | empty | Optional live Gmail OAuth 2.0 credentials |

## Repository Layout

```text
clam/
├── apps/
│   ├── agent/      # Standalone Autonomous Inbox & Itinerary Agent (@clam/agent)
│   ├── server/     # Fastify MCP Firewall, Policy/Injection Engine, Kill Switch, Mail, Audit
│   └── web/        # Next.js Matte Obsidian Console + 5-State Clam Mascot
├── packages/
│   └── shared/     # Zod schemas, Policy IR, deterministic gates, prompt-injection scanner
├── trap-pack/      # Drop-in adversarial Trap Pack cases (.json, .eml, .txt)
├── traces/         # Reproducible JSONL execution traces & Trap Pack reports
├── artifacts/      # Generated itinerary.md, digest.json, trip.ics
├── scripts/        # run-demo.ts, run-trap-pack.ts, kill.ts, verify-zero-retention.ts
├── tests/          # 5 Vitest suites covering every security & autonomy invariant
├── AGENT.md
├── SAFETY.md
├── .agentware.toml
└── LICENSE
```
