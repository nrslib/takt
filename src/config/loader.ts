/**
 * Configuration loader for takt
 *
 * Re-exports from specialized loaders for backward compatibility.
 */

// Workflow loading
export {
  getBuiltinWorkflow,
  loadWorkflowFromFile,
  loadWorkflowFromPath,
  loadWorkflow,
  loadAllWorkflows,
  listWorkflows,
} from './workflowLoader.js';

// Agent loading
export {
  loadAgentsFromDir,
  loadCustomAgents,
  listCustomAgents,
  loadAgentPrompt,
  loadAgentPromptFromPath,
} from './agentLoader.js';

// Global configuration
export {
  loadGlobalConfig,
  saveGlobalConfig,
  addTrustedDirectory,
  isDirectoryTrusted,
  loadProjectDebugConfig,
  getEffectiveDebugConfig,
} from './globalConfig.js';
