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

// Windows runners spawn processes and touch the filesystem an order of
// magnitude slower than the Linux/macOS ones, so tests that pass everywhere
// else hit the shared 15s ceiling there. Three of the four windows job
// failures in the last 100 CI runs were "Test timed out in 15000ms".
const testTimeout = process.platform === 'win32' ? 60_000 : 15_000;

export const commonSrcTestConfig = {
  env: {
    TAKT_CONFIG_DIR: '',
    TAKT_NOTIFY_WEBHOOK: '',
  },
  // Local runs execute 4 unit shards plus fork workers and spawnSync-heavy
  // tests on one machine. A worker whose event loop is starved past 60s trips
  // birpc's fixed RPC timeout and vitest surfaces it as an unhandled error
  // ("Timeout calling onTaskUpdate") even though every test passed. Keep
  // unhandled errors fatal on CI (one shard per runner, no such contention)
  // and ignore them locally where they are reproducibly spurious.
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
  testTimeout: 60_000,
  passWithNoTests: true,
  pool: 'threads',
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
} satisfies UserConfig['test'];
