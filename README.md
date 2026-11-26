# Clam · Agentic Inbox

**Agentware 2026 Track 1 · Inbox & Calendar**

[Open the three-minute walkthrough](#three-minute-walkthrough)

Clam reads inbox threads, plans calendar and inbox work, and returns a receipt showing **what changed**, **what it handled**, and **what needs approval**. A read-only LLM analyzes the email. A separate executor enforces policy, verifies each write, and supports rollback for eligible actions. A recorded demo has yet to be published.

## Primary LLM Mode

Use Node.js 24 or newer and pnpm 10. Configure an API key or an Ollama endpoint to select `llm` automatically, or set `CLAM_AGENT_MODE=llm` explicitly. The LLM can run against the synthetic mailbox before you connect Google.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

For the recommended low-cost cloud setup, set `CLAM_LLM_PROVIDER=gemini`, `CLAM_LLM_MODEL=gemini-3.1-flash-lite`, and `GEMINI_API_KEY` in `.env`. The published standard rates are **$0.25/1M input tokens** and **$1.50/1M output tokens**. Clam records provider-reported usage and estimates USD from these rates. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)

Two real local Ollama runs on the 20-message sandbox averaged **5,305 tokens per run** (3,976 input and 1,329 output), with **$0 in provider charges** for `qwen2.5:1.5b`. Each run recorded 2 verified protected-message actions, 10 approvals, and 1 quarantine. Gemini usage and billed cost remain unmeasured. [Run receipts and timings](docs/AGENTWARE_AUDIT.md#measured-model-runs)

Open `http://localhost:3000/#briefing`. The status bar labels the current agent as `llm` or `offline-smoke` separately from the mailbox. Google access is optional and works with either inference mode.

OpenAI, Anthropic, Groq, and Ollama are also supported. Set their provider, model, and applicable key or endpoint. For providers without configured rates, usage is displayed and estimated USD is marked unavailable. Live cloud processing sends bounded, sanitized message and context text to the selected provider. For a local model, set `OLLAMA_BASE_URL` and `CLAM_LLM_MODEL`.

## Zero-Key Offline Smoke Mode

Install Docker Engine, Docker Compose, and Make, then run:

```sh
make sandbox
```

Open `http://localhost:3000/#briefing` and click **Run now**. Compose explicitly selects `offline-smoke`. The sandbox has 20 synthetic inbox messages, three earlier thread records, eight calendar events, and a fixed scenario clock. Writes go to the local calendar, labels, mock outbox, and ledger. The deterministic parser costs $0 per run.

On the verification machine, a Docker build with layer caching disabled took **95.2 seconds** with the base image already available. Starting the built image with a fresh sandbox volume took **7.6 seconds** to reach healthy API and web states.

Use `make logs` for service logs or `make stop` to stop services and keep the SQLite volume. The default API is `http://localhost:4000`. For an isolated local run from source, use `CLAM_AGENT_MODE=offline-smoke DATABASE_PATH=:memory: pnpm agent sandbox`.

## Connect Google Gmail and Calendar

1. In Google Cloud Console, enable **Gmail API** and **Google Calendar API**. In Google Auth Platform, configure your app branding and audience. For an external app in Testing, add a dedicated Gmail account under **Test users**.
2. Create a **Web application** OAuth client. Add `http://localhost:4000/api/auth/google/callback` as the authorized redirect URI. Keep both Clam URLs on the same hostname for the session cookie to reach both ports.
3. In `.env`, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `CLAM_INBOX_LIVE=true`. Generate **two separate** values with `openssl rand -hex 32` for `CLAM_TOKEN_ENCRYPTION_KEY` and `CLAM_SESSION_SECRET`. Start from source with `pnpm dev`. The Compose judge setup explicitly disables live access.
4. Open `http://localhost:3000/settings`. Click **Sign in with Google**, then **Connect Gmail (Read-Only)**. Use **Link another Google account** to connect a second account. Choose the target in **Active inbox** before starting a run.
5. Use **Upgrade to Read+Write** when you want to authorize mail or calendar actions. Each account starts with an empty allowlist. Review Tier 2 actions in the Approval Inbox, and use **Disconnect & Revoke Token** to revoke the Google grant and the account's MCP tokens.

| Consent step | Requested scopes |
| --- | --- |
| Sign in | `openid`, `userinfo.email`, `userinfo.profile` |
| Connect read-only | `gmail.readonly`, `calendar.events.readonly` |
| Enable actions | `gmail.modify`, `calendar.events` |

Google can return a subset of the requested scopes or include earlier grants. Connections displays the actual set, and Clam checks the required scope before each operation. Google refresh tokens for external apps in Testing generally expire after seven days when Gmail or Calendar scopes are granted. Use **Reconnect** when the account shows **Re-auth Required**. [Google OAuth setup and revocation](https://developers.google.com/identity/protocols/oauth2/web-server) · [Refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

### Scoped MCP access

In **Connections**, mint a token for a specific inbox. The token is shown once and expires after 30 days. Clam accepts it at `http://localhost:4000/mcp` via Streamable HTTP. The Connections screen includes setup snippets for Claude Code, Cline, Cursor, and Codex.

For Streamable HTTP, pass the token in `Authorization: Bearer …` or `x-api-key`. The MCP server checks the token on every request, including the session's `GET` stream. For local stdio clients, start `pnpm --silent clam-mcp` from the repo with `CLAM_API_URL` and `CLAM_MCP_TOKEN` exported. The bridge also accepts `CLAM_PUBLIC_URL`. **Runs & Live Monitor** shows tool calls with their reported client name, token identifier, policy verdict, budget, and trace.

If pnpm is available through this checkout's dependencies, run `export PATH="$PWD/node_modules/.bin:$PATH"` before starting the client.

The **Sandbox mailbox tokens** panel also works without Google sign-in. Tokens minted with `mail:read` cannot send mail. An explicitly scoped sandbox `inbox:manage` token can provision local Pod inboxes and manage the sandbox recipient allowlist and blocklist. Attachment staging writes screened files with mode `0600` under `workspace/mail-attachments/`. A batch that requires approval appears as one editable item with fixed recipients. `get_batch_status` shows verified sends as each approved chunk runs within the active budget.

Scopes cover mail and threads, attachment extraction, draft proposals, policy-gated sends, calendar proposals, and optional verification lookups for a single sender domain. The verification scope checks the Gmail search window, exact authenticated domain, and message age. Password-reset and account-recovery notices are excluded. Documents and messages returned by tools carry an untrusted-data label.

Verification tools return a matching code or HTTPS verification URL once per message and inbox. Link hosts must exactly match the authenticated sender domain or an explicit host in `CLAM_VERIFICATION_REDIRECTS`, for example `{"example.com":["verify.example.net"]}`. Clam rejects redirect parameters and never follows the URL. The journal and live stream contain redacted receipts with the caller's token identifier.

For trusted local CLI operations, configure `CLAM_OPERATOR_TOKEN` on the server and CLI. Set `CLAM_INBOX_ID` to the connected account's inbox ID before running `pnpm agent run`, `pnpm agent watch`, or `pnpm agent rollback RUN_ID`. Pull the inbox ID from the signed-in `/api/auth/session` endpoint. The CLI uses the sandbox when no inbox ID is supplied.

### Agent Pod handoffs

Under **Connections → Agent inboxes & MCP access**, click **Run sandbox handoff**. Triage extracts a synthetic credit memo and delegates it to Executor. Executor checks the evidence and returns a reply draft on hop 2. Open **Replay sandbox handoff** to inspect the messages, policy decisions, and exact trace steps.

Mint separate Pod tokens for `triage` and `executor` to use the same workflow over `/mcp`. Select `handoff:send` for delegation, `handoff:read` for received work, and `attachment:extract` for shared case evidence. Use `handoff_to_agent_inbox` with the calling inbox ID, destination inbox ID, and the existing thread ID for replies. The sandbox transport delivers signed messages inside its Pod. A repeated back-and-forth or exhausted hop budget pauses the thread and creates a Tier 2 item. **Reset thread budget** permits a new attempt and leaves the previous receipts intact.

## Workspace agents from any CLI (Drive, Docs, Sheets, Photos)

Mint a sandbox MCP token with `agent:manage`, `workspace:write`, `photos:read`, `mail:read`, `mail:send`, and `calendar:propose`, connect Claude Code, Codex CLI, Cursor, or Cline (see **Connections → Setup commands**), then just ask for something:

> Email these 4 vendors for quotes on 500 custom boxes, compare their prices in a Sheet and Doc, and book the cheapest one.

The CLI calls `provision_and_run_agent`. Clam compiles the request into a validated step DAG, stores a persistent agent (`user_agents`), switches your active agent (`agent_switch_history`), and runs it in the backend. Every step goes through the policy engine, Tier 0/1/2 gate, kill switch, and read-back `CHECK`. The **Agents & Activity** page streams the agent list, switch timeline, per-step logs (`agent_execution_logs`), and Sheet/Doc/Drive artifacts (`workspace_artifacts`) over SSE. In `$0` sandbox mode you can open an in-browser preview of each artifact.

| Built-in workflow | What runs autonomously (Tier 0) | What waits for you (Tier 2) |
| --- | --- | --- |
| Invoices & recurring bills | Drive `Clam / Invoices / YYYY-MM`, screened PDF upload, deduplicated ledger rows, summary Doc | Duplicate or spoofed invoices |
| Vendor RFQ → comparison | Quote parsing (body and PDF), sanitized comparison Sheet, winner flag, memo Doc | The RFQ batch to non-allowlisted vendors, and the final booking (`FINANCIAL_COMMITMENT_APPROVAL`) |
| Receipt photos | Read-only Photos search, bounded extraction, receipt Sheet, Calendar payment reminders | — |
| Anything else | A sanitized digest Doc, plus an optional tracker Sheet and Drive folder | Any outbound email |

**Any task, not only the built-in workflows.** With `CLAM_AGENT_MODE=llm`, the configured model plans every request. It writes its reasoning and composes a program from Clam's step library:
- read: `mail.search` and `photos.extract`;
- shape the data: `filter` and `summarize`;
- write: `drive.folder`, `drive.save_attachments`, `drive.save_text`, `sheets.append`, `docs.write`, `calendar.reminders` and `mail.label`;
- outbound: `mail.draft_replies` and `mail.send`.

The model may also pick one of the ready-made workflows when one fits better. After the program runs, the model reviews sanitized results (counts, field names, short redacted samples) and can add up to two rounds of follow-up steps. Clam executes every step itself under the policy engine. A model can never call an unlisted tool or add a recipient you didn't write, and replies always wait for approval. Without a model, an offline composer builds a general program from the sources and outputs your request names, and the log records that fallback.

For MCP-created agents, grant `mail:label` for labeling, `mail:draft` for drafts, `mail:send` for outbound mail, and `attachment:extract` when a program reads or saves attachments.

Add phrases like "wait up to 48 hours for replies" to set the quote window; the default is 24 hours live and immediate in the sandbox. Raster receipt photos are OCR'd with Tesseract when it is installed.

To check a real Google account end to end, run `CLAM_INBOX_LIVE=true pnpm workspace:smoke [inbox-id] [--keep]`. It creates a folder, a file, a Sheet (including a formula-injection row), and a Doc, verifies every read-back, checks Photos, then rolls back what it created unless you pass `--keep`.

Direct tools are also available: `drive_ensure_folder`, `drive_save_file`, `drive_list_files`, `sheets_create_tracker`, `sheets_append_rows`, `sheets_update_cells`, `docs_create_or_update`, `photos_start_picker`, `photos_search_and_extract`, `switch_active_agent`, and `list_user_agents_and_logs`.

Safety:
- **Formula injection:** untrusted text is neutralized before it reaches a Sheet (for example `=IMPORTXML(...)` is stored as `'=IMPORTXML (...)`). Live writes also use `valueInputOption=RAW`.
- **Secret scanner:** covers Drive file contents as well as Sheet and Doc text.
- **Least-privilege Google scopes:** the Workspace grant requests only `drive.file` and `photospicker.mediaitems.readonly`. For Photos, Clam opens a Google Photos Picker session and reads only the receipts you choose (call `photos_start_picker`, or open the link on the agent card). `documents` and `spreadsheets` are requested only through *Allow editing existing Docs & Sheets*. Full `drive` access and every Photos write or share scope are hard-banned (`GOOGLE_SCOPE_BANNED`).
- **Rollback:** rolling back a run deletes only artifacts Clam created in that run, using the id recorded in its own registry.

## Three-minute walkthrough

| View | What to demonstrate |
| --- | --- |
| `http://localhost:3000/#briefing` | Run the inbox. See AC402 move from **14:20 to 16:45 UTC**, a shifted solo focus block, the autonomy counters, and the conflicting invoice and deadline. |
| `http://localhost:3000/#approvals` | Filter by priority. See why the external meeting and VIP notice need review. Edit a renewal draft or calendar payload and approve it, or reject a conflict. |
| `http://localhost:3000/#calendar` | Review additions, changes, and cancellations. Export `.ics` and select a verified change to roll back. |
| `http://localhost:3000/#policy` | Compare current and draft rules across the deterministic sandbox, then save the new version. |
| `http://localhost:3000/#monitor` | Inspect the run receipt, configure a schedule, or watch live stages, budgets, tokens, cost, and provider latency. |
| `http://localhost:3000/#bills` | Inspect the duplicate invoice flag and the renewal increase from **$25 to $35**. Export the ledger to CSV. |

Use **Halt agent** in the status bar to interrupt a run. Resume with an audit reason. **Roll back last run** restores eligible changes and records sent mail as irreversible. The UI supports light and dark themes.

## Safety Bonus Proof Table

| Rubric item | Code evidence | Where to verify |
| --- | --- | --- |
| Guardrails (+1) | [Read-only SQLite and input preflight](apps/server/src/inbox/reader.ts), [typed LLM contract](apps/server/src/inbox/model.ts), [policy and disclosure](apps/server/src/inbox/policy.ts), [SQLite triggers](apps/server/src/inbox/store.ts) | `/#approvals`, `/#policy`, and `pnpm test:adversarial` |
| Live Monitoring (+1) | [Per-stage SSE](apps/server/src/inbox/routes.ts) and [provider usage receipts](apps/server/src/inbox/engine.ts) | `/#monitor` and `pnpm agent watch` |
| Kill Switch (+1) | [Guard and abort controller](apps/server/src/inbox/engine.ts), [operator endpoint and lockfile](apps/server/src/inbox/routes.ts), [mid-flight CLI test](tests/agentware-hard-rules.test.ts) | Halt and resume controls and `pnpm agent halt "operator paused runs"` |
| Audit Trail (+1) | [Hash chain and verifier](apps/server/src/inbox/trace.ts), [model usage and rollback receipts](apps/server/src/inbox/engine.ts), [tamper CLI test](tests/agentware-hard-rules.test.ts) | `/#monitor`, `pnpm agent rollback RUN_ID`, and `pnpm agent verify-trace TRACE_PATH` |

These are proof links for the organizer's four bonus categories. [Agentware scoring](https://www.agentwarehack.com/)

## Verified Results

The recorded run is labeled `offline-smoke`. It scanned 20 messages and exercised all nine playbooks.

| Outcome | Recorded count |
| --- | ---: |
| Autonomous Verified (Tier 0/1) | **20** |
| Gated Approvals (Tier 2) | **6** |
| Blocked Threats / Quarantined | **1** |

The verified work includes six calendar writes and three mock sends. The shared meeting and dossier write counts once. The quarantine is counted in the third row. [Run summary](traces/c611f6b5-2153-4c50-9a86-ac06ee13103e.md)

```sh
pnpm test
pnpm test:adversarial
pnpm agent verify-trace traces/c611f6b5-2153-4c50-9a86-ac06ee13103e.json
```

The built-in [adversarial regression report](tests/adversarial_regression_report.md) covers five synthetic inputs, a burst halt, and post-write timeout recovery. For the official files supplied separately, run `pnpm run-official-trap-pack PATH` with a directory or JSON manifest. The runner preserves per-case trace links, including failures, in `tests/official_trap_pack_report.md`. It uses an isolated database per file and defaults to offline analysis. Set `CLAM_AGENT_MODE=llm` explicitly to exercise the configured model with the supplied files. The organizer lists the official release at kickoff on November 27 at 18:00 UTC. [Agentware timeline](https://www.agentwarehack.com/)

## Operator commands

| Command | Purpose |
| --- | --- |
| `pnpm agent run` | Start a run against the running API. |
| `pnpm agent watch` | Stream stages, write usage, model tokens, latency, and estimated USD. |
| `pnpm agent halt "operator paused runs"` | Abort active work. When the API is unreachable, write the configured lockfile. |
| `pnpm agent resume "review complete"` | Resume through the API with an audit reason. |
| `pnpm agent rollback RUN_ID` | Restore eligible changes and record the outcome. |
| `pnpm agent verify-trace TRACE_PATH` | Check the complete hash chain and terminal receipt. |
| `pnpm run-official-trap-pack PATH` | Ingest a supplied pack and produce its separate report. |

Compose users can run online commands with `docker compose exec api pnpm agent watch`. If you changed the host API port, set `CLAM_PUBLIC_URL` for a host CLI.

## Known Failure Modes & Non-Goals

- Google integration tests use mocked Google responses, the real MCP HTTP client, and real PDF extraction. Credentialed Google validation requires a test account.
- The reader accepts bounded text and PDF extraction. Scanned PDFs need OCR. A date or amount the executor cannot ground safely goes to review.
- Failed or invalid model output stops execution and records the observed usage. It does not switch to the offline parser mid-run.
- A write timeout triggers read-back reconciliation. Ambiguous results and external edits can require manual recovery. Delivered mail cannot be recalled.
- The hash chain checks consistency against the recorded head. Retain an independent trusted copy of the head when provenance matters.
- Live source excerpts and provider credentials are excluded from run receipts. SQLite retains structured business state and provenance. The default installation binds to localhost and is designed for trusted local operation.

[Architecture and playbooks](AGENT.md) · [Safety details](SAFETY.md) · [Acceptance audit](docs/ACCEPTANCE_AUDIT.md) · [Rubric remediation](docs/AGENTWARE_AUDIT.md) · [Near-miss log](docs/NEAR_MISS_LOG.md) · [MIT License](LICENSE)
