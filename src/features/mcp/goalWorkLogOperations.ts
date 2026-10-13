import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { GoalWorkLogInputSchema } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { withGoalWrites } from '../../infra/goals/operations.js';
import type { z } from 'zod/v4';
import type { recordGoalWorkLogInputSchema, listGoalRecordsInputSchema } from './schemas.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';

export async function recordTaktGoalWorkLog(
  input: z.infer<typeof recordGoalWorkLogInputSchema>, deps: McpOperationDependencies, signal: AbortSignal,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    if (deps.goalEventContext !== undefined && deps.goalEventContext.goalId !== input.goalId) {
      throw new Error('Work log does not belong to the current goal');
    }
    return await withGoalTurns(input.cwd, [input.goalId], () => withGoalWrites(input.cwd, input.goalId, async () => {
      signal.throwIfAborted();
      const entry = GoalWorkLogInputSchema.strip().parse(input);
      const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => appendGoalWorkLog(current, entry));
      return jsonResult({ workLog: goal.workLog });
    }), deps.goalTurnOwners, signal);
  } catch (error) { return errorResult('Goal work log failed', error); }
}

export async function listTaktGoalRecords(
  input: z.infer<typeof listGoalRecordsInputSchema>, deps: McpOperationDependencies, kind: 'workLog' | 'operations',
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const goal = await new GoalStore(input.cwd).get(input.goalId);
    if (kind === 'workLog') return jsonResult({ workLog: goal.workLog });
    const context = deps.goalEventContext;
    const eventId = input.eventId ?? (context?.goalId === input.goalId ? context.eventId : undefined);
    return jsonResult({ operations: (goal.operations ?? []).filter((operation) => eventId === undefined || operation.eventId === eventId) });
  } catch (error) { return errorResult('Goal record read failed', error); }
}
