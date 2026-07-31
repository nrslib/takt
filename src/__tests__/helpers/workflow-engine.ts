import type { WorkflowConfig } from '../../core/models/index.js';
import { WorkflowEngine as WorkflowEngineImpl } from '../../core/workflow/index.js';
import type { WorkflowEngineOptions } from '../../core/workflow/types.js';
import { createFindingLedgerStore } from '../../core/workflow/findings/store.js';

export class WorkflowEngine extends WorkflowEngineImpl {
  constructor(
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) {
    const findingAuthorityResolver = options.inheritedFindingContract === undefined
      && options.findingAuthorityResolver === undefined
      ? {
          resolve: ({ workflowConfig, runPaths }) => {
            const contract = workflowConfig.findingContract;
            if (contract === undefined) {
              throw new Error('Test Finding authority requires a Finding Contract');
            }
            return createFindingLedgerStore({
              projectCwd: options.projectCwd,
              runId: runPaths.slug,
              reportDir: runPaths.reportsAbs,
              workflowName: workflowConfig.name,
              ledgerPath: contract.ledgerPath,
              rawFindingsPath: contract.rawFindingsPath,
              ...(options.resumeSource?.sourceRunSlug === undefined
                ? {}
                : { trustedResumeSourceRunId: options.resumeSource.sourceRunSlug }),
            });
          },
        }
      : options.findingAuthorityResolver;
    super(config, cwd, task, {
      ...options,
      ...(findingAuthorityResolver === undefined
        ? {}
        : { findingAuthorityResolver }),
    });
  }
}
