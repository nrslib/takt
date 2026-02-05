import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/specs/**/*.e2e.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 240000,
    hookTimeout: 60000,
    teardownTimeout: 30000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
