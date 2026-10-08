import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { checkGoalCompletion, completeGoal, integrateGoalTask } from '../../infra/goals/integration.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { CompleteGoalInput, GetGoalInput, MergeGoalTaskInput } from './schemas.js';

async function goalWrite(
  input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal,
  action: () => Promise<Record<string, unknown>>,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    await new GoalStore(input.cwd).get(input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], async () => {
      const result = await action();
      return jsonResult(result, result.recorded === false);
    }, deps.goalTurnOwners, signal);
  } catch (error) { return errorResult('Goal integration failed', error); }
}

export function mergeTaktGoalTask(input: MergeGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, () => integrateGoalTask(input.cwd, input.goalId, input.taskName, input.expectedSha, signal));
}

export function completeTaktGoal(input: CompleteGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, () => {
    const { mainMerge } = resolveManagerConfig(input.cwd);
    return completeGoal(input.cwd, input.goalId, input.expectedSha, input.summary, mainMerge, signal);
  });
}

export function checkTaktGoalCompletion(input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, () => checkGoalCompletion(input.cwd, input.goalId, signal));
}
