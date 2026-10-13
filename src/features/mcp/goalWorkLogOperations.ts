import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { GoalWorkLogInputSchema } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { z } from 'zod/v4';
import type { recordGoalWorkLogInputSchema, listGoalRecordsInputSchema } from './schemas.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';

export async function recordTaktGoalWorkLog(
  input: z.infer<typeof recordGoalWorkLogInputSchema>, deps: McpOperationDependencies, signal: AbortSignal,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    signal.throwIfAborted();
    const entry = GoalWorkLogInputSchema.strip().parse(input);
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => appendGoalWorkLog(current, entry));
    return jsonResult({ workLog: goal.workLog });
  } catch (error) { return errorResult('Goal work log failed', error); }
}

export async function listTaktGoalRecords(
  input: z.infer<typeof listGoalRecordsInputSchema>, deps: McpOperationDependencies,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const goal = await new GoalStore(input.cwd).get(input.goalId);
    return jsonResult({ workLog: goal.workLog });
  } catch (error) { return errorResult('Goal record read failed', error); }
}
