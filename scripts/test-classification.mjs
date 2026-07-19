export const parallelIntegrationTestGlobs = Object.freeze([
  'src/__tests__/it-*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*.regression.test.ts',
  'src/__tests__/**/*.performance.test.ts',
]);

export const serialGitTestFiles = Object.freeze([
  'src/__tests__/branchList.regression.test.ts',
  'src/__tests__/finding-evidence-protocol.integration.test.ts',
  'src/__tests__/finding-conflict-adjudication-runner.test.ts',
  'src/__tests__/finding-manager-filesystem.integration.test.ts',
  'src/__tests__/finding-ladder-robustness.test.ts',
  'src/__tests__/it-completed-task-root-branch.test.ts',
  'src/__tests__/it-dotgitignore.test.ts',
  'src/__tests__/it-stage-and-commit.test.ts',
  'src/__tests__/it-worktree-delete.test.ts',
]);

export const serialWorkflowTestFiles = Object.freeze([
  'src/__tests__/config.test.ts',
  'src/__tests__/engine-workflow-call.test.ts',
  'src/__tests__/finding-conflict-adjudication-engine.test.ts',
  'src/__tests__/finding-manager-mechanical-runner.test.ts',
  'src/__tests__/finding-stop-budget.test.ts',
  'src/__tests__/it-workflow-loader.test.ts',
  'src/__tests__/it-workflow-loader-canonical.test.ts',
  'src/__tests__/workflow-categories.test.ts',
  'src/__tests__/workflowDiscovery.test.ts',
  'src/__tests__/workflow-engine-structured-caller.test.ts',
  'src/__tests__/workflowLoader.test.ts',
]);
