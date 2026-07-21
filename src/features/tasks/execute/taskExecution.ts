/**
 * Task execution logic
 */

import type { TaskRunner, TaskInfo, TaskResult } from '../../../infra/task/index.js';
import type { GitProvider } from '../../../infra/git/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type {
  TaskExecutionOptions,
  ExecuteTaskOptions,
  WorkflowExecutionResult,
  TaskExecutionParallelOptions,
  TaskExecutionContextOverride,
  ExceededInfo,
} from './types.js';
import { resolveTaskExecution, resolveTaskIssue, type ResolveTaskExecutionOptions } from './resolveTask.js';
import { buildTraceTaskMetadata } from './traceTaskMetadata.js';
import { postExecutionFlow } from './postExecution.js';
import {
  buildBooleanTaskResult,
  buildTaskResult,
  persistExceededTaskResult,
  persistTaskError,
  persistPrFailedTaskResult,
  persistTaskResult,
} from './taskResultHandler.js';
import { runWorkflowExecution } from './workflowExecutionApi.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

export interface TaskCompletionResult {
  success: boolean;
  failureReason?: string;
  prFailed?: boolean;
  postExecutionFailureReason?: string;
  taskResult?: TaskResult;
}

export async function executeTaskWithResult(options: ExecuteTaskOptions): Promise<WorkflowExecutionResult> {
  return runWorkflowExecution(options);
}

/**
 * Execute a single task with workflow.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const result = await executeTaskWithResult(options);
  return result.success;
}

/**
 * Execute a task: resolve clone → run workflow → auto-commit+push → remove clone → record completion.
 *
 * Shared by watch/list/retry flows to avoid duplicated
 * resolve → execute → autoCommit → complete logic.
 *
 * @returns true if the task succeeded
 */
export async function executeAndCompleteTask(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
): Promise<boolean> {
  const result = await executeTaskAndCompleteWithDetails(
    task,
    taskRunner,
    cwd,
    executeTaskWithResult,
    taskExecutionOptions,
    parallelOptions,
  );
  return result.success;
}

export async function executeTaskAndCompleteWithResult(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutor: (options: ExecuteTaskOptions) => Promise<WorkflowExecutionResult>,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
  taskContext?: TaskExecutionContextOverride,
): Promise<boolean> {
  const result = await executeTaskAndCompleteWithDetails(
    task,
    taskRunner,
    cwd,
    taskExecutor,
    taskExecutionOptions,
    parallelOptions,
    taskContext,
  );
  return result.success;
}

