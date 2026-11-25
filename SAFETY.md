# Clam safety controls

| Control | Enforcement |
| --- | --- |
| Reader boundary | `apps/server/src/inbox/reader.ts` opens SQLite with `readOnly: true` and `PRAGMA query_only=ON`. Live mode passes a read-only Gmail function. HTML, subject, and attachment text are inspected before typed intents are emitted. |
| Provenance and confidence | `evaluateSafeAction` in `inbox/policy.ts` checks contacts and allowlists, blocks untrusted body-only destinations, blocks secret and injected outbound text, and gates low-confidence and external actions. |
| SQLite defense in depth | `inbox/store.ts` defines `system_state` plus insert/update triggers on `inbox_actions`. Triggers enforce the halt latch, per-run write budgets, and immutable action identity. |
| Idempotency | `InboxEngine.apply` hashes source, playbook, action type, target, and target version within the mode. It reserves the claim in SQLite before dispatch. A claim with an uncertain result is reconciled by read-back. |
| Halt and circuit breakers | `InboxEngine.guard` checks the lockfile and database synchronously. `trip` latches the pipeline on a threat burst, tool loop, or budget breach. The MCP and Inbox paths use the operator latch, and the UI streams status. |
| Automation disclosure | `outboundPayload` appends a fixed disclosure footer and `X-Agent-Automated: true` for Tier 1. Sandbox verification checks the same transport-shaped state as the live adapter. |
| Verification and compensation | `InboxEngine.apply` stores the before and expected state and checks read-back before `VERIFIED`. `rollback` checks for intervening changes, restores eligible actions in reverse order, and verifies the result. Delivered messages have a manual-correction receipt. |
| Credentials and retention | Gmail and channel credentials are encrypted in the vault. The new Inbox trace keeps opaque source IDs, decisions, hashes, and structured state; live evidence is hashed. Raw live bodies, attachments, and edited mail bodies used by the transport are excluded from durable transport receipts. |
| Trace integrity | `inbox/trace.ts` recursively sorts object keys for canonical JSON, omits `step_hash` from that step’s input, and hashes `prev_hash + canonical_json(step)`. The terminal report, step count, and head hash are checked by the verifier. Keep a trusted independent copy of the head for provenance. |

Run `pnpm test` for SQLite guards, taint and confidence decisions, disclosure, repeat-run deduplication, rollback, malicious-input quarantine, and post-write timeout recovery. Read the generated [Trap Pack report](tests/trap_pack_report.md) for the isolated test results.
