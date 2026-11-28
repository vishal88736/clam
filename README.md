# Siftvane

<img src="apps/web/src/app/icon.svg" width="84" height="84" alt="Siftvane logo">

Siftvane turns plain-language requests into agents that work through your Gmail, Calendar, Drive, Docs, Sheets and Photos. You say what you want ("reply to customers who ask about pricing", "log every invoice in a sheet", "add my kid's school dates to my calendar"); the **AI you choose plans the steps**, and Siftvane runs them on a schedule under your rules. Nothing about a task is built in: there are no fixed workflows, so an agent can do anything its steps can express.

Every action is checked against your rules, applied, and read back to verify it. Anything risky (replies, sends to people you haven't trusted, calendar changes with outside guests) waits in your Approval Inbox. Every run keeps a tamper-evident trace and can be rolled back.

## Quick start

Use Node.js 22+ and pnpm 10 (from source), or Docker (below).

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open http://localhost:3000. Then, on **Profile**:

1. **Choose an AI provider.** Gemini, OpenAI, Anthropic Claude, Groq, or Ollama running on your own computer. Paste a key (stored encrypted, never shown again) and click **Save and test**. Without an AI provider no agent can be made: the AI is the planner.
2. **Connect Google** (optional). Until you do, agents work in a practice mailbox with sample mail, calendar, Drive files and photos.
3. Go to **Home**, describe what you want, and click **Create agent**.

### With Docker

```sh
GEMINI_API_KEY=your-key SIFTVANE_LLM_PROVIDER=gemini make sandbox   # or leave the AI unset and choose it on Profile
```

Open http://localhost:3000. `make logs` shows service logs; `make stop` stops the services and keeps the data volume. Compose runs the practice mailbox; connect real Google from source with `pnpm dev`.

## Connect Google in one click

1. In Google Cloud Console, enable the **Gmail, Calendar, Drive, Docs and Sheets APIs** (and **Photos Picker** if you want receipt photos). Configure the consent screen; while the app is in *Testing*, add your Gmail address as a test user. Add these scopes to the consent screen: `gmail.modify`, `calendar.events`, `drive.readonly`, `drive.file`, `documents`, `spreadsheets`, `photospicker.mediaitems.readonly`.
2. Create a **Web application** OAuth client with redirect URI `http://localhost:4000/api/auth/google/callback`.
3. In `.env` set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SIFTVANE_INBOX_LIVE=true`, and two separate random values (`openssl rand -hex 32`) for `SIFTVANE_TOKEN_ENCRYPTION_KEY` and `SIFTVANE_SESSION_SECRET`. Restart.
4. On **Profile**, click **Connect Google**. One consent screen signs you in and grants all services; the card then shows each service as On, Off or Read only.

Full read-write Drive and every Photos write or share scope are banned outright. Agents can read your Drive but only change files Siftvane created (or Docs and Sheets they were asked to edit).

## Profile: what agents know about you

- **How I handle my email (`behavior.md`).** Siftvane reads the emails you replied to (and the ones you left unanswered) and writes down which mail you answer and how you write: greeting, sign-off, length, typical answers, rules. Agents follow it when deciding what to reply to and how to word it. It is built automatically the first time you open Profile; edit it freely, download it, or rebuild it.
- **Business profile.** The only facts agents may state when replying to customers (products, prices, hours, policies, links). Replies never invent anything that isn't written here.
- **AI provider.** Which model plans agents, reads mail and writes replies.

## What an agent can do

The AI composes each agent as a program of steps from this library, and Siftvane executes every step itself:

| | Steps |
| --- | --- |
| Read | `mail.search` (emails and their PDF or text attachments, by keywords or by meaning), `drive.find` + `drive.read` (your Drive files, Docs, PDFs), `sheets.read`, `photos.extract` (each photo's text, by OCR, for the AI to read) |
| Understand (AI) | `extract` (any named fields, no fixed schema), `classify` (keep items matching a plain-language condition), `summarize`, `filter` |
| Write | `drive.folder`, `drive.save_attachments`, `drive.save_text`, `sheets.append`, `docs.write`, `calendar.reminders`, `mail.label` |
| Outbound | `mail.draft_replies` (each reply written for its email, in your style, from your business facts; always waits for approval), `mail.send` |

After a run the AI reviews sanitized results and may add follow-up steps. Agents run once, continuously (every few minutes), daily or weekly, taken from your words ("every time I get…", "every morning…"). A watching agent keeps watching while its earlier replies wait for approval, and never handles the same email twice.

Guards that no plan can get around:
- a step the request didn't ask for (labels, Drive copies, drafts, reminders, photo access) is removed;
- `mail.send` only goes to addresses you typed yourself;
- reply agents skip machines (no-reply, notifications, order updates, newsletters);
- untrusted text is screened for prompt injection, secrets and spreadsheet formula injection before it reaches the AI or a file;
- if the AI is unreachable or can't produce a usable plan, Siftvane says so (`AI_MODEL_UNAVAILABLE`, `AI_PLAN_UNUSABLE`) instead of guessing.

## Your rules and approvals

**Advanced → Rules & Policy** sets who is trusted (trusted senders may receive mail without asking; VIPs and strangers always need approval), blocked senders, the confidence needed to act, and how much an agent may do in one run (emails sent, calendar changes, tool calls). Rules are versioned; saving creates a new version.

**Approvals** lists everything waiting for you, with the full message to edit before you approve and send. Unanswered approvals expire after 24 hours and count as declined.

**Stop all agents** (top right) is the emergency stop: every agent halts at once, MCP clients get HTTP 423, and nothing can restart until you resume with a reason. From a terminal: `pnpm kill` / `pnpm resume`.

## Use Siftvane from any AI tool (MCP)

Siftvane is an MCP server at `http://localhost:4000/mcp` (Streamable HTTP). On **Profile → Advanced**, mint a token for a mailbox with only the scopes the tool needs; it is shown once and lasts 30 days. Setup snippets are provided for Claude Code, Codex, Cursor and Cline.

For Antigravity:

```sh
agy mcp add --header "Authorization: Bearer YOUR_TOKEN" siftvane-mail http://localhost:4000/mcp
```

Useful tools: `provision_and_run_agent` (make an agent from a sentence), `list_user_agents_and_logs`, `switch_active_agent`, `search_messages`, `get_thread`, `drive_find_files`, `drive_read_file`, `sheets_append_rows`, `docs_create_or_update`, `send_message` (policy-gated), `get_behavior_profile`, `get_business_profile` / `set_business_profile`, and the recipe tools. A token can never do more than its scopes, and an agent it creates can never exceed them either. For stdio clients, run `pnpm --silent siftvane-mcp` with `SIFTVANE_API_URL` and `SIFTVANE_MCP_TOKEN` set.

## Agent Pods: agents handing work to each other

A Pod is a group of agent inboxes (the sandbox ships with `triage` and `executor`). Mail arrives in one inbox; that inbox's agent can hand the case to another with `handoff_to_agent_inbox`, passing a summary, structured data and the attachments it was allowed to read. Every handoff is HMAC-signed, journaled and checked:

- only the inbox the email was addressed to can start a case thread, and after that only whoever currently holds it;
- an attachment can travel only if the sender received it or was handed it in the same thread;
- a hop budget and A → B → A → B detection pause runaway threads and ask you to reset them;
- `X-Siftvane-*` handoff headers on outside email are treated as forgeries and quarantined.

Mint Pod tokens on **Profile → Advanced → Agent inboxes** (`handoff:read`, `handoff:send`, `attachment:extract`). Each hop is replayed step by step under **Advanced → Runs & traces**.

## Recipes: teach once, run without the AI

An agent that handled a kind of email correctly can be saved as a **recipe** (**Advanced → Recipes**, or **Teach as recipe** on an agent). Code compiles it from the agent's steps; every value is traced to an email field, an earlier step, a fixed value or your formula, and anything it can't prove becomes a question you answer once. Add rules (*ask me first*, *skip*, *hand to an agent*) and formulas, backtest it over mail already in the inbox, then switch it on. Matching mail is then handled with zero model calls; mail it can't evaluate goes to a one-off AI agent instead of being guessed.

## Command line

```sh
pnpm agent create "Every morning, list my unread urgent emails in a sheet"
pnpm agent agents                 # list agents
pnpm agent watch                  # stream live events
pnpm agent halt "reason"          # emergency stop (resume with: pnpm agent resume "reason")
pnpm agent rollback <run_id>      # undo what a run created or changed
pnpm agent verify-trace traces/<run_id>.json
```

Set `SIFTVANE_OPERATOR_TOKEN` on the server and the CLI for operator commands against a live mailbox.

## Development

```sh
pnpm test        # unit, integration and browser tests (a local fake AI stands in for the provider)
pnpm typecheck
SIFTVANE_INBOX_LIVE=true pnpm workspace:smoke [inbox-id]   # end-to-end check against a real Google account
```

| Path | What lives there |
| --- | --- |
| `apps/server/src/platform` | The agent platform: AI planner (`llmPlanner.ts`), step library and plan repair (`generic.ts`), step executor (`programExecutor.ts`), scheduler (`runner.ts`), recipes, behavior file, AI provider settings |
| `apps/server/src/inbox` | The safety core: missions, policy, approvals, read-back checks, rollback, hash-chained traces, SQLite guards |
| `apps/server/src/mcp` | The MCP server and its tools |
| `apps/server/src/auth`, `mail`, `calendar`, `workspace` | Google sign-in and the Gmail, Calendar, Drive, Docs, Sheets and Photos adapters (live and sandbox) |
| `apps/server/src/handoffs` | Agent Pods and signed handoffs |
| `apps/server/src/sandbox/seed.ts` | The practice mailbox's sample data |
| `apps/web` | The website (Home, Approvals, Profile, Advanced) |
| `packages/shared` | Types and scanners shared by server and web |

Runs are written to `traces/` (ignored by git). The database lives in `data/siftvane.db`; keep it together with its encryption key when moving it.

## Known limits

- Small local models (7B) sometimes misjudge which emails match a condition or return broken JSON; Siftvane retries or rejects bad plans, and every outbound action still waits for approval. A larger model plans and judges noticeably better.
- Google refresh tokens for apps in *Testing* expire after about seven days; use **Reconnect Google** when asked.
- Sent mail cannot be recalled by rollback.

[Safety details](SAFETY.md) · [MIT License](LICENSE)
