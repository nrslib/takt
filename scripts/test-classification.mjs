export const parallelIntegrationTestGlobs = Object.freeze([
  'src/__tests__/it-*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*.regression.test.ts',
  'src/__tests__/**/*.performance.test.ts',
]);

// Escape hatch for tests that must not run concurrently with the rest of the
// IT slice. A 2026-08 audit found zero files with shared mutable state (all
// use mkdtemp isolation under pool:'forks'), so membership is not about
// correctness. The files below are fsync/spawnSync storms: their IO
// serializes at the device level, so running them in the parallel pool only
// adds contention and can block a worker synchronously past the 60s vitest
// RPC timeout (spurious "Timeout calling onTaskUpdate" unhandled errors).
// Add a file here only with a measured interference reason.
export const serialGitTestFiles = Object.freeze([
  'src/__tests__/finding-conflict-adjudication-engine.integration.test.ts',
  'src/__tests__/finding-conflict-adjudication-runner.integration.test.ts',
  'src/__tests__/finding-evidence-protocol.integration.test.ts',
  'src/__tests__/finding-ladder-robustness.integration.test.ts',
  'src/__tests__/finding-manager-filesystem.integration.test.ts',
  'src/__tests__/it-operation-journal-store.test.ts',
  // Spawns full runAllTasks engine runs (real child processes); on 2-core CI
  // runners it blocked a parallel worker past the 60s RPC deadline in two
  // consecutive runs (2026-08-04), failing the it job with "Timeout calling
  // onTaskUpdate" despite all tests passing.
  'src/__tests__/it-runAllTasks-auto-requeue.test.ts',
  'src/__tests__/workflow-engine-structured-caller.integration.test.ts',
]);

export const serialWorkflowTestFiles = Object.freeze([]);
