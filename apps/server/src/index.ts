import { createSiftvaneApp } from './app.js';

async function main() {
  const runtime = await createSiftvaneApp();
  await runtime.app.listen({ port: runtime.config.port, host: runtime.config.bindHost });
  console.log(
    `[siftvane-server] Listening on http://localhost:${runtime.config.port} (${runtime.config.inboxLive ? 'Gmail' : 'sandbox'} mode)`
  );

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[siftvane-server] Fatal startup error:', err);
  process.exit(1);
});
