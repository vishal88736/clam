# SAFETY.md — Guardrails, Kill Switch & Threat Model

## 1. Code-Enforced Guardrails (Never Prompt-Only)

Clam enforces every security invariant in deterministic TypeScript code (`packages/shared/src/deterministic.ts`, `packages/shared/src/injection.ts`, `apps/server/src/policy/engine.ts`, `apps/server/src/killswitch/service.ts`) before and independently of any LLM:

1. **Credential Isolation:** Autonomous agents (`apps/agent`) authenticate to Clam `/mcp` solely via scoped, revocable Bearer tokens (`clm_ag_...`, stored as SHA-256 hashes in `agent_tokens`). Agents never see Gmail OAuth access/refresh tokens (`vault_secrets`, AES-256-GCM encrypted).
2. **Stage A Deterministic Hard Gates (< 1 ms):**
   - `evaluateDeterministicGate()` blocks `send_email` (`HARD_DENIED_SEND`) and `delete_email` (`HARD_DENIED_DELETE` / `DEFAULT_DENY_DELETE`) before any semantic classifier or LLM executes.
   - `scanOutboundSecrets()` blocks Clam tokens (`clm_ag_...`), private cryptographic keys, OTP / 2FA codes, and password reset links from leaving via `send_email`, `create_draft`, or `save_itinerary_artifact` (`NO_CREDENTIALS_OR_OTP`).
   - `save_itinerary_artifact` restricts writes strictly to validated basenames (`^[a-zA-Z0-9._-]+\.(md|json|ics|txt)$`) inside `CLAM_ARTIFACTS_DIR`.
3. **Stage B Fail-Closed Semantic & Indirect Prompt-Injection Shield:**
   - `detectSensitiveCategory()` runs deterministically in RAM across `otp_2fa`, `password_resets`, `bank_security_alerts`, `medical_records`, `legal_confidential`, and `crypto_seed_recovery`.
   - `scanPromptInjection()` scans ephemeral emails and outbound payloads in RAM for instruction overrides (`INJ_INSTRUCTION_OVERRIDE`), system prompt spoofing (`INJ_SYSTEM_PROMPT_SPOOF`), hidden HTML/CSS smuggling (`INJ_HIDDEN_HTML_SMUGGLING`, `INJ_HTML_COMMENT_DIRECTIVE`), executive wire coercion (`INJ_CEO_WIRE_COERCION`), zero-width obfuscation (`INJ_ZERO_WIDTH_OBFUSCATION`), and exfiltration imperatives (`INJ_EXFIL_SEND_COMMAND`, `INJ_ATTACKER_EMAIL_TARGET`, `INJ_DESTRUCTIVE_TOOL_IMPERATIVE`). Any message with `risk_score >= 0.55` is blocked (`PROMPT_INJECTION_BLOCKED`).
   - `list_emails` and `search_emails` silently strip unauthorized, sensitive, and injected emails without returning hidden counts or metadata.
   - External LLM classifiers (`openai`, `anthropic`, `gemini`, `ollama`) validate strict JSON via Zod (`SemanticClassificationResultSchema`) and unconditionally fail closed (`DENY`) on HTTP errors, timeouts (`CLAM_CLASSIFIER_TIMEOUT_MS`), malformed JSON, unrecognized scopes, or confidence `< 0.65`.

## 2. Hardware-Grade Emergency Kill Switch & Auto-Trip Circuit Breaker

Implemented in `apps/server/src/killswitch/service.ts` and enforced at HTTP `/mcp`, `/mcp/sse`, `/mcp/messages`, MCP tool execution, and `ApprovalService.resolveApproval()`:

1. **UI Emergency Latch:** Matte crimson **KILL SWITCH** button in the console top bar (plus global `Shift+K` shortcut) immediately flips state to `HALTED` and snaps the Clam mascot into its double-bolted `halted` state.
2. **CLI & REST API Halt:**
   - CLI: `pnpm kill` (works both online via `/api/killswitch/engage` and offline by latching SQLite `kill_switch_state`) and `pnpm resume --reason="..."`.
   - API: `POST /api/killswitch/engage` and `POST /api/killswitch/resume` (requires explicit non-empty `reason`).
