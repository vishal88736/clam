import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@siftvane/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@siftvane/server': path.resolve(__dirname, 'apps/server/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
