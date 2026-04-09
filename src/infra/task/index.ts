/**
 * Task execution module
 */

// Types
export type {
  TaskInfo,
  TaskResult,
  WorktreeOptions,
  WorktreeResult,
  BranchInfo,
  BranchListItem,
  SummarizeOptions,
  TaskListItem,
} from './types.js';

// Classes
export { CloneManager } from './clone.js';
export { AutoCommitter } from './autoCommit.js';
export { TaskSummarizer } from './summarize.js';
export { BranchManager } from './branchList.js';

export { TaskRunner } from './runner.js';

export { showTaskList } from './display.js';
export {
  serializeTaskListItemForJson,
  type JsonTaskData,
  type JsonTaskFailure,
  type JsonTaskListItem,
} from './listSerializer.js';

export {
  TaskFileSchema,
  type TaskFileData,
  TaskExecutionConfigSchema,
  TaskStatusSchema,
  type TaskStatus,
  TaskFailureSchema,
  type TaskFailure,
  TaskRecordSchema,
  type TaskRecord,
  TasksFileSchema,
  type TasksFileData,
  resolveTaskWorkflowValue,
  resolveTaskStartStepValue,
} from './schema.js';
export {
  createSharedClone,
  createSharedCloneAbortable,
  removeClone,
  createTempCloneForBranch,
  saveCloneMeta,
  removeCloneMeta,
  cleanupOrphanedClone,
  resolveBaseBranch,
  resolveCloneBaseDir,
  branchExists,
} from './clone.js';
export {
  detectDefaultBranch,
  listTaktBranches,
  parseTaktBranches,
  getFilesChanged,
  extractTaskSlug,
  getOriginalInstruction,
  buildListItems,
} from './branchList.js';
export { stageAndCommit, getCurrentBranch, pushBranch, checkoutBranch, relayPushCloneToOrigin } from './git.js';
export { buildTaskInstruction } from './instruction.js';
export { autoCommitAndPush, type AutoCommitResult } from './autoCommit.js';
export { summarizeTaskName } from './summarize.js';
export { TaskWatcher, type TaskWatcherOptions } from './watcher.js';
export { isStaleRunningTask } from './process.js';
