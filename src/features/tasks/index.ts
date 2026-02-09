/**
 * Task feature exports
 */

export { executePiece, type PieceExecutionResult, type PieceExecutionOptions } from './execute/pieceExecution.js';
export { executeTask, runAllTasks, type TaskExecutionOptions } from './execute/taskExecution.js';
export { executeAndCompleteTask, resolveTaskExecution } from './execute/taskExecution.js';
export { withPersonaSession } from './execute/session.js';
export type { PipelineExecutionOptions } from './execute/types.js';
export {
  selectAndExecuteTask,
  confirmAndCreateWorktree,
  determinePiece,
  type SelectAndExecuteOptions,
  type WorktreeConfirmationResult,
} from './execute/selectAndExecute.js';
export { addTask, saveTaskFile, saveTaskFromInteractive, createIssueFromTask, createIssueAndSaveTask } from './add/index.js';
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
