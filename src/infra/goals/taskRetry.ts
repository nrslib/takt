import { z } from 'zod/v4';
import type { Goal } from './schema.js';

export const GoalTaskRetryRecordSchema = z.object({
  kind: z.enum(['requeue', 'retry']),
  recordedAt: z.iso.datetime(),
  operationId: z.string().min(1).optional(),
}).strict();

export function recordGoalTaskRetry(
  goal: Goal, taskName: string, record: z.infer<typeof GoalTaskRetryRecordSchema>,
): Goal {
  if (!goal.workUnits?.some((unit) => unit.taskName === taskName)) {
    throw new Error('Task has no work unit in this goal');
  }
  return {
    ...goal,
    workUnits: goal.workUnits.map((unit) => {
      if (unit.taskName !== taskName
        || (record.operationId !== undefined && unit.retries?.some((saved) => saved.operationId === record.operationId))) {
        return unit;
      }
      return { ...unit, retries: [...(unit.retries ?? []), record] };
    }),
  };
}
