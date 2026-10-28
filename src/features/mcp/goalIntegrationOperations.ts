import { checkGoalCompletion, completeGoal, integrateGoalTask, reopenGoal } from '../../infra/goals/integration.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { mergeGoalPr } from '../manager/mergeGoalPr.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import { integrationSummary } from './goalResponse.js';
import type { CompleteGoalInput, GoalIdentityInput, MergeGoalTaskInput, MergeGoalPrInput, ReopenGoalInput } from './schemas.js';

export function mergeTaktGoalTask(input: MergeGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge) => integrationSummary(await integrateGoalTask(
    input.cwd, input.goalId, input.taskName, input.expectedSha, signal, policy, resolveConfigValue(input.cwd, 'language'),
  )), 'Goal integration failed', 'integrate');
}

export function completeTaktGoal(input: CompleteGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, mainMerge) => {
    return integrationSummary(await completeGoal(input.cwd, input.goalId, input.expectedSha, input.summary, mainMerge, signal, policy,
      input.humanChecks, resolveConfigValue(input.cwd, 'language')));
  }, 'Goal integration failed', 'complete');
}

export function mergeTaktGoalPr(input: MergeGoalPrInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const goal = await new GoalStore(input.cwd).get(input.goalId);
    if (goal.status !== 'awaiting_merge' || goal.completion === undefined) throw new Error('Goal is not awaiting a merge');
    if (goal.pullRequest?.number !== input.prNumber) throw new Error('PR number does not match the saved goal PR');
    return mergeGoalPr(input.cwd, input.prNumber, goal.branch, goal.completion.goalSha, signal);
  }, 'Goal PR merge failed', 'merge_pr');
}

export function checkTaktGoalCompletion(input: GoalIdentityInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge) => integrationSummary(await checkGoalCompletion(input.cwd, input.goalId, signal, policy)), 'Goal integration failed', 'check_completion');
}

export function reopenTaktGoal(input: ReopenGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => integrationSummary(await reopenGoal(
    input.cwd, input.goalId, input.reason, signal,
  )), 'Goal reopen failed', 'reopen');
}
