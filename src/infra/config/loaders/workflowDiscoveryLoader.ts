import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowDirEntry, WorkflowDiscoveryConfig } from './workflowDiscovery.js';

interface WorkflowDiscoveryLoaderDeps {
  loadWorkflowForDiscovery: (entry: WorkflowDirEntry, cwd: string) => WorkflowConfig;
  validateWorkflowCallContracts: (
    workflow: WorkflowConfig,
    projectCwd: string,
    options?: { allowPathBasedCalls?: boolean; lookupCwd?: string },
  ) => void;
}

export function buildWorkflowDiscoveryConfig(workflow: WorkflowConfig): WorkflowDiscoveryConfig {
  return {
    name: workflow.name,
    description: workflow.description,
    subworkflow: workflow.subworkflow,
  };
}

export function loadValidatedWorkflowDiscoveryEntry(
  entry: WorkflowDirEntry,
  cwd: string,
  deps: WorkflowDiscoveryLoaderDeps,
): WorkflowDiscoveryConfig {
  const workflow = deps.loadWorkflowForDiscovery(entry, cwd);
  deps.validateWorkflowCallContracts(workflow, cwd, {
    lookupCwd: cwd,
    allowPathBasedCalls: false,
  });
  return buildWorkflowDiscoveryConfig(workflow);
}
