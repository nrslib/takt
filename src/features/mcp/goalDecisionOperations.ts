import { appendGoalDecision } from '../../infra/goals/decisions.js';
import { GoalDecisionInputSchema, type Goal } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { withGoalWrites } from '../../infra/goals/operations.js';
import { join } from 'node:path';
import type { z } from 'zod/v4';
import type { recordGoalDecisionInputSchema, listGoalRecordsInputSchema } from './schemas.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';

export async function recordTaktGoalDecision(
  input: z.infer<typeof recordGoalDecisionInputSchema>, deps: McpOperationDependencies, signal: AbortSignal,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    if (deps.goalEventContext !== undefined && (deps.goalEventContext.goalId !== input.goalId || deps.goalEventContext.eventId !== input.eventId)) {
      throw new Error('Decision does not belong to the current event');
    }
    return await withGoalTurns(input.cwd, [input.goalId], () => withGoalWrites(input.cwd, input.goalId, async () => {
      const decision = GoalDecisionInputSchema.strip().parse(input);
      let recorded: NonNullable<Goal['decisions']>[number] | undefined;
      await new GoalStore(input.cwd).update(input.goalId, (current) => {
        const result = appendGoalDecision(current, decision);
        recorded = result.decision;
        return result.goal;
      });
      return jsonResult({ decision: recorded });
    }), deps.goalTurnOwners, signal);
  } catch (error) { return errorResult('Goal decision failed', error); }
}

export async function listTaktGoalRecords(
  input: z.infer<typeof listGoalRecordsInputSchema>, deps: McpOperationDependencies, kind: 'decisions' | 'operations',
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const eventId = input.eventId ?? (kind === 'operations' ? deps.goalEventContext?.eventId : undefined);
    const { records: page, ...info } = await new GoalStore(input.cwd).readRecordPage(
      input.goalId, kind, eventId, input.offset, input.limit, 48 * 1024,
    );
    return jsonResult({ [kind]: page, ...info, source: join(input.cwd, '.takt', 'goals', input.goalId, 'goal.json'),
      ...(info.oversized ? { instruction: `Read ${kind}[recordIndex] from the source file; continue at offset + 1.` } : {}) });
  } catch (error) { return errorResult('Goal record read failed', error); }
}
