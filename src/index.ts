/**
 * TAKT - TAKT Agent Koordination Topology
 *
 * This module exports the public API for programmatic usage.
 */

// Models
export type {
  Status,
  WorkflowRule,
  WorkflowStep,
  WorkflowConfig,
  WorkflowState,
  Language,
  PartDefinition,
  PartResult,
} from './core/models/types.js';

// Configuration
export {
  loadWorkflow,
  loadWorkflowByIdentifier,
  listWorkflows,
  loadAllWorkflowDiscovery,
  loadAllWorkflowDiscoveryWithSources,
  loadAllWorkflows,
  loadAllWorkflowsWithSources,
  getWorkflowDescription,
  getBuiltinWorkflow,
  isWorkflowPath,
} from './infra/config/loaders/index.js';
export type {
  WorkflowDiscoveryConfig as WorkflowDiscoveryConfig,
  WorkflowDiscoveryWithSource as WorkflowDiscoveryWithSource,
  WorkflowSource as WorkflowSource,
  WorkflowWithSource as WorkflowWithSource,
} from './infra/config/loaders/workflowLoader.js';
export {
  saveProjectConfig,
  updateProjectConfig,
  isVerboseMode,
  type ProjectLocalConfig,
} from './infra/config/project/index.js';

// Workflow engine
export {
  WorkflowEngine,
  isOutputContractItem,
} from './core/workflow/index.js';
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
  ProviderType,
} from './core/workflow/index.js';

// Agent usecases
export {
  executeAgent,
  generateReport,
  executePart,
  judgeStatus,
  evaluateCondition,
  decomposeTask,
} from './agents/agent-usecases.js';
export type { JudgeStatusResult } from './agents/agent-usecases.js';
