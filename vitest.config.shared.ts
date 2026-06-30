import type { UserConfig } from 'vitest/config';

export const srcTestInclude = ['src/__tests__/**/*.test.ts'];

export const itTestGlobs = [
  'src/__tests__/it-*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*.regression.test.ts',
  'src/__tests__/**/*.performance.test.ts',
];

// These files create real repositories and mutate branches/commits. Keep them
// serial to avoid IO-heavy git operations competing inside the same pool.
export const itSerialGitTestGlobs = [
  'src/__tests__/branchList.regression.test.ts',
  'src/__tests__/it-completed-task-root-branch.test.ts',
  'src/__tests__/it-dotgitignore.test.ts',
  'src/__tests__/it-stage-and-commit.test.ts',
  'src/__tests__/it-worktree-delete.test.ts',
];

// These files repeatedly load the full builtin workflow catalog. Keep the file
// internals serial, but run this group beside the git group.
export const itSerialWorkflowLoaderTestGlobs = [
  'src/__tests__/it-workflow-loader.test.ts',
  'src/__tests__/it-workflow-loader-canonical.test.ts',
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
  maxWorkers: process.env.CI ? '50%' : '75%',
} satisfies UserConfig['test'];

export const serialSrcRunnerConfig = {
  pool: 'threads',
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
} satisfies UserConfig['test'];
