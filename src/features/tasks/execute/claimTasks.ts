import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { saveManagerEvent } from '../../../infra/goals/events.js';
import { PrivateFileLockAcquisitionError } from '../../../shared/utils/private-file-lock.js';
import { TaskClaimLockAcquisitionError } from '../../../infra/task/taskLifecycleService.js';

export class TaskClaimLockUnavailableError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
  }
}

export function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string, signal: AbortSignal,
  goalTasksOnly = false,
): { tasks: TaskInfo[] } {
  if (count <= 0 || signal.aborted) return { tasks: [] };
  const taskStates = taskRunner.listTaskStateItems();
  const hasPending = taskStates.some((task) => task.status === 'pending'
    && (!goalTasksOnly || task.goalId !== undefined));
  const pending = new Set(taskStates
    .filter((task) => task.status === 'pending' && task.goalId !== undefined).map((task) => task.name));
  let tasks: TaskInfo[];
  try {
    tasks = taskRunner.claimNextTasks(count);
  } catch (error) {
    if (hasPending && (error instanceof TaskClaimLockAcquisitionError
      || (error instanceof PrivateFileLockAcquisitionError && error.code === 'ENOSPC'))) {
      throw new TaskClaimLockUnavailableError(error.message, { cause: error });
    }
    throw error;
  }
  for (const task of taskRunner.listTaskStateItems()) {
    if (pending.has(task.name) && task.status === 'failed' && task.goalId !== undefined
      && task.completion !== undefined && task.runSlug !== undefined) {
      saveManagerEvent(cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name, runSlug: task.runSlug, result: task.completion });
    }
  }
  return { tasks };
}

export function failInterruptedTasksWithGoalEvents(taskRunner: TaskRunner, cwd: string): number {
  const running = new Set(taskRunner.listTaskStateItems().filter((task) => task.status === 'running').map((task) => task.name));
  const failed = taskRunner.failInterruptedRunningTasks();
  for (const task of taskRunner.listTaskStateItems()) {
    if (running.has(task.name) && task.status === 'failed' && task.goalId !== undefined
      && task.completion !== undefined && task.runSlug !== undefined) {
      saveManagerEvent(cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name, runSlug: task.runSlug, result: task.completion });
    }
  }
  return failed;
}
