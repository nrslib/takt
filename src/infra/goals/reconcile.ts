import { TaskRunner } from '../task/runner.js';
import { GoalStore } from './store.js';
import type { Goal, GoalTaskResult } from './schema.js';
import { getRegisteredGoal } from './registration.js';
import { goalCompletionEvent, verifiedGoalCompletionContext } from './completion-evidence.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { recordManagerRunFailure } from '../task/manager-run-state.js';

type GoalEvent = NonNullable<Goal['events']>[number];

function replaceCompletionEvent(events: GoalEvent[], event: GoalEvent): GoalEvent[] {
  const first = events.findIndex((saved) => saved.taskName === event.taskName && saved.runSlug === event.runSlug);
  if (first === -1) return [...events, event];
  return events.flatMap((saved, index) => saved.taskName === event.taskName && saved.runSlug === event.runSlug
    ? index === first ? [event] : [] : [saved]);
}

export async function recordGoalCompletion(cwd: string, id: string, completion: {
  taskName: string; runSlug: string; result: GoalTaskResult;
}): Promise<void> {
  await getRegisteredGoal(cwd, id);
  const event = goalCompletionEvent(cwd, id, completion);
  await new GoalStore(cwd).update(id, (goal) => {
    return { ...goal, events: replaceCompletionEvent(goal.events ?? [], event) };
  });
}

export async function reconcileGoalTasks(cwd: string, id: string): Promise<void> {
  const registered = await getRegisteredGoal(cwd, id);
  const tasks = new TaskRunner(cwd).listTaskStateItems().filter((task) => task.goalId === id);
  if (tasks.length === 0 && (registered.events?.length ?? 0) === 0) return;
  await new GoalStore(cwd).update(id, (goal) => {
    const workUnits = [...(goal.workUnits ?? [])];
    let events = [...(goal.events ?? [])];
    for (const task of tasks) {
      if (task.goalPurpose !== undefined && !workUnits.some((unit) => unit.taskName === task.name)) {
        workUnits.push({ taskName: task.name, purpose: task.goalPurpose });
      }
      if (task.completion !== undefined && task.runSlug !== undefined) {
        try {
          events = replaceCompletionEvent(events, goalCompletionEvent(cwd, id, { taskName: task.name, runSlug: task.runSlug, result: task.completion }));
        } catch (error) {
          recordManagerRunFailure(cwd, new Error(`Cannot recover goal completion ${id}: ${getErrorMessage(error)}`));
        }
      }
    }
    const verified = verifiedGoalCompletionContext(cwd, { ...goal, workUnits, events });
    for (const event of verified.events ?? []) events = replaceCompletionEvent(events, event);
    // Retain rejected events for diagnosis; they never enter the provider context.
    return { ...goal, workUnits, sessions: verified.sessions, events };
  });
}
