import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowEngineOptions } from '../../../core/workflow/types.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/index.js';
import { getWorkflowSourcePath } from '../../../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../../../infra/config/loaders/workflowTrustSource.js';

export function createWorkflowExecutionContext(workflowConfig: WorkflowConfig, projectCwd: string) {
  return {
    sourcePath: getWorkflowSourcePath(workflowConfig),
    trustInfo: getWorkflowTrustInfo(workflowConfig, projectCwd),
  };
}

export function createWorkflowCallResolver(
  workflowContext: ReturnType<typeof createWorkflowExecutionContext>,
): WorkflowEngineOptions['workflowCallResolver'] {
  return ({
    parentWorkflow,
    identifier,
    stepName,
    projectCwd,
    lookupCwd,
  }) => resolveWorkflowCallTarget(
    parentWorkflow,
    identifier,
    stepName,
    projectCwd,
    lookupCwd,
    workflowContext,
  );
}
