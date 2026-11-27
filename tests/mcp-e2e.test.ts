import { Client } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';

describe('Live MCP Server Protocol & Silent Filtering End-to-End', () => {
  it('enforces Bearer auth, lists MCP tools, silently filters list_emails, and blocks direct read_email on sensitive messages', async () => {
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const addr = runtime.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Unauthenticated /mcp call must fail with 401
      const unauthRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthRes.status).toBe(401);

      // 2. Issue scoped token for Travel Itinerary Agent and connect official MCP SDK client
      const issued = await runtime.agentService.issueToken('ag_travel', 'MCP E2E Client');

      const client = new Client({ name: 'siftvane-e2e-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${issued.rawToken}`,
          },
        },
      });
      await client.connect(transport);

      // 3. tools/list verification
      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((t) => t.name);
      expect(toolNames).toContain('list_emails');
      expect(toolNames).toContain('search_emails');
      expect(toolNames).toContain('read_email');
      expect(toolNames).toContain('create_draft');
      expect(toolNames).toContain('send_email');
      expect(toolNames).toContain('archive_email');
      expect(toolNames).toContain('apply_label');

      // 4. list_emails silent filtering verification
      const listRes = await client.callTool({
        name: 'list_emails',
        arguments: { maxResults: 30 },
      });
      const listText = (listRes.content as { type: string; text: string }[])[0].text;
      const parsedList = JSON.parse(listText) as {
        emails: { id: string; subject: string }[];
        returned: number;
      };

      // Must NOT expose OTPs, password resets, bank alerts, medical records, legal NDAs, or personal emails
      const returnedIds = parsedList.emails.map((e) => e.id);
      expect(returnedIds).toContain('msg_flight_delta_01');
      expect(returnedIds).toContain('msg_hotel_airbnb_03');
      expect(returnedIds).toContain('msg_host_kenji_04');
      expect(returnedIds).not.toContain('msg_otp_bank_06');
      expect(returnedIds).not.toContain('msg_bank_alert_07');
      expect(returnedIds).not.toContain('msg_pw_google_08');
      expect(returnedIds).not.toContain('msg_medical_lab_10');
      expect(returnedIds).not.toContain('msg_legal_nda_18');
      expect(returnedIds).not.toContain('msg_personal_17');
      // Must NOT leak hidden counts
      expect(Object.keys(parsedList)).toEqual(['emails', 'returned']);

      // 5. Direct read_email on password reset is DENIED
      const deniedRead = await client.callTool({
        name: 'read_email',
        arguments: { messageId: 'msg_pw_google_08' },
      });
      expect(deniedRead.isError).toBe(true);
      const deniedBody = (deniedRead.content as { type: string; text: string }[])[0].text;
      expect(deniedBody).toContain('SIFTVANE_POLICY_DENIED');
      expect(deniedBody).not.toContain('rst_998123_secret');

      // 6. Direct send_email is hard-denied deterministically
      const deniedSend = await client.callTool({
        name: 'send_email',
        arguments: {
          to: 'kenji.host@airbnb-messages.example',
          subject: 'Hello',
          body: 'Sending directly',
        },
      });
      expect(deniedSend.isError).toBe(true);
      const sendBody = (deniedSend.content as { type: string; text: string }[])[0].text;
      expect(sendBody).toContain('HARD_DENIED_SEND');

      await client.close();
      await runtime.agentService.revokeToken('ag_travel', issued.info.id);
      const revokedRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issued.rawToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      expect(revokedRes.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });

  it('pushes real-time SSE events and handles Telegram & WhatsApp HITL callbacks', async () => {
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const addr = runtime.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Configure Telegram & WhatsApp secrets
      await runtime.approvalService.saveChannelConfigs({
        telegram: { webhookSecret: 'tg_secret_123' },
        whatsapp: { verifyToken: 'wa_verify_123', appSecret: 'wa_app_secret_123' },
      });

      // Verify WhatsApp GET challenge
      const waChallenge = await fetch(
        `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa_verify_123&hub.challenge=987654`
      );
      expect(waChallenge.status).toBe(200);
      expect(await waChallenge.text()).toBe('987654');

      // Connect SSE stream
      const sseController = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/events/stream`, {
        signal: sseController.signal,
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      const firstChunk = await reader.read();
      expect(decoder.decode(firstChunk.value)).toContain('event: connected');

      // Create an approval & deny via Telegram webhook
      const apr1 = await runtime.approvalService.createApproval({
        agentId: 'ag_triage',
        agentName: 'Inbox Triage Assistant',
        mcpTool: 'create_draft',
        matchedRuleId: 'clause_3',
        ruleCitation: 'Ask me first before creating drafts.',
        payload: {
          tool: 'create_draft',
          to: 'maya@example.com',
          subject: 'Re: Outreach',
          body: 'Thanks for reaching out.',
        },
      });

      // Read SSE approval.created push
      const secondChunk = await reader.read();
      expect(decoder.decode(secondChunk.value)).toContain(apr1.id);

      const tgRes = await fetch(`${baseUrl}/webhooks/telegram`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'tg_secret_123',
        },
        body: JSON.stringify({
          callback_query: {
            id: 'cbq_1',
            data: `deny:${apr1.id}`,
          },
        }),
      });
      expect(tgRes.status).toBe(200);
      const afterTg = await runtime.approvalService.getById(apr1.id);
      expect(afterTg?.status).toBe('REJECTED');
      expect(afterTg?.resolved_by).toBe('telegram');
      expect(afterTg?.payload_wiped).toBe(true);

      sseController.abort();
    } finally {
      await runtime.close();
    }
  });
});
