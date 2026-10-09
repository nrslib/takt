import { checkGoalCompletion, completeGoal, integrateGoalTask } from '../../infra/goals/integration.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import type { McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { CompleteGoalInput, GetGoalInput, MergeGoalTaskInput } from './schemas.js';

export function mergeTaktGoalTask(input: MergeGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy) => integrateGoalTask(
    input.cwd, input.goalId, input.taskName, input.expectedSha, signal, policy, resolveConfigValue(input.cwd, 'language'),
  ), 'Goal integration failed');
}

export function completeTaktGoal(input: CompleteGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy, mainMerge) => {
    return completeGoal(input.cwd, input.goalId, input.expectedSha, input.summary, mainMerge, signal, policy);
  }, 'Goal integration failed');
}

export function checkTaktGoalCompletion(input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy) => checkGoalCompletion(input.cwd, input.goalId, signal, policy), 'Goal integration failed');
}
