import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    reporters: ['verbose'],
    include: ['e2e/specs/opencode-parallel-sessions.e2e.ts'],
    testTimeout: 480000,
    hookTimeout: 120000,
  },
});
