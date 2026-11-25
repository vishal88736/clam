import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@clam/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@clam/agent': path.resolve(__dirname, 'apps/agent/src/index.ts'),
      '@clam/server': path.resolve(__dirname, 'apps/server/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
