import { inspectGoalDiff, inspectGoalHistory, inspectGoalRelation, GOAL_READ_MAX_ITEMS, GOAL_READ_MAX_BYTES } from '../../infra/goals/inspection.js';
import { resolveGoalIntegrationConfig } from './goalIntegrationOperations.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { GetGoalInput, GoalDiffInput, GoalHistoryInput } from './schemas.js';

async function goalRead(
  input: GetGoalInput, deps: McpOperationDependencies,
  action: (targetBranch: string) => Promise<Record<string, unknown>>,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const { targetBranch } = await resolveGoalIntegrationConfig(input.cwd, input.goalId);
    const result = await action(targetBranch);
    if (Buffer.byteLength(JSON.stringify(result)) > GOAL_READ_MAX_BYTES) throw new Error('Goal inspection metadata exceeds the response limit');
    return jsonResult(result);
  } catch (error) { return errorResult('Goal inspection failed', error); }
}

export function getTaktGoalDiff(input: GoalDiffInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalRead(input, deps, (target) => inspectGoalDiff(input.cwd, input.goalId, input.taskName, target, input.file, input.limit ?? GOAL_READ_MAX_ITEMS, signal));
}

export function getTaktGoalHistory(input: GoalHistoryInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalRead(input, deps, (target) => inspectGoalHistory(input.cwd, input.goalId, input.taskName, target, input.limit ?? GOAL_READ_MAX_ITEMS, signal));
}

export function getTaktGoalRelation(input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalRead(input, deps, (target) => inspectGoalRelation(input.cwd, input.goalId, target, signal));
}
