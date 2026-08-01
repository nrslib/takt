import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import type { FindingLedgerStore } from '../../core/workflow/findings/store.js';
import {
  FindingStorageResolver,
  ROOT_FINDING_AUTHORITY_KEY,
} from '../../infra/finding-storage/index.js';
import { registerTestFindingStorage } from './finding-storage-cleanup.js';

export { cleanupTestFindingStorage } from './finding-storage-cleanup.js';

export function createTestFindingLedgerStore(input: {
  readonly projectCwd: string;
  readonly runId: string;
  readonly reportDir: string;
  readonly workflowName: string;
  readonly authorityKey?: string;
  readonly sourceRunId?: string;
}): FindingLedgerStore {
  const runPaths = buildRunPaths(input.projectCwd, input.runId);
  const resolver = new FindingStorageResolver({
    databasePath: runPaths.findingContractDatabaseAbs,
    runId: input.runId,
    ...(input.sourceRunId === undefined
      ? {}
      : {
          source: {
            databasePath: buildRunPaths(
              input.projectCwd,
              input.sourceRunId,
            ).findingContractDatabaseAbs,
            runId: input.sourceRunId,
          },
        }),
  });
  registerTestFindingStorage(resolver);
  return resolver.resolveAuthority({
    authorityKey: input.authorityKey ?? ROOT_FINDING_AUTHORITY_KEY,
    workflowName: input.workflowName,
    reportDir: input.reportDir,
  });
}