export async function executeTaskAndCompleteWithDetails(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutor: (options: ExecuteTaskOptions) => Promise<WorkflowExecutionResult>,
  taskExecutionOptions?: TaskExecutionOptions,
  parallelOptions?: TaskExecutionParallelOptions,
  taskContext?: TaskExecutionContextOverride,
  gitProvider?: GitProvider,
): Promise<TaskCompletionResult> {
  const startedAt = new Date().toISOString();
  let taskForPersistence = task;
  const taskAbortController = new AbortController();
  const externalAbortSignal = parallelOptions?.abortSignal;
  const taskAbortSignal = externalAbortSignal ? taskAbortController.signal : undefined;

  const onExternalAbort = (): void => {
    taskAbortController.abort();
  };

  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) {
      taskAbortController.abort();
    } else {
      externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const emitStatusLog = parallelOptions?.outputMode !== 'silent';
    const {
      execCwd,
      workflowIdentifier,
      isWorktree,
      taskPrompt,
      reportDirName,
      branch,
      worktreePath,
      baseBranch,
      startStep,
      retryNote,
      resumePoint,
      resumeSource,
      autoPr,
      draftPr,
      managedPr,
      shouldPublishBranchToOrigin,
      issueNumber,
      orderContent,
      maxStepsOverride,
      initialIterationOverride,
      prNumber,
    } = await resolveTaskExecution(task, cwd, taskAbortSignal, {
      ...buildResolveTaskExecutionOptions(parallelOptions, taskContext),
    });

    const executionTask = taskRunner.updateRunningTaskExecution(task.name, {
      runSlug: reportDirName,
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
    });
    taskForPersistence = executionTask;

    const projectRootCwd = cwd;
    const taskRunResult = await taskExecutor({
      task: taskPrompt ?? task.content,
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: projectRootCwd,
      agentOverrides: taskExecutionOptions,
      startStep,
      retryNote,
      resumePoint,
      resumeSource,
      reportDirName,
      abortSignal: taskAbortSignal,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
      taskDisplayLabel: parallelOptions?.taskDisplayLabel,
      outputMode: parallelOptions?.outputMode,
      maxStepsOverride,
      initialIterationOverride,
      currentTaskIssueNumber: issueNumber,
      traceTaskMetadata: buildTraceTaskMetadata({
        task,
        taskContent: taskPrompt ?? task.content,
        branch,
        baseBranch,
        worktreePath,
        issueNumber,
        prNumber,
      }),
    });

    if (taskRunResult.exceeded && taskRunResult.exceededInfo) {
      persistExceededTaskResult(taskRunner, executionTask, taskRunResult.exceededInfo, {
        worktreePath,
        branch,
      }, {
        emitStatusLog,
      });
      return {
        success: false,
        failureReason: buildExceededFailureReason(taskRunResult.exceededInfo),
      };
    }

    const taskSuccess = taskRunResult.success;
    const completedAt = new Date().toISOString();

    let prUrl: string | undefined;
    let prFailedError: string | undefined;
    let postExecutionTaskError: string | undefined;
    if (taskSuccess && isWorktree) {
      const issues = gitProvider === undefined
        ? resolveTaskIssue(issueNumber, projectRootCwd)
        : resolveTaskIssue(issueNumber, projectRootCwd, gitProvider);
      const postResult = await postExecutionFlow({
        execCwd,
        projectCwd: projectRootCwd,
        task: task.name,
        branch,
        baseBranch,
        shouldCreatePr: autoPr,
        managedPr,
        shouldPublishBranchToOrigin,
        draftPr,
        workflowIdentifier,
        issues,
        orderContent,
        outputMode: parallelOptions?.outputMode,
        ...(gitProvider === undefined ? {} : { gitProvider }),
      });
      prUrl = postResult.prUrl;
      if (postResult.prFailed) {
        prFailedError = postResult.prError;
      }
      if (postResult.taskFailed) {
        postExecutionTaskError = postResult.taskError;
      }
    }

    if (postExecutionTaskError !== undefined) {
      const taskResult = buildBooleanTaskResult({
        task: executionTask,
        taskSuccess: false,
        startedAt,
        completedAt,
        successResponse: 'Task completed successfully',
        failureResponse: postExecutionTaskError,
        worktreePath,
        branch,
      });
      persistTaskResult(taskRunner, taskResult, { emitStatusLog });
      return {
        success: false,
        failureReason: taskResult.response,
        taskResult,
      };
    }

    const taskResult = buildTaskResult({
      task: executionTask,
      runResult: taskRunResult,
      startedAt,
      completedAt,
      branch,
      worktreePath,
      prUrl,
    });

    if (prFailedError !== undefined) {
      persistPrFailedTaskResult(taskRunner, taskResult, prFailedError, { emitStatusLog });
      return {
        success: true,
        prFailed: true,
        postExecutionFailureReason: prFailedError,
        taskResult,
      };
    }

    persistTaskResult(taskRunner, taskResult, { emitStatusLog });
    return {
      success: taskRunResult.success,
      ...(taskRunResult.success ? {} : { failureReason: taskResult.response }),
      taskResult,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const failureReason = getErrorMessage(err);
    persistTaskError(taskRunner, taskForPersistence, startedAt, completedAt, err, {
      emitStatusLog: parallelOptions?.outputMode !== 'silent',
    });
    return {
      success: false,
      failureReason,
    };
  } finally {
    if (externalAbortSignal) {
      externalAbortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function buildExceededFailureReason(exceeded: ExceededInfo): string {
  return `Task exceeded iteration limit at step "${exceeded.currentStep}"`;
}

function buildResolveTaskExecutionOptions(
  parallelOptions: TaskExecutionParallelOptions | undefined,
  taskContext: TaskExecutionContextOverride | undefined,
): ResolveTaskExecutionOptions {
  return {
    ...(parallelOptions?.outputMode !== undefined ? { outputMode: parallelOptions.outputMode } : {}),
    ...(taskContext !== undefined ? { taskContext } : {}),
  };
}
