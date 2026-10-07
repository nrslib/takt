import { TaskRunner } from '../task/runner.js';
import { GoalStore } from './store.js';
import type { Goal, GoalTaskResult } from './schema.js';

type GoalEvent = NonNullable<Goal['events']>[number];

function appendCompletionEvent(events: GoalEvent[], completion: {
  taskName: string; runSlug: string; result: GoalTaskResult;
}): GoalEvent[] {
  if (events.some((saved) => saved.taskName === completion.taskName && saved.runSlug === completion.runSlug)) return events;
  return [...events, { ...completion, processed: false }];
}

export async function recordGoalCompletion(cwd: string, id: string, completion: {
  taskName: string; runSlug: string; result: GoalTaskResult;
}): Promise<void> {
  await new GoalStore(cwd).update(id, (goal) => ({
    ...goal, events: appendCompletionEvent(goal.events ?? [], completion),
  }));
}

export async function reconcileGoalTasks(cwd: string, id: string): Promise<void> {
  await new GoalStore(cwd).get(id);
  const tasks = new TaskRunner(cwd).listTaskStateItems().filter((task) => task.goalId === id);
  if (tasks.length === 0) return;
  await new GoalStore(cwd).update(id, (goal) => {
    const workUnits = [...(goal.workUnits ?? [])];
    let events = [...(goal.events ?? [])];
    for (const task of tasks) {
      if (task.goalPurpose !== undefined && !workUnits.some((unit) => unit.taskName === task.name)) {
        workUnits.push({ taskName: task.name, purpose: task.goalPurpose });
      }
      if (task.completion !== undefined && task.runSlug !== undefined) {
        events = appendCompletionEvent(events, { taskName: task.name, runSlug: task.runSlug, result: task.completion });
      }
    }
    return { ...goal, workUnits, events };
  });
}
