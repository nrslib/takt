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
