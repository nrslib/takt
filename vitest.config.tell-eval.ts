import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['eval/scenarios/tell/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 300_000,
    teardownTimeout: 5_000,
  },
});
