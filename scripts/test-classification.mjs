export const parallelIntegrationTestGlobs = Object.freeze([
  'src/__tests__/it-*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*.regression.test.ts',
  'src/__tests__/**/*.performance.test.ts',
]);

// These unit tests run full workflow engines, create repositories, or spawn
// child processes. Under the four-shard unit gate they have repeatedly
// exceeded the per-test ceiling or starved vitest's worker RPC. Keep them out
// of the routine gate and run them with the dedicated single-worker runner.
export const heavyUnitTestFiles = Object.freeze([
  'src/__tests__/codex-isolated-executor.test.ts',
  'src/__tests__/finding-review-integrity-gate.test.ts',
  'src/__tests__/team-leader-finding-contract-runner.test.ts',
  'src/__tests__/workflow-step-fragment-builtin-runtime.test.ts',
  'src/__tests__/workflow-step-fragment-runtime.test.ts',
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
