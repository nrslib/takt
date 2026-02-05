import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'e2e/specs/add-and-run.e2e.ts',
      'e2e/specs/worktree.e2e.ts',
      'e2e/specs/pipeline.e2e.ts',
      'e2e/specs/github-issue.e2e.ts',
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
