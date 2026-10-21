import { setGoalExecutionStatus } from '../../infra/goals/execution.js';
import type { Goal } from '../../infra/goals/schema.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { ensureDaemon } from '../daemon/lifecycle.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { abortGoalInputSchema, goalWriteInputSchema, type AbortGoalInput, type GoalIdentityInput } from './schemas.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';

async function changeGoalExecution(
  input: GoalIdentityInput | AbortGoalInput,
  executionStatus: Goal['executionStatus'],
  deps: McpOperationDependencies,
  signal: AbortSignal,
) {
  try {
    const parsed = executionStatus === 'aborted' ? abortGoalInputSchema.parse(input) : goalWriteInputSchema.parse(input);
    assertCwdAllowedByMcpRoot(parsed.cwd, deps.allowedProjectRoot);
    signal.throwIfAborted();
    const goal = await setGoalExecutionStatus(parsed.cwd, parsed.goalId, executionStatus, signal);
    if (executionStatus === 'aborted') new TaskRunner(parsed.cwd).invalidatePendingGoalTasks(goal.id);
    if (executionStatus === 'active') {
      signal.throwIfAborted();
      await ensureDaemon();
      signal.throwIfAborted();
      await ensureManagerRun(parsed.cwd);
    }
    return jsonResult({ goalId: goal.id, executionStatus: goal.executionStatus });
  } catch (error) { return errorResult('Goal execution change failed', error); }
}

export function pauseTaktGoal(input: GoalIdentityInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return changeGoalExecution(input, 'paused', deps, signal);
}

export function resumeTaktGoal(input: GoalIdentityInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return changeGoalExecution(input, 'active', deps, signal);
}

export function abortTaktGoal(input: AbortGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return changeGoalExecution(input, 'aborted', deps, signal);
}
