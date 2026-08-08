export const parallelIntegrationTestGlobs = Object.freeze([
  'src/__tests__/it-*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*-integration.test.ts',
  'src/__tests__/**/*.regression.test.ts',
  'src/__tests__/**/*.performance.test.ts',
]);

// Legacy filenames do not always carry an integration suffix. Keep explicit
// membership here for tests that run complete workflow engines, team leaders,
// real child processes, or real Git boundaries.
export const parallelIntegrationTestFiles = Object.freeze([
  'src/__tests__/acp-entrypoint.test.ts',
  'src/__tests__/builtin-review-remediation-transitions.test.ts',
  'src/__tests__/dependency-versions.test.ts',
  'src/__tests__/e2e-helpers.test.ts',
  'src/__tests__/engine-abort.test.ts',
  'src/__tests__/engine-agent-overrides.test.ts',
  'src/__tests__/engine-arpeggio.test.ts',
  'src/__tests__/engine-auto-routing.test.ts',
  'src/__tests__/engine-blocked.test.ts',
  'src/__tests__/engine-capabilities-provider-options.test.ts',
  'src/__tests__/engine-error.test.ts',
  'src/__tests__/engine-happy-path.test.ts',
  'src/__tests__/engine-loop-monitors.test.ts',
  'src/__tests__/engine-parallel-failure.test.ts',
  'src/__tests__/engine-parallel.test.ts',
  'src/__tests__/engine-persona-providers.test.ts',
  'src/__tests__/engine-provider-options.test.ts',
  'src/__tests__/engine-rate-limit-fallback.test.ts',
  'src/__tests__/engine-report-inheritance.test.ts',
  'src/__tests__/engine-team-leader.test.ts',
  'src/__tests__/engine-workflow-call-iteration.test.ts',
  'src/__tests__/engine-workflow-call-parallel.test.ts',
  'src/__tests__/engine-workflow-call-resolution.test.ts',
  'src/__tests__/engine-workflow-call-runner.test.ts',
  'src/__tests__/engine-workflow-call.test.ts',
  'src/__tests__/engine-worktree-report.test.ts',
  'src/__tests__/exceeded-requeue.test.ts',
  'src/__tests__/finding-convergence.test.ts',
  'src/__tests__/finding-evidence-protocol-fixture.test.ts',
  'src/__tests__/finding-fixpoint.test.ts',
  'src/__tests__/finding-inherited-source-parser.test.ts',
  'src/__tests__/finding-lifecycle-mutation.test.ts',
  'src/__tests__/finding-review-observability-wiring.test.ts',
  'src/__tests__/finding-review-scope-snapshot-admission.test.ts',
  'src/__tests__/finding-review-scope-snapshot-wiring.test.ts',
  'src/__tests__/finding-reviewer-anomaly-settlement.test.ts',
  'src/__tests__/finding-storage.test.ts',
  'src/__tests__/finding-terminal-adjudication-runner.test.ts',
  'src/__tests__/managed-spawn.test.ts',
  'src/__tests__/nix-flake-contract.test.ts',
  'src/__tests__/package-public-boundary.test.ts',
  'src/__tests__/promptEvalProbeLifecycle.test.ts',
  'src/__tests__/releaseVerificationWiring.test.ts',
  'src/__tests__/report-phase-blocked.test.ts',
  'src/__tests__/runAllTasks-concurrency.test.ts',
  'src/__tests__/selector-input-reader.test.ts',
  'src/__tests__/step-executor.test.ts',
  'src/__tests__/task-review-scope.test.ts',
  'src/__tests__/team-leader-finding-contract-orphan-resume.test.ts',
  'src/__tests__/team-leader-runner-structured-caller.test.ts',
  'src/__tests__/token-usage-csv.test.ts',
  'src/__tests__/windows-executable-shadowing.test.ts',
  'src/__tests__/workflow-call-abort-resume.test.ts',
  'src/__tests__/workflow-call-lifecycle.test.ts',
  'src/__tests__/workflow-engine-finding-store-injection.test.ts',
  'src/__tests__/workflow-engine-single-iteration-span.test.ts',
  'src/__tests__/workflow-promotion-engine.test.ts',
  'src/__tests__/workflow-step-fragment-contracts.test.ts',
  'src/__tests__/workflow-step-fragment-provenance.test.ts',
  'src/__tests__/workflow-step-fragment-provider-provenance.test.ts',
  'src/__tests__/workflow-step-fragments.test.ts',
  'src/__tests__/workflowEngine-restart.test.ts',
  'src/__tests__/workflowExecution-claude-terminal.test.ts',
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

// These integration tests are resource-intensive enough to starve Vitest's
// worker RPC when they share a pool. Keep them in the IT gate, but run them
// with the single-worker workflow runner.
export const serialWorkflowTestFiles = Object.freeze([
  'src/__tests__/codex-isolated-executor.test.ts',
  'src/__tests__/finding-review-integrity-gate.test.ts',
  'src/__tests__/team-leader-finding-contract-runner.test.ts',
  'src/__tests__/workflow-step-fragment-builtin-runtime.test.ts',
  'src/__tests__/workflow-step-fragment-runtime.test.ts',
]);
