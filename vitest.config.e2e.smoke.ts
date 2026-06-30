import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    include: [
      'e2e/specs/direct-task.e2e.ts',
      'e2e/specs/add.e2e.ts',
      'e2e/specs/list-non-interactive.e2e.ts',
      'e2e/specs/cli-help.e2e.ts',
      'e2e/specs/provider-error.e2e.ts',
      'e2e/specs/workflow-error-handling.e2e.ts',
    ],
  },
});
