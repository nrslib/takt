import type { Goal } from './schema.js';

export function isGoalPaused(goal: Pick<Goal, 'executionStatus'>): boolean {
  return goal.executionStatus === 'paused';
}

export function transitionGoalExecution(goal: Goal, executionStatus: Goal['executionStatus']): Goal {
  if (executionStatus === 'aborted' && goal.status === 'completed' && goal.executionStatus !== 'aborted') {
    throw new Error('A completed goal cannot be aborted');
  }
  if (goal.executionStatus === 'aborted' && executionStatus !== 'aborted') {
    throw new Error('An aborted goal cannot resume');
  }
  return { ...goal, executionStatus };
}
