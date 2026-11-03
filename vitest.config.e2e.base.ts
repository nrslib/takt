import type { TestUserConfig } from 'vitest/config';

export const e2eBaseTestConfig: TestUserConfig = {
  environment: 'node',
  globals: false,
  testTimeout: 240000,
  hookTimeout: 60000,
  teardownTimeout: 30000,
  forceExit: true,
  pool: 'threads',
  maxWorkers: 1,
  reporters: ['verbose', 'json'],
};
