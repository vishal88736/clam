# Clam · Agentic Inbox

**Agentware Track 1 · Inbox & Calendar**

Clam processes travel, scheduling, and billing email under rules you control. After a run, the Inbox Briefing shows **what changed**, **what Clam handled**, and **what needs your approval**. For example, when a flight is delayed, Clam can update a matching itinerary event, move a flexible focus block, and ask before changing a meeting with an external guest.

Each verified action has a policy decision and a read-back receipt. Eligible changes can be rolled back from the console or CLI.

## Run the zero-credential sandbox

Install Docker Engine with the Compose plugin and Make, then run:

```sh
git clone https://github.com/vishal88736/clam.git
cd clam
make sandbox
```

Open [Inbox Briefing](http://localhost:3000) and click **Run now**. The first build downloads the base image and dependencies. The sandbox uses **20 synthetic emails, eight seeded calendar events, and a fixed scenario clock**. Outbound mail goes into a local mock outbox. The built-in deterministic parser needs no API keys, and the model cost is **$0 per sandbox run**.

`make logs` streams service logs. `make stop` stops the services and keeps the SQLite volume. To change the host ports, run `CLAM_WEB_PORT=3300 CLAM_API_PORT=4400 make sandbox` and open [port 3300](http://localhost:3300). The default API health check is [port 4000](http://localhost:4000/api/health).

### Run from source

Use Node.js 24 or newer and pnpm 10. The Docker build uses pnpm 10.34.9. Install Poppler's `pdftotext` if you want PDF attachment extraction outside Docker.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Use a new shell for the operator commands. When the Compose API uses an alternate host port, set `CLAM_PUBLIC_URL` to that address before running a host CLI command.

## What to try in the console

| View | What you can do |
| --- | --- |
| [Inbox Briefing](http://localhost:3000/#briefing) | Run the inbox, compare before and after values, review conflicts, and open verified action receipts. |
| [Approval Inbox](http://localhost:3000/#approvals) | Inspect the triggering rule and expiry, edit eligible email or calendar payloads, and approve or reject actions. |
| [Calendar Sync](http://localhost:3000/#calendar) | Inspect additions, changes, and cancellations, roll back selected eligible changes, and export `.ics`. |
| [Policy Change Preview](http://localhost:3000/#policy) | Compare the current and draft policy across the sandbox inbox before saving a new version. |
| [Runs & Live Monitor](http://localhost:3000/#monitor) | Schedule daily, weekly, or interval runs. Inspect history, trace steps, and live budgets and model usage. |
| [Bills & Receipts](http://localhost:3000/#bills) | Review invoices, renewal price changes, and duplicate or spoof flags. Export the ledger to CSV. |

The default console supports light and dark themes. `/about` contains the Clam landing page. `/console` opens the original MCP firewall console.

### Three-minute walkthrough

1. Run the inbox. In **What changed**, find AC402 moving from **14:20 to 16:45 UTC**, the shifted solo focus block, and the conflicting invoice and deadline.
2. In **Approval Inbox**, inspect the external meeting and VIP notice. Edit the subscription renewal draft, then review its recorded action. **Bills & Receipts** shows the renewal increase from **$25 to $35**.
3. In **Runs & Live Monitor**, open the original run and inspect a verified step. Use **Roll back last run** from the Briefing, then confirm the original flight time in **Calendar Sync**. The rollback receipt lists eligible restorations and marks delivered mail as irreversible.

## How it works

```text
Trigger → Plan → Policy → Act → Check → Report
```

A read-only parser sanitizes incoming mail and attachments, then emits validated intents. The executor applies a versioned policy, checks recipient provenance and confidence, reserves each action in SQLite, and reads back the result after writing. Each run has a journal, hash-chained trace, and human-readable receipt.

The nine playbooks cover travel delays, meeting scheduling, bills and trials, hostile-input quarantine, pre-meeting context, commitments and follow-ups, deliveries, expired OTPs, and newsletter and outreach rollups. Reversible changes can run at Tier 0. Tier 1 sends are limited to eligible allowlisted contacts and carry an automated-message header and footer. External and sensitive actions that pass the hard guards can go to Tier 2 approval. The operator kill switch and per-run circuit breakers also gate tool execution.

| Path | Role |
| --- | --- |
| `apps/server` | Fastify API, SQLite journal, policy engine, playbooks, sandbox and live adapters, and SSE |
| `apps/web` | Next.js and React console |
| `apps/agent` | Standalone client for the scoped MCP firewall |
| `packages/shared` | Shared TypeScript and Zod contracts |
| `tests`, `traces` | Automated tests, Trap Pack report, and recorded run receipts |

See [AGENT.md](AGENT.md) for the playbook registry and architecture diagram and [SAFETY.md](SAFETY.md) for the enforcement points.

## Operator commands

| Command | Purpose |
| --- | --- |
| `pnpm agent run` | Start an inbox run against the running API. |
| `pnpm agent watch` | Stream pipeline stages, write budgets, tokens, and estimated model cost. |
| `pnpm agent halt "operator paused runs"` | Halt execution. If the API is unreachable, write the configured local lockfile. |
| `pnpm agent resume "review complete"` | Resume through the running API with an audit reason. |
| `pnpm agent rollback RUN_ID` | Roll back eligible actions from a run. Replace `RUN_ID` with its recorded ID. |
| `pnpm agent sandbox` | Run against the configured local sandbox database without starting the web app. |
| `pnpm run-trap-pack` | Run the isolated adversarial cases and regenerate the Markdown report. |
| `pnpm test` | Run the test suite. |

Compose users can run the online CLI commands inside the API container, for example `docker compose exec api pnpm agent watch`. A host CLI fallback lockfile affects the instance using that file path. For Compose, the latch is inside the mounted data volume.

## Verified results

The recorded sandbox run scanned **20 messages**, verified **22 actions**, and queued **six approvals**. Its writes included six calendar mutations and three messages to the mock outbox. The production Docker build, Chromium walkthrough across all six views, and 24 automated tests passed during local validation. The Trap Pack passed five adversarial cases plus the attack-burst and timeout-recovery checks.

Verify the included trace from a source checkout:

```sh
pnpm agent verify-trace traces/55e05e55-0986-4569-8ce9-169ee2fd8697.json
```

[Run summary](traces/55e05e55-0986-4569-8ce9-169ee2fd8697.md) · [Trap Pack report](tests/trap_pack_report.md) · [Near-miss log](docs/NEAR_MISS_LOG.md)

## Optional live mode

The shipped Compose setup runs the sandbox. For live mode, use the source setup on a private localhost deployment and start with a test mailbox and calendar.

1. Enable the Gmail and Google Calendar APIs in a Google Cloud project. Create a web OAuth client using the redirect URI in [`.env.example`](.env.example).
2. Set `CLAM_INBOX_LIVE=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a random `CLAM_OPERATOR_TOKEN` in your local `.env`. Restart the web and API processes.
3. In **MCP console → Connections**, connect Google and grant Gmail and Calendar access. Reconnect an older Gmail grant if it lacks the Calendar scope.
4. Return to **Inbox Briefing** and review the live policy before running. The live allowlist and trusted airline list start empty. Automatic flight changes require a managed calendar event with a matching booking reference and airline domain.

Live confidence review is optional. Select OpenAI, Anthropic, Gemini, or Ollama through `CLAM_LLM_PROVIDER`, configure `CLAM_LLM_MODEL` and the applicable key, and set `CLAM_INBOX_MODEL_REVIEW=true`. The reviewer receives intent types and field names and can lower confidence. Configure the input and output USD-per-million rates in `.env` to estimate model cost from provider-reported usage. At example rates of $1 and $5 per million, 1,000 input tokens and 200 output tokens would cost **$0.002**.

[Gmail API](https://developers.google.com/workspace/gmail/api/guides/sending) · [Google Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events)

## Known Failure Modes & Non-Goals

- The verified run used the sandbox. Live Gmail, Calendar, and cloud model calls require separate credentialed validation.
- The parser handles supported structured patterns, explicit time offsets, UTC calendar attachment timestamps, and bounded text or PDF extraction. Floating-time invites and incomplete extractions can require review. Scanned PDFs need OCR outside Clam.
- After a write timeout, Clam reconciles the claim by reading the target. Ambiguous writes require review. Concurrent external edits or provider errors can prevent a write or rollback.
- Rollback restores eligible events, labels, drafts, and ledger records. Delivered email cannot be recalled. Some calendar cancellations require manual recovery.
- The hash chain verifies consistency with its recorded head. Keep a trusted copy of the head independently when you need provenance.
- Live source mail bodies and OAuth tokens stay outside trace files. SQLite keeps structured business state and provenance. The app targets a single trusted operator on localhost.

[MIT License](LICENSE)
