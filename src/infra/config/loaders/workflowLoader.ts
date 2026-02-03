/**
 * Workflow configuration loader — re-export hub.
 *
 * Implementations have been split into:
 * - workflowParser.ts: YAML parsing, step/rule normalization
 * - workflowResolver.ts: 3-layer resolution (builtin → user → project-local)
 */

// Parser exports
export { normalizeWorkflowConfig, loadWorkflowFromFile } from './workflowParser.js';

// Resolver exports (public API)
export {
  getBuiltinWorkflow,
  loadWorkflow,
  isWorkflowPath,
  loadWorkflowByIdentifier,
  getWorkflowDescription,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
  listWorkflows,
  listWorkflowEntries,
  type WorkflowDirEntry,
  type WorkflowSource,
  type WorkflowWithSource,
} from './workflowResolver.js';
