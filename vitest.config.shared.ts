import type { UserConfig } from 'vitest/config';
import {
  parallelIntegrationTestGlobs,
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from './scripts/test-classification.mjs';

export const srcTestInclude = ['src/__tests__/**/*.test.ts'];

export const itTestGlobs = [...parallelIntegrationTestGlobs];

// These files create real repositories and mutate branches/commits. Keep them
// serial to avoid IO-heavy git operations competing inside the same pool.
export const itSerialGitTestGlobs = [
  ...serialGitTestFiles,
];

export const itSerialWorkflowLoaderTestGlobs = [
  ...serialWorkflowTestFiles,
];

export const itSerialTestGlobs = [
  ...itSerialGitTestGlobs,
  ...itSerialWorkflowLoaderTestGlobs,
];

export const commonSrcTestConfig = {
  env: {
    TAKT_CONFIG_DIR: '',
    TAKT_NOTIFY_WEBHOOK: '',
  },
  environment: 'node',
  globals: false,
  reporters: ['dot'],
  setupFiles: ['src/__tests__/test-setup.ts'],
  testTimeout: 15000,
  teardownTimeout: 5000,
  coverage: {
    provider: 'v8',
    reporter: ['text', 'json', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
  },
} satisfies UserConfig['test'];

export const parallelSrcRunnerConfig = {
  pool: 'forks',
  fileParallelism: true,
  minWorkers: 1,
  maxWorkers: '50%',
} satisfies UserConfig['test'];

export const serialSrcRunnerConfig = {
  testTimeout: 60_000,
  pool: 'threads',
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
} satisfies UserConfig['test'];
