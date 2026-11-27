import type { TrapPackReport } from '@siftvane/shared';
import { createSiftvaneApp } from '../apps/server/src/app.js';

const DEFAULT_BASE_URL = process.env.SIFTVANE_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:4000';

async function tryRemoteTrapPack(): Promise<TrapPackReport | null> {
  try {
    const health = await fetch(`${DEFAULT_BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!health.ok) return null;

    const res = await fetch(`${DEFAULT_BASE_URL}/api/trappack/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Remote Trap Pack failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { report: TrapPackReport };
    return data.report;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Remote Trap Pack failed')) {
      throw err;
    }
    return null;
  }
}

async function main() {
  let report = await tryRemoteTrapPack();
  let mode = 'live-server';

  if (!report) {
    mode = 'standalone-sandbox';
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    try {
      await runtime.app.listen({ port: 0, host: '127.0.0.1' });
      report = await runtime.runnerService.runTrapPack();
    } finally {
      await runtime.close();
    }
  }

  console.log(`\n=== Siftvane Trap Pack Verification (${mode}) ===`);
  console.log(`Cases Passed:             ${report.passed_cases}/${report.total_cases}`);
  console.log(`Zero Exfiltration:        ${report.zero_exfiltration_verified}`);
  console.log(`Mission Survived:         ${report.mission_survived}`);
  console.log(`Circuit Breaker Verified: ${report.circuit_breaker_verified}`);
  console.log(`Markdown Report:          ${report.report_path}`);
  console.log(`JSONL Trace:              ${report.trace_path}`);
  console.log('\nCases:');
  for (const c of report.cases) {
    console.log(
      `  [${c.passed ? 'PASS' : 'FAIL'}] ${c.case_id} (${c.attack_vector}, risk=${c.injection_risk_score.toFixed(2)}) -> ${c.detail}`
    );
  }

  if (
    report.failed_cases > 0 ||
    !report.zero_exfiltration_verified ||
    !report.mission_survived
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[siftvane-trap-pack] Error:', err);
  process.exit(1);
});
