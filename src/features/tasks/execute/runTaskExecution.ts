import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import type { GitProvider } from '../../../infra/git/index.js';
import {
  executeTaskAndCompleteWithDetails,
  executeTaskWithResult,
  type TaskCompletionResult,
} from './taskExecution.js';
import { runWorkflowExecution } from './workflowExecutionApi.js';
import type {
  ExecuteTaskOptions,
  TaskExecutionContextOverride,
  TaskExecutionOptions,
  TaskExecutionParallelOptions,
  WorkflowExecutionResult,
} from './types.js';

export type { TaskCompletionResult } from './taskExecution.js';

export interface RunTaskExecutionContext {
  ignoreIterationLimit?: boolean;
  taskContext?: TaskExecutionContextOverride;
  gitProvider?: GitProvider;
}

async function executeTaskWithRunResult(
  options: ExecuteTaskOptions,
  runContext?: RunTaskExecutionContext,
): Promise<WorkflowExecutionResult> {
  return runWorkflowExecution(options, runContext);
}

export async function executeRunTaskAndComplete(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
  runContext?: RunTaskExecutionContext,
): Promise<boolean> {
  const result = await executeRunTaskAndCompleteWithDetails(
    task,
    taskRunner,
    cwd,
    taskExecutionOptions,
    parallelOptions,
    runContext,
  );
  return result.success;
}

export async function executeRunTaskAndCompleteWithDetails(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
  runContext?: RunTaskExecutionContext,
): Promise<TaskCompletionResult> {
  const taskExecutor = runContext === undefined
    ? executeTaskWithResult
    : (options: ExecuteTaskOptions) => executeTaskWithRunResult(options, runContext);
  return executeTaskAndCompleteWithDetails(
    task,
    taskRunner,
    cwd,
    taskExecutor,
    taskExecutionOptions,
    parallelOptions,
    runContext?.taskContext,
    runContext?.gitProvider,
  );
}
