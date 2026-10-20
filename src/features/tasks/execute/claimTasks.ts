import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import type { TaskExecutionOptions } from './types.js';
import { PrivateFileLockAcquisitionError } from '../../../shared/utils/private-file-lock.js';

export class TaskClaimLockUnavailableError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
  }
}

export async function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string,
  overrides: TaskExecutionOptions | undefined, signal: AbortSignal, goalTasksOnly = false,
): Promise<{ tasks: TaskInfo[]; managerCompletion?: Promise<void> }> {
  if (count <= 0 || signal.aborted) return { tasks: [] };
  const taskStates = taskRunner.listTaskStateItems();
  const hasPending = taskStates.some((task) => task.status === 'pending'
    && (!goalTasksOnly || task.goalId !== undefined));
  const pendingGoals = new Set(taskStates
    .filter((task) => task.status === 'pending' && task.goalId !== undefined)
    .map((task) => task.name));
  let tasks: TaskInfo[];
  try {
    tasks = taskRunner.claimNextTasks(count);
  } catch (error) {
    if (hasPending && error instanceof PrivateFileLockAcquisitionError && error.code === 'ENOSPC') {
      throw new TaskClaimLockUnavailableError(error.message, { cause: error });
    }
    throw error;
  }
  const failedGoals = new Set(taskRunner.listTaskStateItems().filter((task) =>
    pendingGoals.has(task.name) && task.status === 'failed' && task.completion !== undefined)
    .map((task) => task.goalId!));
  if (failedGoals.size === 0) return { tasks };
  const { processGoalCompletions } = await import('../../manager/completionTurn.js');
  const managerCompletion = (async () => {
    for (const goalId of failedGoals) await processGoalCompletions(cwd, goalId, overrides, undefined, signal);
  })();
  return { tasks, managerCompletion };
}
