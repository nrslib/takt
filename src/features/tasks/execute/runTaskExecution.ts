import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { executeTaskAndCompleteWithResult, executeTaskWithResult } from './taskExecution.js';
import { executeTaskWorkflow } from './taskWorkflowExecution.js';
import { executeWorkflowForRun } from './workflowExecution.js';
import type {
  ExecuteTaskOptions,
  TaskExecutionOptions,
  TaskExecutionParallelOptions,
  WorkflowExecutionResult,
} from './types.js';

export interface RunTaskExecutionContext {
  ignoreIterationLimit?: boolean;
}

async function executeTaskWithRunResult(
  options: ExecuteTaskOptions,
  runContext?: RunTaskExecutionContext,
): Promise<WorkflowExecutionResult> {
  return executeTaskWorkflow(
    options,
    (workflowConfig, task, cwd, workflowOptions) =>
      executeWorkflowForRun(workflowConfig, task, cwd, workflowOptions, runContext),
  );
}

export async function executeRunTaskAndComplete(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
  runContext?: RunTaskExecutionContext,
): Promise<boolean> {
  const taskExecutor = runContext?.ignoreIterationLimit === true
    ? (options: ExecuteTaskOptions) => executeTaskWithRunResult(options, runContext)
    : executeTaskWithResult;
  return executeTaskAndCompleteWithResult(
    task,
    taskRunner,
    cwd,
    taskExecutor,
    taskExecutionOptions,
    parallelOptions,
  );
}
