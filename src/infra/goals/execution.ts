import { GoalStore } from './store.js';
import { GoalIdSchema, type Goal } from './schema.js';
import { transitionGoalExecution } from './state.js';
import { withdrawPendingGoalQuestions } from './questions.js';
import { deleteGoalEvents, saveManagerEvent } from './events.js';

export async function setGoalExecutionStatus(
  cwd: string, goalId: string, executionStatus: Goal['executionStatus'], signal: AbortSignal,
): Promise<Goal> {
  GoalIdSchema.parse(goalId);
  const store = new GoalStore(cwd);
  const previous = await store.get(goalId);
  signal.throwIfAborted();
  const goal = await store.update(goalId, (current) => {
    const transitioned = transitionGoalExecution(current, executionStatus);
    return executionStatus === 'aborted'
      ? withdrawPendingGoalQuestions(transitioned, 'Goal was aborted', new Date().toISOString()) : transitioned;
  });
  if (executionStatus === 'aborted') deleteGoalEvents(cwd, goalId);
  if (executionStatus === 'active' && previous.executionStatus === 'paused') {
    saveManagerEvent(cwd, { kind: 'resumed', goalId });
  }
  return goal;
}
