# Clam safety controls

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
| Agent handoffs | `apps/server/src/handoffs/service.ts` binds the caller to a Pod inbox, signs the canonical envelope, and keeps the delivered payload marked untrusted. The journal reservation and SQLite trigger gate delivery. Loop attempts latch the thread and require operator review. Gmail and imported email quarantine external `X-Clam-*` headers. |
| Scoped verification | `apps/server/src/mcp/verification.ts` pins hosts, excludes recovery notices, and deduplicates message consumption per inbox. The hash-chained trace and SSE include a masked receipt and caller identifier. |
| Credentials and retention | The OAuth vault stores ciphertext. The trace keeps source IDs, decisions, hashes, structured state, and model telemetry. Raw live bodies, attachments, and draft content used by the transport are excluded from execution receipts. MCP extraction stages bounded input temporarily and removes the staged file after extraction. |
| Trace integrity | `apps/server/src/inbox/trace.ts` recursively sorts object keys for canonical JSON, omits `step_hash` from that step’s input, and hashes `prev_hash + canonical_json(step)`. The terminal report, step count, and head hash are checked by the verifier. Keep a trusted independent copy of the head for provenance. |

Run `pnpm test` for SQLite guards, taint and confidence decisions, disclosure, repeat-run deduplication, rollback, malicious-input quarantine, and post-write timeout recovery. Read the generated [adversarial regression report](tests/adversarial_regression_report.md) for the isolated test results.

`pnpm run-official-trap-pack PATH` puts each supplied case in its own SQLite database. Trap-mode policy permits the case’s quarantine write and blocks other mutations with `TRAP_ISOLATION`. The runner checks the journal and protected state independently, exits nonzero on degraded or failed cases, and links their JSON receipts in the generated report.

`tests/agentware-hard-rules.test.ts` starts a run with a pending model request and invokes the real halt CLI. It also verifies that a one-byte trace edit makes the verifier CLI exit nonzero.
