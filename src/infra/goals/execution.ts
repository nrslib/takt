import { GoalStore } from './store.js';
import { GoalIdSchema, type Goal } from './schema.js';
import { transitionGoalExecution } from './state.js';
import { withGoalTurns } from './turn-lock.js';
import { withGoalWrites } from './operations.js';

export async function setGoalExecutionStatus(
  cwd: string, goalId: string, executionStatus: Goal['executionStatus'], signal: AbortSignal,
): Promise<Goal> {
  GoalIdSchema.parse(goalId);
  const store = new GoalStore(cwd);
  await store.get(goalId);
  return withGoalTurns(cwd, [goalId], () => withGoalWrites(cwd, goalId, () =>
    store.update(goalId, (goal) => {
      signal.throwIfAborted();
      return transitionGoalExecution(goal, executionStatus);
    })), {}, signal);
}
