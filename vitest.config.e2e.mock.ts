import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'e2e/specs/direct-task.e2e.ts',
      'e2e/specs/pipeline-skip-git.e2e.ts',
      'e2e/specs/report-judge.e2e.ts',
      'e2e/specs/add.e2e.ts',
      'e2e/specs/watch.e2e.ts',
      'e2e/specs/list-non-interactive.e2e.ts',
      'e2e/specs/multi-step-parallel.e2e.ts',
      'e2e/specs/run-sigint-graceful.e2e.ts',
      'e2e/specs/piece-error-handling.e2e.ts',
      'e2e/specs/run-multiple-tasks.e2e.ts',
      'e2e/specs/provider-error.e2e.ts',
      'e2e/specs/error-handling.e2e.ts',
      'e2e/specs/cli-catalog.e2e.ts',
      'e2e/specs/cli-prompt.e2e.ts',
      'e2e/specs/cli-switch.e2e.ts',
      'e2e/specs/cli-help.e2e.ts',
      'e2e/specs/cli-clear.e2e.ts',
      'e2e/specs/cli-config.e2e.ts',
      'e2e/specs/cli-reset-categories.e2e.ts',
      'e2e/specs/cli-export-cc.e2e.ts',
      'e2e/specs/quiet-mode.e2e.ts',
      'e2e/specs/task-content-file.e2e.ts',
    ],
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
