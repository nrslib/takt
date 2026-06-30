export const mockE2eSpecs = [
  'e2e/specs/direct-task.e2e.ts',
  'e2e/specs/exec.e2e.ts',
  'e2e/specs/pipeline-skip-git.e2e.ts',
  'e2e/specs/pipeline-local-repo.e2e.ts',
  'e2e/specs/report-judge.e2e.ts',
  'e2e/specs/observability.e2e.ts',
  'e2e/specs/report-file-output.e2e.ts',
  'e2e/specs/team-leader-worker-pool.e2e.ts',
  'e2e/specs/add.e2e.ts',
  'e2e/specs/watch.e2e.ts',
  'e2e/specs/list-non-interactive.e2e.ts',
  'e2e/specs/multi-step-parallel.e2e.ts',
  'e2e/specs/multi-step-sequential.e2e.ts',
  'e2e/specs/run-sigint-graceful.e2e.ts',
  'e2e/specs/run-sigint-ai-wait.e2e.ts',
  'e2e/specs/workflow-error-handling.e2e.ts',
  'e2e/specs/cycle-detection.e2e.ts',
  'e2e/specs/run-multiple-tasks.e2e.ts',
  'e2e/specs/task-status-persistence.e2e.ts',
  'e2e/specs/run-recovery.e2e.ts',
  'e2e/specs/session-log.e2e.ts',
  'e2e/specs/model-override.e2e.ts',
  'e2e/specs/provider-override.e2e.ts',
  'e2e/specs/provider-error.e2e.ts',
  'e2e/specs/error-handling.e2e.ts',
  'e2e/specs/cli-catalog.e2e.ts',
  'e2e/specs/cli-prompt.e2e.ts',
  'e2e/specs/cli-help.e2e.ts',
  'e2e/specs/cli-workflow-authoring.e2e.ts',
  'e2e/specs/cli-clear.e2e.ts',
  'e2e/specs/cli-reset-categories.e2e.ts',
  'e2e/specs/cli-export-cc.e2e.ts',
  'e2e/specs/eject.e2e.ts',
  'e2e/specs/quiet-mode.e2e.ts',
  'e2e/specs/task-content-file.e2e.ts',
  'e2e/specs/config-priority.e2e.ts',
  'e2e/specs/repertoire.e2e.ts',
  'e2e/specs/repertoire-real.e2e.ts',
  'e2e/specs/workflow-selection-branches.e2e.ts',
  'e2e/specs/clone-branch-resolution.e2e.ts',
];

export const mockE2eShards = [
  [
    'e2e/specs/list-non-interactive.e2e.ts',
    'e2e/specs/clone-branch-resolution.e2e.ts',
    'e2e/specs/workflow-selection-branches.e2e.ts',
    'e2e/specs/pipeline-local-repo.e2e.ts',
    'e2e/specs/pipeline-skip-git.e2e.ts',
    'e2e/specs/direct-task.e2e.ts',
    'e2e/specs/add.e2e.ts',
    'e2e/specs/cli-help.e2e.ts',
  ],
  [
    'e2e/specs/exec.e2e.ts',
    'e2e/specs/watch.e2e.ts',
    'e2e/specs/run-multiple-tasks.e2e.ts',
    'e2e/specs/run-recovery.e2e.ts',
    'e2e/specs/run-sigint-graceful.e2e.ts',
    'e2e/specs/run-sigint-ai-wait.e2e.ts',
    'e2e/specs/task-status-persistence.e2e.ts',
    'e2e/specs/session-log.e2e.ts',
    'e2e/specs/cycle-detection.e2e.ts',
    'e2e/specs/workflow-error-handling.e2e.ts',
  ],
  [
    'e2e/specs/cli-catalog.e2e.ts',
    'e2e/specs/cli-prompt.e2e.ts',
    'e2e/specs/cli-workflow-authoring.e2e.ts',
    'e2e/specs/cli-clear.e2e.ts',
    'e2e/specs/cli-reset-categories.e2e.ts',
    'e2e/specs/cli-export-cc.e2e.ts',
    'e2e/specs/eject.e2e.ts',
    'e2e/specs/quiet-mode.e2e.ts',
    'e2e/specs/task-content-file.e2e.ts',
    'e2e/specs/config-priority.e2e.ts',
  ],
  [
    'e2e/specs/report-judge.e2e.ts',
    'e2e/specs/observability.e2e.ts',
    'e2e/specs/report-file-output.e2e.ts',
    'e2e/specs/team-leader-worker-pool.e2e.ts',
    'e2e/specs/multi-step-parallel.e2e.ts',
    'e2e/specs/multi-step-sequential.e2e.ts',
    'e2e/specs/model-override.e2e.ts',
    'e2e/specs/provider-override.e2e.ts',
    'e2e/specs/provider-error.e2e.ts',
    'e2e/specs/error-handling.e2e.ts',
    'e2e/specs/repertoire.e2e.ts',
    'e2e/specs/repertoire-real.e2e.ts',
  ],
];

function assertMockE2eShardsCoverSpecs() {
  const shardSpecs = mockE2eShards.flat();
  const uniqueShardSpecs = new Set(shardSpecs);
  const missingSpecs = mockE2eSpecs.filter((spec) => !uniqueShardSpecs.has(spec));
  const extraSpecs = shardSpecs.filter((spec) => !mockE2eSpecs.includes(spec));
  const duplicateSpecs = shardSpecs.filter((spec, index) => shardSpecs.indexOf(spec) !== index);

  if (
    shardSpecs.length !== mockE2eSpecs.length ||
    missingSpecs.length > 0 ||
    extraSpecs.length > 0 ||
    duplicateSpecs.length > 0
  ) {
    throw new Error(
      [
        'mockE2eShards must contain each mockE2eSpecs entry exactly once.',
        missingSpecs.length > 0 ? `missing=${missingSpecs.join(', ')}` : '',
        extraSpecs.length > 0 ? `extra=${extraSpecs.join(', ')}` : '',
        duplicateSpecs.length > 0 ? `duplicate=${duplicateSpecs.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
  }
}

assertMockE2eShardsCoverSpecs();
