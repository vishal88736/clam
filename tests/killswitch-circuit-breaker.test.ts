import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';

describe('Kill Switch, HTTP 423 Enforcement, AbortController & Auto-Trip Circuit Breaker', () => {
  it('engages Kill Switch via API, returns HTTP 423 on /mcp, freezes approvals, and requires reason to resume', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftvane-ks-'));
    const runtime = await createSiftvaneApp({
      databasePath: ':memory:',
      config: {
        artifactsDir: path.join(tmpDir, 'artifacts'),
        tracesDir: path.join(tmpDir, 'traces'),
      },
    });
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const addr = runtime.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const issued = await runtime.agentService.issueToken('ag_travel', 'KS Test Token');

      // Create pending approval before halt
      const apr = await runtime.approvalService.createApproval({
        agentId: 'ag_travel',
        agentName: 'Travel Itinerary Agent',
        mcpTool: 'create_draft',
        matchedRuleId: 'clause_2',
        ruleCitation: 'Draft replies to hosts for me to review.',
        payload: {
          tool: 'create_draft',
          to: 'kenji.host@airbnb-messages.example',
          subject: 'Arrival check-in',
          body: 'Arriving at 3:30 PM.',
        },
      });

      // Engage Kill Switch
      const engageRes = await runtime.app.inject({
        method: 'POST',
        url: '/api/killswitch/engage',
        payload: {
          trigger_mode: 'manual_api',
          engaged_by: 'test_operator',
          reason: 'Emergency halt test',
        },
      });
      expect(engageRes.statusCode).toBe(200);
      expect(engageRes.json().kill_switch.status).toBe('HALTED');

      // Subsequent /mcp request must return HTTP 423 Locked with KILL_SWITCH_ENGAGED
      const mcpRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issued.rawToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_emails', arguments: { maxResults: 5 } },
        }),
      });
      expect(mcpRes.status).toBe(423);
      const mcpJson = (await mcpRes.json()) as { error?: { message?: string } };
      expect(mcpJson.error?.message).toBe('KILL_SWITCH_ENGAGED');

      // Pending approvals cannot execute while halted
      await expect(
        runtime.approvalService.resolveApproval({
          id: apr.id,
          resolution: 'APPROVED',
          channel: 'app',
        })
      ).rejects.toThrow(/KILL_SWITCH_ENGAGED/);

      // Resume without reason fails validation (400)
      const badResume = await runtime.app.inject({
        method: 'POST',
        url: '/api/killswitch/resume',
        payload: { reason: '' },
      });
      expect(badResume.statusCode).toBe(400);

      // Resume with explicit reason succeeds and logs KILL_SWITCH_RESUMED
      const goodResume = await runtime.app.inject({
        method: 'POST',
        url: '/api/killswitch/resume',
        payload: { reason: 'Operator cleared test condition', resumed_by: 'test_operator' },
      });
      expect(goodResume.statusCode).toBe(200);
      expect(goodResume.json().kill_switch.status).toBe('ARMED');

      const logs = await runtime.auditLogger.list({ limit: 20 });
      const decisions = logs.map((l) => l.decision);
      expect(decisions).toContain('KILL_SWITCH_ENGAGED');
      expect(decisions).toContain('KILL_SWITCH_RESUMED');
    } finally {
      await runtime.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('aborts in-flight AbortController registrations immediately upon Kill Switch engage', async () => {
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    try {
      const controller = new AbortController();
      let abortedFired = false;
      controller.signal.addEventListener('abort', () => {
        abortedFired = true;
      });

      const unregister = runtime.killSwitchService.registerInFlight(
        'run_inflight_test',
        'ag_autonomous',
        controller
      );
      expect(runtime.killSwitchService.getState().active_runs_count).toBe(1);

      const state = await runtime.killSwitchService.engage({
        triggerMode: 'manual_ui',
        reason: 'Aborting in-flight operation',
      });

      expect(abortedFired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(state.aborted_inflight_count).toBe(1);
      expect(state.active_runs_count).toBe(0);
      unregister();
    } finally {
      await runtime.close();
    }
  });

  it('Auto-Trip Circuit Breaker halts agent automatically after repeated forbidden tool violations', async () => {
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const addr = runtime.app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      const issued = await runtime.agentService.issueToken('ag_autonomous', 'Breaker Test');

      // Fire 3 consecutive forbidden send_email calls
      for (let i = 1; i <= 3; i++) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issued.rawToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: i,
            method: 'tools/call',
            params: {
              name: 'send_email',
              arguments: {
                to: 'external@example.com',
                subject: `Forbidden send ${i}`,
                body: 'Benign text repeated violation',
              },
            },
          }),
        });
        expect(res.status).toBe(200);
      }

      // Breaker must now be HALTED
      const ks = runtime.killSwitchService.getState();
      expect(ks.status).toBe('HALTED');
      expect(ks.trigger_mode).toBe('circuit_breaker');

      // 4th call is immediately rejected with HTTP 423 Locked
      const lockedRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issued.rawToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'list_emails', arguments: { maxResults: 5 } },
        }),
      });
      expect(lockedRes.status).toBe(423);

      const logs = await runtime.auditLogger.list({ limit: 20 });
      expect(logs.some((l) => l.decision === 'CIRCUIT_BREAKER_TRIPPED')).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
