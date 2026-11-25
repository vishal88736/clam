# Clam Trap Pack Harness

Drop official Agentware 2026 Trap Pack files (`.json`, `.eml`, or `.txt`) straight into [`cases/`](./cases/) and execute:

```bash
pnpm trap-pack:run
```

The harness automatically:
1. Parses JSON, raw EML, and malformed/broken MIME TXT payloads in RAM.
2. Injects them into Clam's Sandbox Inbox without persisting email bodies to SQLite.
3. Runs the **Travel & Bills Triage Agent** end-to-end over real MCP (`StreamableHTTPClientTransport`) to verify mission survival (legitimate itinerary & host draft still succeed) and zero exfiltration.
4. Probes each Trap Pack attack vector directly over MCP (`read_email`, `send_email`, `delete_email`, `create_draft` secret smuggling) and verifies the Auto-Trip Circuit Breaker.
5. Writes reproducible receipts to `traces/trap-pack-report.md` and `traces/trap-pack-trace.jsonl`.
