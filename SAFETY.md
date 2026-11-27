# Siftvane safety controls

| Control | Enforcement |
| --- | --- |
| Reader boundary | `apps/server/src/inbox/reader.ts` opens SQLite with `readOnly: true` and `PRAGMA query_only=ON`. Live mode passes a read-only Gmail function. HTML, subject, and attachment text are inspected before analysis. The model is called without tool bindings and its outputs are schema- and evidence-checked. |
| Provenance and confidence | `evaluateSafeAction` in `apps/server/src/inbox/policy.ts` checks contacts and allowlists, blocks untrusted body-only destinations, blocks secret and injected outbound text, and gates low-confidence and external actions. |
| SQLite defense in depth | `apps/server/src/inbox/store.ts` defines `system_state` plus insert/update triggers on `inbox_actions`. Triggers enforce the halt latch, per-run write budgets, and immutable action identity. |
| Idempotency | `InboxEngine.apply` hashes source, playbook, action type, target, and target version within the mode. It reserves the claim in SQLite before dispatch. A claim with an uncertain result is reconciled by read-back. |
| Halt and circuit breakers | `InboxEngine.guard` checks the lockfile and database synchronously. `trip` latches the pipeline on a threat burst, tool loop, or budget breach. The console streams the operator latch status. |
| Automation disclosure | Both transport implementations in `apps/server/src/inbox/targets.ts` call `outboundPayload` after draft assembly. It appends a fixed footer and `X-Agent-Automated: true`. The tests attempt to strip the disclosure from the sandbox outbox and Gmail MIME payload. |
| Verification and compensation | `InboxEngine.apply` stores the before and expected state and checks read-back before `VERIFIED`. `rollback` checks for intervening changes, restores eligible actions in reverse order, and verifies the result. Delivered messages have a manual-correction receipt. |
| Google account security | `apps/server/src/auth/google.ts` binds one-time state to a browser cookie and uses S256 PKCE and an ID-token nonce. It encrypts access and refresh tokens independently using AES-256-GCM, checks the granted scope before provider calls, and verifies inbox ownership for browser and scoped MCP access. |
| Agent handoffs | `apps/server/src/handoffs/service.ts` binds the caller to a Pod inbox, signs the canonical envelope, and keeps the delivered payload marked untrusted. The journal reservation and SQLite trigger gate delivery. Loop attempts latch the thread and require operator review. Gmail and imported email quarantine external `X-Siftvane-*` headers. |
| Scoped verification | `apps/server/src/mcp/verification.ts` pins hosts, excludes recovery notices, and deduplicates message consumption per inbox. The hash-chained trace and SSE include a masked receipt and caller identifier. |
| Credentials and retention | The OAuth vault stores ciphertext. The trace keeps source IDs, decisions, hashes, structured state, and model telemetry. Raw live bodies, attachments, and draft content used by the transport are excluded from execution receipts. MCP extraction stages bounded input temporarily and removes the staged file after extraction. |
| Trace integrity | `apps/server/src/inbox/trace.ts` recursively sorts object keys for canonical JSON, omits `step_hash` from that step’s input, and hashes `prev_hash + canonical_json(step)`. The terminal report, step count, and head hash are checked by the verifier. Keep a trusted independent copy of the head for provenance. |

Run `pnpm test` for SQLite guards, taint and confidence decisions, disclosure, repeat-run deduplication, rollback, malicious-input quarantine, and post-write timeout recovery. Read the generated [adversarial regression report](tests/adversarial_regression_report.md) for the isolated test results.

`pnpm run-official-trap-pack PATH` puts each supplied case in its own SQLite database. Trap-mode policy permits the case’s quarantine write and blocks other mutations with `TRAP_ISOLATION`. The runner checks the journal and protected state independently, exits nonzero on degraded or failed cases, and links their JSON receipts in the generated report.

`tests/agentware-hard-rules.test.ts` starts a run with a pending model request and invokes the real halt CLI. It also verifies that a one-byte trace edit makes the verifier CLI exit nonzero.

## Workspace agents (Drive, Docs, Sheets, Photos)

Persistent agents created through `provision_and_run_agent` or the web console run as ordinary engine missions. They hold the same single-writer lease, kill-switch latch, budgets, hash-chained trace, Tier 0/1/2 gate, claim ledger, and read-back `CHECK` as inbox runs.

- **General programs.** Free-form requests compile into a program built only from Siftvane's typed step library. In LLM mode the model composes it and may add follow-up steps after reviewing sanitized observations: counts, field names, and short samples passed through the taint firewall. Raw email bodies are never sent to the model. Added steps are validated against the same schema, recipient guard, and policy gates, then journaled with the model's reasoning.
- **Planning cannot widen authority.** Siftvane validates both model-composed programs and ready-made workflows. Send and vendor recipients must appear verbatim in the user's own request. For MCP-created programs, Siftvane checks each operation against the originating token's scopes, including steps added during review. Google operations also require the corresponding OAuth grants. If the planner fails, Siftvane falls back to the deterministic compiler and records `PLAN_FALLBACK_DETERMINISTIC`.
- **Taint firewall.** Untrusted text from email, PDFs, or photos is sanitized before it reaches a Sheet or Doc:
  - formula prefixes and functions such as `IMPORTXML`, `HYPERLINK`, and `CMD|` are neutralized;
  - prompt-injection text and secrets are redacted;
  - live Sheets writes use `valueInputOption=RAW`.
  
  The workspace policy then blocks any remaining live formula (`WORKSPACE_FORMULA_INJECTION`).
- **Secret scanner.** Sheet and Doc text and Drive file contents (plain text, and PDFs through the quarantined extractor) are scanned. A detected secret blocks the write with `WORKSPACE_SECRET_BLOCKED`. Unscanned file content is also blocked.
- **Tier 2 gates.** The following always wait in the Approval Inbox and resume the agent automatically after a decision:
  - outbound mail to non-allowlisted recipients;
  - vendor RFQ batches;
  - bookings and payment confirmations (`FINANCIAL_COMMITMENT_APPROVAL`);
  - duplicate or spoofed invoices.
  
  An expired approval counts as declined.
- **Least-privilege Google scopes.**
  - The Workspace grant requests only `drive.file` and the Photos Picker scope `photospicker.mediaitems.readonly`. Siftvane can read only the photos the user picks in Google's own UI.
  - `documents` and `spreadsheets` are requested only to edit pre-existing files.
  - Full `drive` access and every Photos write or share scope are rejected with `GOOGLE_SCOPE_BANNED`.
- **Photos parsing.** Image bytes are bounded to 2 MB and parsed in-process (SVG text layer) or by a sandboxed Tesseract OCR child process (no shell, 6 s limit, 16 KB output). Only structured fields leave the parser.
- **Rollback.** Rolling back a run deletes only the artifacts that run created, using provider ids from Siftvane's own registry. Overwritten Drive files are restored from an MD5-verified backup of the previous bytes taken before the overwrite.
- **Audit.**
  - `agent_execution_logs` and `agent_switch_history` are append-only; SQLite triggers reject updates and deletes.
  - New `workspace_artifacts` rows and agent reactivation are rejected while the kill switch is latched.
  - Engaging the kill switch halts every active or waiting agent.
