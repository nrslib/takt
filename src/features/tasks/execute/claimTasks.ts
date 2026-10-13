import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { saveManagerEvent } from '../../../infra/goals/events.js';

export function claimTasksWithGoalCompletions(
  taskRunner: TaskRunner, count: number, cwd: string, signal: AbortSignal,
): { tasks: TaskInfo[] } {
  if (count <= 0 || signal.aborted) return { tasks: [] };
  const pending = new Set(taskRunner.listTaskStateItems()
    .filter((task) => task.status === 'pending' && task.goalId !== undefined).map((task) => task.name));
  const tasks = taskRunner.claimNextTasks(count);
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
