import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import type { TaskExecutionOptions } from './types.js';

export async function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string,
  overrides: TaskExecutionOptions | undefined, signal: AbortSignal,
): Promise<TaskInfo[]> {
  const claimed: TaskInfo[] = [];
  while (claimed.length === 0 && count > 0 && !signal.aborted) {
    const pendingGoals = new Set(taskRunner.listTaskStateItems()
      .filter((task) => task.status === 'pending' && task.goalId !== undefined)
      .map((task) => task.name));
    claimed.push(...taskRunner.claimNextTasks(count));
    const failedGoals = taskRunner.listTaskStateItems().some((task) =>
      pendingGoals.has(task.name) && task.status === 'failed' && task.completion !== undefined);
    if (!failedGoals) break;
    const { recoverManagerEvents } = await import('../../manager/completionTurn.js');
    await recoverManagerEvents(cwd, overrides);
  }
  return claimed;
}
