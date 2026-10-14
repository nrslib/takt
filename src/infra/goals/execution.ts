import { GoalStore } from './store.js';
import { GoalIdSchema, type Goal } from './schema.js';
import { transitionGoalExecution } from './state.js';
import { deleteGoalEvents, saveManagerEvent } from './events.js';

export async function setGoalExecutionStatus(
  cwd: string, goalId: string, executionStatus: Goal['executionStatus'], signal: AbortSignal,
): Promise<Goal> {
  GoalIdSchema.parse(goalId);
  const store = new GoalStore(cwd);
  const previous = await store.get(goalId);
  signal.throwIfAborted();
  const goal = await store.update(goalId, (current) => transitionGoalExecution(current, executionStatus));
  if (executionStatus === 'aborted') deleteGoalEvents(cwd, goalId);
  if (executionStatus === 'active' && previous.executionStatus === 'paused') {
    saveManagerEvent(cwd, { kind: 'resumed', goalId });
  }
  return goal;
}
