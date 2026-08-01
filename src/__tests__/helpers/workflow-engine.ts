import type { WorkflowConfig } from '../../core/models/index.js';
import { WorkflowEngine as WorkflowEngineImpl } from '../../core/workflow/index.js';
import type { WorkflowEngineOptions } from '../../core/workflow/types.js';
import { createTestFindingLedgerStore } from './finding-storage.js';

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
          resolve: ({ workflowConfig, runPaths, runPathNamespace, workflowCallSiteIdentity }) => {
            const contract = workflowConfig.findingContract;
            if (contract === undefined) {
              throw new Error('Test Finding authority requires a Finding Contract');
            }
            const authorityKey = runPathNamespace.length === 0
              ? 'root'
              : workflowCallSiteIdentity;
            if (authorityKey === undefined) {
              throw new Error(
                'Child Finding authority requires a workflow call-site identity',
              );
            }
            return createTestFindingLedgerStore({
              projectCwd: options.projectCwd,
              runId: runPaths.slug,
              reportDir: runPaths.reportsAbs,
              workflowName: workflowConfig.name,
              authorityKey,
              ...(options.resumeSource?.sourceRunSlug === undefined
                ? {}
                : { sourceRunId: options.resumeSource.sourceRunSlug }),
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
