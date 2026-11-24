import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClamApp } from '../apps/server/src/app.js';
import { CryptoVault } from '../apps/server/src/mail/vault.js';

describe('HITL Approvals, AES-256-GCM Vault & Zero-Retention Guarantees', () => {
  it('HITL Flow Test: ask-me-first creates approval, accepts signed Slack webhook, executes draft, and wipes RAM payload', async () => {
    const runtime = await createClamApp({ databasePath: ':memory:' });
    try {
      const signingSecret = 'test_slack_signing_secret_xyz';
      await runtime.approvalService.saveChannelConfigs({
        slack: { signingSecret },
      });

      const issued = await runtime.agentService.issueToken('ag_travel', 'HITL Test');

      // Trigger create_draft via real HTTP MCP call
      const draftRes = await runtime.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${issued.rawToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'create_draft',
            arguments: {
              to: 'kenji.host@airbnb-messages.example',
              subject: 'Re: Kyoto Arrival Time',
              body: 'Hi Kenji, arriving at 4:15 PM on Dec 20!',
              threadId: 'thr_hotel_airbnb_03',
            },
          },
        },
      });

      expect(draftRes.statusCode).toBe(200);
      const rpcBody = draftRes.json() as {
        result: { content: { text: string }[] };
      };
      const toolResult = JSON.parse(rpcBody.result.content[0].text) as {
        status: string;
        approval_id: string;
      };
      expect(toolResult.status).toBe('PENDING_APPROVAL');
      expect(toolResult.approval_id).toMatch(/^apr_/);

      // Verify RAM payload exists while PENDING
      expect(runtime.approvalService.getEphemeralPayload(toolResult.approval_id)?.body).toContain(
        '4:15 PM'
      );

      // Approve via signed Slack interactive webhook
      const slackPayload = JSON.stringify({
        actions: [{ action_id: 'clam_approve', value: toolResult.approval_id }],
      });
      const formBody = new URLSearchParams({ payload: slackPayload }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig =
        'v0=' +
        crypto
          .createHmac('sha256', signingSecret)
          .update(`v0:${timestamp}:${formBody}`)
          .digest('hex');

      const webhookRes = await runtime.app.inject({
        method: 'POST',
        url: '/webhooks/slack',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': sig,
        },
        payload: formBody,
      });

      expect(webhookRes.statusCode).toBe(200);

      // Verify approval is APPROVED, draft executed in Sandbox, and ephemeral RAM payload wiped
      const updated = await runtime.approvalService.getById(toolResult.approval_id);
      expect(updated?.status).toBe('APPROVED');
      expect(updated?.resolved_by).toBe('slack');
      expect(updated?.payload_wiped).toBe(true);
      expect(updated?.ephemeral_preview).toBeNull();
      expect(runtime.approvalService.getEphemeralPayload(toolResult.approval_id)).toBeNull();

      const sandboxState = runtime.mailService.sandbox.getStateSummary();
      expect(sandboxState.draftsCount).toBe(1);
      expect(sandboxState.drafts[0].subject).toBe('Re: Kyoto Arrival Time');

      // Audit logs must contain both PENDING_APPROVAL and APPROVED records
      const logs = await runtime.auditLogger.list({ agentId: 'ag_travel' });
      const decisions = logs.map((l) => l.decision);
      expect(decisions).toContain('PENDING_APPROVAL');
      expect(decisions).toContain('APPROVED');
    } finally {
      await runtime.close();
    }
  });

  it('TTL Expiry wipes ephemeral RAM payload automatically', async () => {
    const runtime = await createClamApp({ databasePath: ':memory:' });
    try {
      const approval = await runtime.approvalService.createApproval({
        agentId: 'ag_travel',
        agentName: 'Travel Itinerary Agent',
        mcpTool: 'create_draft',
        matchedRuleId: 'clause_2',
        ruleCitation: 'Draft replies to hosts for me to review.',
        payload: {
          tool: 'create_draft',
          to: 'host@example.com',
          subject: 'Secret ephemeral subject',
          body: 'Secret ephemeral body text',
        },
        ttlSeconds: -1, // Already past TTL
      });

      const swept = await runtime.approvalService.sweepExpired();
      expect(swept).toBe(1);
      expect(runtime.approvalService.getEphemeralPayload(approval.id)).toBeNull();

      const view = await runtime.approvalService.getById(approval.id);
      expect(view?.status).toBe('EXPIRED');
      expect(view?.payload_wiped).toBe(true);
      expect(view?.ephemeral_preview).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('Zero-Retention Assertion Test: SQLite on disk NEVER stores email subjects, bodies, senders, or draft payloads', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clam-zero-ret-'));
    const dbFile = path.join(tmpDir, 'clam-test.db');

    const runtime = await createClamApp({ databasePath: dbFile });
    try {
      const issued = await runtime.agentService.issueToken('ag_travel', 'Zero Retention Probe');
      const headers = {
        authorization: `Bearer ${issued.rawToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };

      // 1. List emails (touches all 18 sandbox emails in RAM including OTPs, bank alerts, medical labs)
      await runtime.app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_emails', arguments: { maxResults: 30 } },
        },
      });

      // 2. Read allowed flight email + denied bank OTP email + denied medical email
      for (const msgId of ['msg_flight_delta_01', 'msg_otp_bank_06', 'msg_medical_lab_10']) {
        await runtime.app.inject({
          method: 'POST',
          url: '/mcp',
          headers,
          payload: {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'read_email', arguments: { messageId: msgId } },
          },
        });
      }

      // 3. Create a draft with distinctive canary text
      const canaryDraftText = 'CANARY_PRIVATE_DRAFT_XYZ_99812';
      await runtime.app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'create_draft',
            arguments: {
              to: 'kenji.host@airbnb-messages.example',
              subject: 'CANARY_SUBJECT_SECRET_7741',
              body: canaryDraftText,
              threadId: 'thr_hotel_airbnb_03',
            },
          },
        },
      });

      // Query EVERY table in SQLite and serialize all rows
      const tables = runtime.dbHandle.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[];

      let fullDbDump = '';
      for (const t of tables) {
        const rows = runtime.dbHandle.sqlite.prepare(`SELECT * FROM "${t.name}"`).all();
        fullDbDump += JSON.stringify(rows);
      }

      const forbiddenStrings = [
        '849201', // Bank OTP
        'rst_998123_secret', // Google reset token
        'Comprehensive Metabolic Panel', // Medical lab
        '$4,850', // Wire fraud alert
        'H9K4LP', // Delta PNR
        'Cedar Machiya Townhouse', // Airbnb subject/body
        'new-unknown-utility.io', // Sender address
        'samira.rao@gmail.com', // Personal friend sender
        canaryDraftText,
        'CANARY_SUBJECT_SECRET_7741',
      ];

      for (const needle of forbiddenStrings) {
        expect(fullDbDump).not.toContain(needle);
      }

      // Also verify schema columns of audit_logs & approval_requests contain zero body/subject columns
      const auditCols = runtime.dbHandle.sqlite
        .prepare(`PRAGMA table_info(audit_logs)`)
        .all() as { name: string }[];
      const colNames = auditCols.map((c) => c.name);
      expect(colNames).not.toContain('subject');
      expect(colNames).not.toContain('body');
      expect(colNames).not.toContain('snippet');
      expect(colNames).not.toContain('from');
    } finally {
      await runtime.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('CryptoVault encrypts with AES-256-GCM and rejects tampered ciphertext', () => {
    const key = crypto.randomBytes(32);
    const vault = new CryptoVault(key);
    const blob = vault.encryptJson({ access_token: 'ya29.secret', refresh_token: '1//refresh' });
    expect(blob.ciphertext).not.toContain('ya29.secret');

    const decoded = vault.decryptJson<{ access_token: string }>(blob);
    expect(decoded.access_token).toBe('ya29.secret');

    expect(() =>
      vault.decryptJson({
        ...blob,
        ciphertext: Buffer.from('tampered').toString('base64'),
      })
    ).toThrow();
  });
});
