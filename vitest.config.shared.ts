import type { UserConfig } from 'vitest/config';
import {
  heavyParallelIntegrationTestFiles,
  lightIntegrationTestFiles,
  parallelIntegrationTestFiles,
  parallelIntegrationTestGlobs,
  serialGitTestFiles,
  serialWorkflowTestFiles,
} from './scripts/test-classification.mjs';

export const srcTestInclude = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.test.tsx',
];

export const itTestGlobs = [
  ...parallelIntegrationTestGlobs,
  ...parallelIntegrationTestFiles,
];

export const lightItTestGlobs = [
  ...lightIntegrationTestFiles,
];

export const heavyParallelItTestGlobs = [
  ...parallelIntegrationTestGlobs,
  ...heavyParallelIntegrationTestFiles,
];

export const heavyParallelItTestExcludes = [
  ...lightIntegrationTestFiles,
  ...serialGitTestFiles,
  ...serialWorkflowTestFiles,
];

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

// Some workflow tests spawn processes and perform fsync-heavy persistence.
// Keep one sufficiently large ceiling for every platform and runner.
const testTimeout = 120_000;

export const commonSrcTestConfig = {
  env: {
    TAKT_CONFIG_DIR: '',
    TAKT_NOTIFY_WEBHOOK: '',
  },
  // Local runs execute an adaptive unit-shard wave plus fork workers and
  // spawnSync-heavy tests on one machine. A worker whose event loop is starved
  // past 60s trips birpc's fixed RPC timeout and vitest surfaces it as an
  // unhandled error ("Timeout calling onTaskUpdate") even though every test
  // passed. Keep unhandled errors fatal when CI is set. The blocking
  // pull-request matrix keeps one shard per runner; the on-demand /ci comment
  // workflow is a documented single-runner exception and opts into one strict
  // wrapper re-measurement without changing Vitest's CI-fatal handling.
  dangerouslyIgnoreUnhandledErrors: !process.env.CI,
  environment: 'node',
  globals: false,
  reporters: ['dot'],
  setupFiles: ['src/__tests__/test-setup.ts'],
  testTimeout,
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
  testTimeout: 120_000,
  passWithNoTests: true,
  pool: 'threads',
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
} satisfies UserConfig['test'];
