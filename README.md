# Clam — Semantic Permission Layer & Zero-Retention MCP Firewall for Email

Clam is a zero-retention **Model Context Protocol (MCP)** permission firewall that sits between autonomous AI agents (Claude Desktop, Cursor/Codex, Gemini CLI, or any HTTP/SSE MCP client) and your Gmail account.

## Core Security Invariants

1. **Credential Isolation:** Agents never see Gmail OAuth tokens or refresh tokens. They authenticate solely with revocable, per-agent Bearer tokens (`clm_ag_...`).
2. **Default-Deny Everything:** Unmatched actions and scopes are denied. External semantic classifiers strictly **fail closed** (`DENY`) on timeouts, errors, schema failures, or low confidence (`< 0.65`).
3. **Zero Email Retention:** Email subjects, bodies, attachments, and sender lists exist strictly in ephemeral RAM during policy evaluation and proxying. SQLite stores only metadata, compiled Policy IR, AES-256-GCM encrypted vault secrets, and metadata-only audit logs (`message_id_hash`, rule citation, semantic category, confidence, latency).
4. **Silent Filtering:** `list_emails` and `search_emails` strip out-of-scope or sensitive emails before returning results, leaking zero counts, subjects, or senders.
5. **Deterministic Hard Gates Above LLMs:** `NEVER_SEND`, `NEVER_DELETE`, `NO_CREDENTIALS_OR_OTP`, and `"ask me first"` gates are enforced deterministically in TypeScript code before and independently of LLMs.

## Architecture

```text
clam/
├── apps/
│   ├── server/   # Fastify + @modelcontextprotocol/sdk + Drizzle/SQLite + AES-256-GCM vault
│   └── web/      # Next.js Precision Security Console UI
├── packages/
│   └── shared/   # Zod schemas, Policy IR types, deterministic gate evaluators
└── tests/        # Policy, Zero-Retention, HITL, and MCP E2E test suites
```

## Quickstart (Zero-Setup Sandbox Mode)

No external API keys or Google OAuth credentials are required to boot and test everything locally.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

- **Console UI:** `http://localhost:3000`
- **MCP Firewall & API:** `http://localhost:4000` (Streamable HTTP `/mcp`, SSE fallback `/mcp/sse`)

In **Sandbox Mode** (enabled by default), Clam serves an in-memory 18-email test inbox containing flight/hotel confirmations, host messages, bank OTPs, wire fraud alerts, password resets, medical lab records, legal NDAs, and invoices from unseen sender domains (`billing@new-unknown-utility.io`).

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Connecting Real Services (Optional)

- **Gmail OAuth 2.0:** Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `CLAM_ENCRYPTION_KEY` in `.env`, then authorize in **Connections** (`/settings`). Tokens are sealed with AES-256-GCM.
- **External LLM Classifier:** Set `CLAM_LLM_PROVIDER` (`openai` | `anthropic` | `gemini` | `ollama`) and the corresponding API key in `.env` or `/settings`.
- **HITL Approval Webhooks:** Configure Slack, Telegram, or Meta WhatsApp Cloud credentials in `.env` or `/settings`, then click **Send Test Approval**. Callback endpoints:
  - `POST /webhooks/slack`
  - `POST /webhooks/telegram`
  - `GET|POST /webhooks/whatsapp`
