import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import type { TaskExecutionOptions } from './types.js';

export async function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string,
  overrides: TaskExecutionOptions | undefined, signal: AbortSignal,
): Promise<{ tasks: TaskInfo[]; managerCompletion?: Promise<void> }> {
  if (count <= 0 || signal.aborted) return { tasks: [] };
  const pendingGoals = new Set(taskRunner.listTaskStateItems()
    .filter((task) => task.status === 'pending' && task.goalId !== undefined)
    .map((task) => task.name));
  const tasks = taskRunner.claimNextTasks(count);
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
