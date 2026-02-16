import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    include: [
      'e2e/specs/add-and-run.e2e.ts',
      'e2e/specs/worktree.e2e.ts',
      'e2e/specs/pipeline.e2e.ts',
      'e2e/specs/github-issue.e2e.ts',
      'e2e/specs/structured-output.e2e.ts',
    ],
  },
});
