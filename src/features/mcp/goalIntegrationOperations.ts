import { checkGoalCompletion, completeGoal, integrateGoalTask } from '../../infra/goals/integration.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import type { McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { CompleteGoalInput, GetGoalInput, MergeGoalTaskInput } from './schemas.js';

export function mergeTaktGoalTask(input: MergeGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy, _mainMerge, operation) => integrateGoalTask(
    input.cwd, input.goalId, input.taskName, input.expectedSha, signal, policy, resolveConfigValue(input.cwd, 'language'),
    operation,
  ), 'Goal integration failed', 'integrate');
}

export function completeTaktGoal(input: CompleteGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy, mainMerge, operation) => {
    return completeGoal(input.cwd, input.goalId, input.expectedSha, input.summary, mainMerge, signal, policy, operation);
  }, 'Goal integration failed', 'complete');
}

export function checkTaktGoalCompletion(input: GetGoalInput & { operationName?: string }, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, (policy, _mainMerge, operation) => checkGoalCompletion(input.cwd, input.goalId, signal, policy, operation), 'Goal integration failed', 'check_completion');
}
