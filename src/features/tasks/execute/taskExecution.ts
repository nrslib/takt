/**
 * Task execution logic
 */

import type { TaskRunner, TaskInfo, TaskResult } from '../../../infra/task/index.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GoalTaskResult } from '../../../infra/goals/schema.js';
import type { GitProvider } from '../../../infra/git/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
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
import { GoalAbortMonitor, GoalAbortedError } from './goalAbortMonitor.js';
import {
  buildBooleanTaskResult,
  buildTaskResult,
  persistExceededTaskResult,
  persistTaskError,
  persistPrFailedTaskResult,
  persistTaskResult,
} from './taskResultHandler.js';
import { runWorkflowExecution } from './workflowExecutionApi.js';
import {
  createLoopAnalysisPublicationCoordinator,
  settleLoopAnalysisPublication,
  type LoopAnalysisPublicationCoordinator,
} from './loopAnalysisPublication.js';

export type { TaskExecutionOptions, ExecuteTaskOptions };

export interface TaskCompletionResult {
  completion?: GoalTaskResult;
  runSlug?: string;
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
  const goalId = task.data?.goal_id;
  const taskAbortSignal = externalAbortSignal || goalId !== undefined ? taskAbortController.signal : undefined;
  let goalAbortMonitor: GoalAbortMonitor | undefined;
  let workflowStarted = false;
  let loopAnalysisPublication: LoopAnalysisPublicationCoordinator | undefined;
  let executionCwd: string | undefined;
  let executionBranch: string | undefined;
  let workflowResult: GoalTaskResult['workflowResult'] = 'error';
  let interrupted = false;
  let runSlug: string | undefined;
  const snapshot = (success: boolean, failureReason?: string): GoalTaskResult | undefined => {
    if (task.data?.goal_id === undefined) return undefined;
    const completion: GoalTaskResult = {
      success,
      interrupted, workflowResult,
      failureReason,
      ...(executionBranch === undefined ? {} : { branch: executionBranch }),
    };
    if (executionCwd !== undefined && workflowResult !== 'error') {
      completion.branch = executionBranch;
      try {
        completion.branch ??= execFileSync('git', ['branch', '--show-current'], { cwd: executionCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        completion.sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: executionCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (error) {
        completion.shaUnavailableReason = sanitizeSensitiveText(getErrorMessage(error));
      }
    } else {
      completion.shaUnavailableReason = 'Workflow execution did not start';
    }
    return completion;
  };

  const onExternalAbort = (): void => {
    taskAbortController.abort(externalAbortSignal?.reason);
  };

  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) {
      onExternalAbort();
    } else {
      externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    if (task.data?.goal_id !== undefined) {
      runSlug = `setup-${randomUUID()}`;
      taskForPersistence = { ...taskForPersistence, runSlug };
      taskForPersistence = taskRunner.updateRunningTaskExecution(task.name, { runSlug });
    }
    if (goalId !== undefined) {
      goalAbortMonitor = new GoalAbortMonitor(cwd, goalId, taskAbortController);
      taskAbortSignal?.throwIfAborted();
    }
    const emitStatusLog = parallelOptions?.outputMode !== 'silent';
    const {
      execCwd,
      workflowIdentifier,
      isWorktree,
      taskSpec,
      reportDirName,
      branch,
      worktreePath,
      baseBranch,
      startStep,
      retryNote,
      resumePoint,
      restartPoint,
      resumeSource,
      autoPr,
      draftPr,
      managedPr,
      shouldPublishBranchToOrigin,
      issueNumber,
      maxStepsOverride,
      initialIterationOverride,
      prNumber,
      prContext,
    } = await resolveTaskExecution(task, cwd, taskAbortSignal, {
      ...buildResolveTaskExecutionOptions(parallelOptions, taskContext),
    });
    executionCwd = execCwd;
    executionBranch = branch;
    goalAbortMonitor?.check();
    if (taskAbortController.signal.reason instanceof GoalAbortedError) throw taskAbortController.signal.reason;

    runSlug = reportDirName;
    if (task.data?.goal_id !== undefined) taskForPersistence = { ...taskForPersistence, runSlug };
    const executionTask = taskRunner.updateRunningTaskExecution(task.name, {
      runSlug: reportDirName,
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
    });
    taskForPersistence = executionTask;

    const projectRootCwd = cwd;
    loopAnalysisPublication = autoPr && branch
      ? createLoopAnalysisPublicationCoordinator(branch)
      : undefined;
    workflowStarted = true;
    let taskRunResult = await taskExecutor({
      task: taskSpec?.taskPrompt ?? task.content,
      ...(taskSpec === undefined ? {} : { taskSpec }),
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: projectRootCwd,
      ...(task.data?.goal_id === undefined ? {} : { goalId: task.data.goal_id }),
      agentOverrides: taskExecutionOptions,
      startStep,
      retryNote,
      resumePoint,
      restartPoint,
      resumeSource,
      reportDirName,
      abortSignal: taskAbortSignal,
      handleSigint: externalAbortSignal === undefined,
      taskPrefix: parallelOptions?.taskPrefix,
      taskColorIndex: parallelOptions?.taskColorIndex,
      taskDisplayLabel: parallelOptions?.taskDisplayLabel,
      outputMode: parallelOptions?.outputMode,
      maxStepsOverride,
      initialIterationOverride,
      currentTaskIssueNumber: issueNumber,
      traceTaskMetadata: buildTraceTaskMetadata({
        task,
        taskContent: taskSpec?.taskPrompt ?? task.content,
        branch,
        baseBranch,
        worktreePath,
        issueNumber,
        prNumber,
      }),
      ...(prContext ? { prContext } : {}),
      ...(loopAnalysisPublication === undefined
        ? {}
        : { loopAnalysisPublication }),
    });
    goalAbortMonitor?.check();
    if (taskAbortController.signal.reason instanceof GoalAbortedError) {
      taskRunResult = { ...taskRunResult, success: false, interrupted: true, reason: taskAbortController.signal.reason.message,
        exceeded: false, retryable: false };
    }
    interrupted = taskRunResult.interrupted === true;
    workflowResult = taskRunResult.setupFailed === true ? 'error'
      : taskRunResult.exceeded ? 'exceeded' : taskRunResult.success ? 'completed' : 'aborted';

    if (taskRunResult.exceeded && taskRunResult.exceededInfo) {
      const failureReason = buildExceededFailureReason(taskRunResult.exceededInfo);
      const completion = snapshot(false, failureReason);
      persistExceededTaskResult(taskRunner, executionTask, taskRunResult.exceededInfo, {
        worktreePath,
        branch,
        ...(completion === undefined ? {} : { completion }),
      }, {
        emitStatusLog,
      });
      return {
        success: false,
        failureReason,
        ...(completion === undefined ? {} : { completion, runSlug }),
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
        goalId: task.data?.goal_id,
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
        abortSignal: taskAbortSignal,
        issues,
        orderContent: taskSpec?.orderContent,
        outputMode: parallelOptions?.outputMode,
        taskPrefix: parallelOptions?.taskPrefix,
        taskColorIndex: parallelOptions?.taskColorIndex,
        taskDisplayLabel: parallelOptions?.taskDisplayLabel,
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

    goalAbortMonitor?.check();
    if (taskRunResult.success && taskAbortController.signal.reason instanceof GoalAbortedError) throw taskAbortController.signal.reason;

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
      const completion = snapshot(false, taskResult.response);
      if (completion !== undefined) taskResult.completion = completion;
      persistTaskResult(taskRunner, taskResult, { emitStatusLog });
      return {
        success: false,
        failureReason: taskResult.response,
        taskResult,
        ...(completion === undefined ? {} : { completion, runSlug }),
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
      const completion = snapshot(false, prFailedError);
      if (completion !== undefined) taskResult.completion = completion;
      persistPrFailedTaskResult(taskRunner, taskResult, prFailedError, { emitStatusLog });
      return {
        success: true,
        prFailed: true,
        postExecutionFailureReason: prFailedError,
        taskResult,
        ...(completion === undefined ? {} : { completion, runSlug }),
      };
    }

    const completion = snapshot(taskRunResult.success, taskRunResult.success ? undefined : taskResult.response);
    if (completion !== undefined) taskResult.completion = completion;
    persistTaskResult(taskRunner, taskResult, { emitStatusLog });
    return {
      success: taskRunResult.success,
      ...(taskRunResult.success ? {} : { failureReason: taskResult.response }),
      taskResult,
      ...(completion === undefined ? {} : { completion, runSlug }),
    };
  } catch (err) {
    const error = taskAbortController.signal.reason instanceof GoalAbortedError
      ? taskAbortController.signal.reason : err;
    if (error instanceof GoalAbortedError) {
      if (workflowStarted) workflowResult = 'aborted';
    }
    interrupted ||= taskAbortSignal?.aborted === true;
    const completedAt = new Date().toISOString();
    const failureReason = getErrorMessage(error);
    const completion = snapshot(false, failureReason);
    persistTaskError(taskRunner, taskForPersistence, startedAt, completedAt, error, {
      emitStatusLog: parallelOptions?.outputMode !== 'silent',
      ...(completion === undefined ? {} : { completion }),
    });
    return {
      success: false,
      failureReason,
      ...(completion === undefined ? {} : { completion, runSlug }),
    };
  } finally {
    goalAbortMonitor?.stop();
    settleLoopAnalysisPublication(loopAnalysisPublication);
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
