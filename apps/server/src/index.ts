import { createClamApp } from './app.js';

async function main() {
  const runtime = await createClamApp();
  await runtime.app.listen({ port: runtime.config.port, host: runtime.config.bindHost });
  console.log(
    `[clam-server] Listening on http://localhost:${runtime.config.port} (mode=${runtime.mailService.getMode()}, zero-retention=active)`
  );

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[clam-server] Fatal startup error:', err);
  process.exit(1);
});
