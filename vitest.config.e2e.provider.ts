import { defineConfig } from 'vitest/config';
import { e2eBaseTestConfig } from './vitest.config.e2e.base';

const provider = process.env.TAKT_E2E_PROVIDER;
if (!provider) {
  throw new Error('TAKT_E2E_PROVIDER must be set');
}

const commonTests = [
  'e2e/specs/add-and-run.e2e.ts',
  'e2e/specs/worktree.e2e.ts',
  'e2e/specs/pipeline.e2e.ts',
  'e2e/specs/task-auto-pr.e2e.ts',
  'e2e/specs/github-issue.e2e.ts',
  'e2e/specs/structured-output.e2e.ts',
  'e2e/specs/team-leader.e2e.ts',
  'e2e/specs/team-leader-refill-threshold.e2e.ts',
];

const providerSpecificTests: Record<string, string[]> = {
  codex: ['e2e/specs/codex-permission-mode.e2e.ts'],
  opencode: ['e2e/specs/opencode-conversation.e2e.ts'],
};

export default defineConfig({
  test: {
    ...e2eBaseTestConfig,
    include: [
      ...commonTests,
      ...(providerSpecificTests[provider] ?? []),
    ],
  },
});
