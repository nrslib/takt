/**
 * Task feature exports
 */

export { executeWorkflow, type WorkflowExecutionResult, type WorkflowExecutionOptions } from './execute/workflowExecution.js';
export { executeTask, runAllTasks, type TaskExecutionOptions } from './execute/taskExecution.js';
export { executeAndCompleteTask, resolveTaskExecution } from './execute/taskExecution.js';
export { withAgentSession } from './execute/session.js';
export type { PipelineExecutionOptions } from './execute/types.js';
export {
  selectAndExecuteTask,
  confirmAndCreateWorktree,
  determineWorkflow,
  type SelectAndExecuteOptions,
  type WorktreeConfirmationResult,
} from './execute/selectAndExecute.js';
export { addTask, summarizeConversation } from './add/index.js';
export { watchTasks } from './watch/index.js';
export {
  listTasks,
  type ListAction,
  isBranchMerged,
  showFullDiff,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
  instructBranch,
} from './list/index.js';
