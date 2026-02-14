import { type TaskInfo, type TaskResult, TaskRunner } from '../../../infra/task/index.js';
import { error, success } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type { PieceExecutionResult } from './types.js';

interface BuildTaskResultParams {
  task: TaskInfo;
  runResult: PieceExecutionResult;
  startedAt: string;
  completedAt: string;
  branch?: string;
  worktreePath?: string;
}

interface BuildBooleanTaskResultParams {
  task: TaskInfo;
  taskSuccess: boolean;
  startedAt: string;
  completedAt: string;
  successResponse: string;
  failureResponse: string;
  branch?: string;
  worktreePath?: string;
}

interface PersistTaskResultOptions {
  emitStatusLog?: boolean;
}

interface PersistTaskErrorOptions {
  emitStatusLog?: boolean;
  responsePrefix?: string;
}

export function buildTaskResult(params: BuildTaskResultParams): TaskResult {
  const { task, runResult, startedAt, completedAt, branch, worktreePath } = params;
  const taskSuccess = runResult.success;

  if (!taskSuccess && !runResult.reason) {
    throw new Error('Task failed without reason');
  }

  return {
    task,
    success: taskSuccess,
    response: taskSuccess ? 'Task completed successfully' : runResult.reason!,
    executionLog: runResult.lastMessage ? [runResult.lastMessage] : [],
    failureMovement: runResult.lastMovement,
    failureLastMessage: runResult.lastMessage,
    startedAt,
    completedAt,
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
}

export function buildBooleanTaskResult(params: BuildBooleanTaskResultParams): TaskResult {
  const {
    task,
    taskSuccess,
    startedAt,
    completedAt,
    successResponse,
    failureResponse,
    branch,
    worktreePath,
  } = params;

  return {
    task,
    success: taskSuccess,
    response: taskSuccess ? successResponse : failureResponse,
    executionLog: [],
    startedAt,
    completedAt,
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
}

export function persistTaskResult(
  taskRunner: TaskRunner,
  taskResult: TaskResult,
  options?: PersistTaskResultOptions,
): void {
  const emitStatusLog = options?.emitStatusLog !== false;
  if (taskResult.success) {
    taskRunner.completeTask(taskResult);
    if (emitStatusLog) {
      success(`Task "${taskResult.task.name}" completed`);
    }
    return;
  }

  taskRunner.failTask(taskResult);
  if (emitStatusLog) {
    error(`Task "${taskResult.task.name}" failed`);
  }
}

export function persistTaskError(
  taskRunner: TaskRunner,
  task: TaskInfo,
  startedAt: string,
  completedAt: string,
  err: unknown,
  options?: PersistTaskErrorOptions,
): void {
  const emitStatusLog = options?.emitStatusLog !== false;
  const responsePrefix = options?.responsePrefix ?? '';
  taskRunner.failTask({
    task,
    success: false,
    response: `${responsePrefix}${getErrorMessage(err)}`,
    executionLog: [],
    startedAt,
    completedAt,
    ...(task.data?.branch ? { branch: task.data.branch } : {}),
    ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
  });

  if (emitStatusLog) {
    error(`Task "${task.name}" error: ${getErrorMessage(err)}`);
  }
}