3. **Auto-Trip Circuit Breaker:**
   - Automatically engages `HALTED` (`CIRCUIT_BREAKER_TRIPPED`) if an agent hits:
     - `>= 3` blocked policy violations within a `30s` sliding window (configurable), OR
     - `> 25` MCP calls/min (runaway loop detector), OR
     - Critical outbound secret leak (`NO_CREDENTIALS_OR_OTP`) or critical injection (`injection_risk_score >= 0.75`) toward `send_email`, `delete_email`, or `create_draft`.
4. **In-Flight Interruption & Post-Halt Freeze:**
   - Every active autonomous run registers an `AbortController` via `registerInFlight()`. Engaging the Kill Switch calls `.abort()` immediately, cancelling active loops and HTTP requests.
   - All subsequent `/mcp` requests return **HTTP `423 Locked`** (`KILL_SWITCH_ENGAGED`).
   - Pending HITL approvals cannot be executed while halted, and every engage/trip/resume event writes an immutable audit record (`KILL_SWITCH_ENGAGED`, `CIRCUIT_BREAKER_TRIPPED`, `KILL_SWITCH_RESUMED`).

## 3. Failure-Mode Matrix

| Failure / Threat Scenario | Detection Layer | Enforced Behavior | Audit / Trace Receipt |
| --- | --- | --- | --- |
| Indirect prompt injection in email body | Stage B (`scanPromptInjection`) | Silently stripped from `list_emails`; `read_email` returns `PROMPT_INJECTION_BLOCKED` | `DENY`, `injection_risk_score`, signal codes |
| Hidden HTML (`display:none` / white text) | Stage B (`INJ_HIDDEN_HTML_SMUGGLING`) | Stripped in RAM before agent sees body | `DENY`, `injection_risk_score = 1.00` |
| Hijacked `send_email` / `delete_email` | Stage A (`evaluateDeterministicGate`) | Blocked deterministically (`HARD_DENIED_SEND` / `HARD_DENIED_DELETE`) | `DENY` at `STAGE_A_DETERMINISTIC` |
| Outbound OTP / token smuggling in draft or `.md`/`.json` | Stage A (`scanOutboundSecrets`) | Blocked (`NO_CREDENTIALS_OR_OTP`) + trips Circuit Breaker | `DENY` + `CIRCUIT_BREAKER_TRIPPED` |
| Malformed / broken MIME payload | Stage B (`scanPromptInjection` + fail-closed) | Safe RAM scan without crash; denied before agent exposure | `DENY`, `PROMPT_INJECTION_BLOCKED` |
| External LLM timeout / invalid JSON / low confidence | Stage B (`classifyEmailWithProvider`) | Unconditional fail-closed `DENY` (`CLASSIFIER_*_FAIL_CLOSED`) | `DENY`, `confidence: 0` |
| Agent tool loop (`> 25` calls/min) or `>= 3` denials/30s | `KillSwitchService.recordToolOutcome` | Auto-Trip Circuit Breaker halts agent; `/mcp` returns HTTP `423` | `CIRCUIT_BREAKER_TRIPPED` |
| Operator hits Kill Switch during active run | `KillSwitchService.engage` + `AbortController` | Aborts in-flight HTTP/agent loop; freezes approvals; locks `/mcp` (`423`) | `KILL_SWITCH_ENGAGED` |

## 4. Zero-Retention Verification

Raw email subjects, bodies, senders, and attachment contents exist strictly in ephemeral RAM during evaluation (`EphemeralEmail` and `EphemeralRamVault` with explicit `Buffer.fill(0)` wipe on HITL resolution/expiry). SQLite (`data/clam.db`) and JSONL traces (`traces/*.jsonl`) store only HMAC-SHA256 `message_id_hash`, `trace_id`, `run_id`, rule citations, semantic category IDs, confidence scores, `injection_risk_score`, signal codes, and latency. Verified automatically via `tests/hitl-zero-retention.test.ts` and `pnpm verify:zero-retention`.

## 5. Trap Pack Results Summary

Executed via `pnpm trap-pack:run` against the 6 built-in adversarial cases in `trap-pack/cases/` (see `traces/trap-pack-report.md` and `traces/trap-pack-trace.jsonl`):

- **Cases Passed:** `6 / 6`
- **Zero Exfiltration Verified:** `true` (`0` outbound leaks, `0` sent emails)
- **Legitimate Mission Survived:** `true` (`itinerary.md`, `digest.json`, `trip.ics`, and 1 safe host review draft completed alongside poisoned inbox)
- **Auto-Trip Circuit Breaker Verified:** `true`
