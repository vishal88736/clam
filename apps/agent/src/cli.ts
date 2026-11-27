import { siftvaneEnvironment } from '@siftvane/shared';
import { runAutonomousInboxAgent } from './runner.js';

async function main() {
  const env = siftvaneEnvironment(process.env);
  const mcpUrl = env.SIFTVANE_MCP_URL || 'http://localhost:4000/mcp';
  const bearerToken = env.SIFTVANE_AGENT_TOKEN || '';
  if (!bearerToken) {
    console.error('Missing SIFTVANE_AGENT_TOKEN environment variable. Use `pnpm agent:run` for zero-setup demo.');
    process.exit(1);
  }

  const summary = await runAutonomousInboxAgent({
    mcpUrl,
    bearerToken,
    onStep: (step) => {
      console.log(`[step ${step.step}] (${step.status}) ${step.action}: ${step.detail}`);
    },
  });

  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== 'completed') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
