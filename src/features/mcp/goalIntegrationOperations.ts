import { checkGoalCompletion, completeGoal, integrateGoalTask } from '../../infra/goals/integration.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import type { McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import { integrationSummary } from './goalResponse.js';
import type { CompleteGoalInput, GoalIdentityInput, MergeGoalTaskInput } from './schemas.js';

export function mergeTaktGoalTask(input: MergeGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge) => integrationSummary(await integrateGoalTask(
    input.cwd, input.goalId, input.taskName, input.expectedSha, signal, policy, resolveConfigValue(input.cwd, 'language'),
  )), 'Goal integration failed', 'integrate');
}

export function completeTaktGoal(input: CompleteGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, mainMerge) => {
    return integrationSummary(await completeGoal(input.cwd, input.goalId, input.expectedSha, input.summary, mainMerge, signal, policy));
  }, 'Goal integration failed', 'complete');
}

export function checkTaktGoalCompletion(input: GoalIdentityInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge) => integrationSummary(await checkGoalCompletion(input.cwd, input.goalId, signal, policy)), 'Goal integration failed', 'check_completion');
}
