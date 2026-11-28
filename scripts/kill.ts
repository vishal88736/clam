import { createSiftvaneApp } from '../apps/server/src/app.js';

const DEFAULT_BASE_URL = process.env.SIFTVANE_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:4000';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

async function main() {
  const isResume = process.argv.includes('--resume');
  const reason =
    getArg('--reason') ||
    (isResume
      ? 'Operator disarmed Kill Switch via CLI'
      : 'Emergency Kill Switch engaged via CLI (`pnpm kill`)');
  const agentId = getArg('--agent');

  try {
    const token = process.env.SIFTVANE_OPERATOR_TOKEN?.trim();
    const res = await fetch(`${DEFAULT_BASE_URL}/api/inbox/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Siftvane-Operator-Token': token } : {}) },
      body: JSON.stringify({ active: !isResume, reason }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  } catch (err) {
    // Fallback to direct SQLite state latch when server is offline
    if (err instanceof Error && !err.message.includes('fetch failed') && !err.message.includes('ECONNREFUSED')) {
      throw err;
    }
    const runtime = await createSiftvaneApp({
    });
    try {
      const state = isResume
        ? await runtime.killSwitchService.resume({
            reason,
            resumedBy: 'cli_operator_offline',
            agentId,
          })
        : await runtime.killSwitchService.engage({
            reason,
            engagedBy: 'cli_operator_offline',
            triggerMode: 'manual_cli',
            agentId,
          });
      console.log(JSON.stringify({ kill_switch: state, mode: 'offline_db_latch' }, null, 2));
    } finally {
      await runtime.close();
    }
  }
}

main().catch((err) => {
  console.error('[siftvane-kill] Error:', err);
  process.exit(1);
});
