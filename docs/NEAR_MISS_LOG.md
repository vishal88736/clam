# Near-miss log

The following issues were observed during local sandbox checks and addressed before packaging.

| Observation | Fix and verification |
| --- | --- |
| The legacy filtered pnpm launch returned HTTP 200 with 0 Trap Pack cases. | Root-relative fixture paths replace package working-directory paths. Fixture-loading errors surface instead of returning an empty case list. |
| A normal run followed by the legacy Trap Pack inherited the earlier rate window and returned HTTP 500 at call 26. | The legacy call window is scoped to the run when a run ID is available. The new Trap Pack runs in isolated SQLite databases. |
| The legacy suite halted itself, then its resume left the new SQLite latch active. | Explicit global resume now releases both latches. The existing real-MCP Trap Pack test exercises the resume path. |
| A repeated sandbox run added an extra pre-meeting dossier because its first run deferred that event. | Dossier planning uses imminent existing events and attaches context to a new booking in its original verified write. The repeat-run test now asserts zero new calendar or outbound writes. |
| A simulated timeout after a committed calendar mutation left its first run failed. | Recovery reads the original target back, verifies the existing receipt, and leaves exactly one flight write. The Trap Pack reruns this fault and reports the result. |
| A fresh Docker build rejected the existing pnpm lockfile. | Added the missing agent importer and the server’s workspace link using the existing lockfile versions. The build uses frozen dependencies. |
| A restart can leave a previously claimed row in RUNNING. | A persistent expiring worker lease distinguishes an active process from an interrupted run. Recovery writes an explicit failure receipt and rechecks outstanding action claims before any new mutations. |
| A local Ollama run produced structured JSON with IDs that did not match the target batch. | The run recorded `MODEL_OUTPUT_IDS_INVALID` and executed no actions. The revised response schema makes each expected message ID a required object key. |
| A synthetic AWS-shaped access key passed the outbound scanner and reached the sandbox outbox during the acceptance audit. | The shared scanner now recognizes AWS identifiers and common credential assignments. The MCP regression expects `OUTBOUND_CONTENT_BLOCKED` and an empty outbox before the batch approval test begins. |
