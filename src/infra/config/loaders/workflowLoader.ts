/**
 * Workflow configuration loader — re-export hub.
 *
 * Implementations have been split into:
 * - workflowParser.ts: YAML parsing, step/rule normalization
 * - workflowResolver.ts: 3-layer resolution (project-local → user → builtin)
 */

// Parser exports
export { normalizeWorkflowConfig } from './workflowParser.js';
export { loadWorkflowFromFile } from './workflowFileLoader.js';

// Resolver exports (public API)
export {
  getBuiltinWorkflow,
  loadWorkflow,
  loadWorkflowByIdentifier,
  isWorkflowPath,
  getWorkflowDescription,
  loadAllWorkflowDiscovery,
  loadAllWorkflowDiscoveryWithSources,
  loadAllStandaloneWorkflows,
  loadAllStandaloneWorkflowsWithSources,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
  listBuiltinWorkflowNames,
  listStandaloneWorkflowEntries,
  listWorkflows,
  listWorkflowEntries,
  type WorkflowDiscoveryConfig,
  type WorkflowDiscoveryWithSource,
  type StepPreview,
  type FirstStepInfo,
  type WorkflowDirEntry,
  type WorkflowSource,
  type WorkflowWithSource,
} from './workflowResolver.js';
export { resolveWorkflowCallTarget } from './workflowCallResolver.js';
