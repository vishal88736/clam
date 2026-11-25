import path from 'node:path';
import type { AgentRunSummary } from '@clam/shared';
import { createClamApp } from '../apps/server/src/app.js';

const DEFAULT_BASE_URL = process.env.CLAM_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:4000';

async function tryRemoteRun(): Promise<AgentRunSummary | null> {
  try {
    const health = await fetch(`${DEFAULT_BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!health.ok) return null;

    const res = await fetch(`${DEFAULT_BASE_URL}/api/agent-runs/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'ag_autonomous' }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Remote agent run failed (HTTP ${res.status}): ${txt}`);
    }
    const data = (await res.json()) as { run: AgentRunSummary };
    return data.run;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Remote agent run failed')) {
      throw err;
    }
    return null;
  }
}

async function main() {
  let summary = await tryRemoteRun();
  let mode = 'live-server';

  if (!summary) {
    mode = 'standalone-ephemeral';
    const runtime = await createClamApp({
      databasePath: path.resolve(process.cwd(), 'data/clam.db'),
    });
    try {
      await runtime.app.listen({ port: 0, host: '127.0.0.1' });
      if (runtime.killSwitchService.isHalted('ag_autonomous')) {
        await runtime.killSwitchService.resume({
          resumedBy: 'demo_cli',
          reason: 'Preparing clean ARMED state for standalone demo run.',
        });
      }
      summary = await runtime.runnerService.startAutonomousRun({
        agentId: 'ag_autonomous',
      });
    } finally {
      await runtime.close();
    }
  }

  console.log(`\n=== Clam Autonomous Inbox Agent Run (${mode}) ===`);
  console.log(`Run ID:                 ${summary.run_id}`);
  console.log(`Agent:                  ${summary.agent_name} (${summary.agent_id})`);
  console.log(`Status:                 ${summary.status.toUpperCase()}`);
  console.log(`Provider / Cost:        ${summary.provider} ($${summary.estimated_cost_usd.toFixed(4)})`);
  console.log(`Permitted Emails:       ${summary.emails_permitted}`);
  console.log(`Stripped / Blocked:     ${summary.emails_stripped_or_blocked}`);
  console.log(`Conflicts Resolved:     ${summary.conflicts_resolved}`);
  console.log(`Drafts Created (Safe):  ${summary.drafts_created}`);
  console.log(`Artifacts Written:      ${summary.artifacts_written.join(', ')}`);
  console.log(`Trace Receipt:          ${summary.trace_path}`);
  console.log('\nExecution Steps:');
  for (const s of summary.steps) {
    console.log(`  ${s.step}. [${s.status.toUpperCase()}] ${s.action} — ${s.detail} (${s.latency_ms}ms)`);
  }

  if (summary.status !== 'completed') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[clam-agent-run] Error:', err);
  process.exit(1);
});
