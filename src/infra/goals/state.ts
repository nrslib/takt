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
  if (goal.status === 'completed' && executionStatus !== 'aborted') {
    throw new Error('A completed goal cannot be paused or resumed');
  }
  if (executionStatus === 'paused' && goal.executionStatus !== 'active') {
    throw new Error('Only an active goal can be paused');
  }
  if (executionStatus === 'active' && goal.executionStatus !== 'paused') {
    throw new Error('Only a paused goal can resume');
  }
  return { ...goal, executionStatus };
}
