/**
 * Workflow configuration loader — re-export hub.
 *
 * Implementations have been split into:
 * - workflowParser.ts: YAML parsing, step/rule normalization
 * - workflowResolver.ts: 3-layer resolution (builtin → user → project-local)
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
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
  listBuiltinWorkflowNames,
  listWorkflows,
  listWorkflowEntries,
  type StepPreview,
  type FirstStepInfo,
  type WorkflowDirEntry,
  type WorkflowSource,
  type WorkflowWithSource,
} from './workflowResolver.js';
