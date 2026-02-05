import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['src/__tests__/test-setup.ts'],
    // Ensure proper cleanup by forcing sequential execution and graceful shutdown
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    // Increase timeout for tests with async cleanup
    testTimeout: 15000,
    // Force exit after tests complete to prevent hanging
    teardownTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
    },
  },
});
