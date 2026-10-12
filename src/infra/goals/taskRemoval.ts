import { z } from 'zod/v4';
import type { Goal, GoalOperation } from './schema.js';

export const GoalTaskRemovalRecordSchema = z.object({
  kind: z.enum(['cancel', 'cleanup']),
  reason: z.string().max(128 * 1024).refine((value) => value.trim().length > 0),
  recordedAt: z.iso.datetime(),
  operationId: z.string().min(1),
}).strict();

const GoalTaskRemovalRecoverySchema = z.object({
  goalId: z.string().min(1),
  taskName: z.string().min(1),
  taskStatus: z.enum(['pending', 'completed', 'failed', 'exceeded', 'pr_failed']),
  resources: z.object({ branch: z.string().optional(), worktreePath: z.string().optional() }).strict(),
  result: z.object({ taskName: z.string().min(1), tasksFile: z.string(), status: z.literal('removed') }).strict(),
  record: GoalTaskRemovalRecordSchema,
}).strict();

export type GoalTaskRemovalRecovery = z.infer<typeof GoalTaskRemovalRecoverySchema>;

function matchesRemovalOperation(goal: Goal, operation: GoalOperation, recovery: GoalTaskRemovalRecovery): boolean {
  return recovery.goalId === goal.id && recovery.taskName === operation.arguments.taskName
    && recovery.result.taskName === recovery.taskName && recovery.record.operationId === operation.id
    && recovery.record.reason === operation.arguments.reason && recovery.record.recordedAt === operation.recordedAt;
}

export function readGoalTaskRemovalRecovery(goal: Goal, operation: GoalOperation): GoalTaskRemovalRecovery {
  const recovery = GoalTaskRemovalRecoverySchema.parse(operation.recovery);
  if (!matchesRemovalOperation(goal, operation, recovery)) {
    throw new Error('Removal recovery does not match this operation');
  }
  return recovery;
}

export function hasPendingGoalTaskRemoval(goal: Goal, taskName: string): boolean {
  if (!goal.workUnits?.some((unit) => unit.taskName === taskName)) return false;
  return goal.operations?.some((operation) => {
    if (operation.tool !== 'remove' || operation.status !== 'pending') return false;
    const parsed = GoalTaskRemovalRecoverySchema.safeParse(operation.recovery);
    return parsed.success && parsed.data.taskStatus === 'pending' && parsed.data.taskName === taskName
      && matchesRemovalOperation(goal, operation, parsed.data);
  }) === true;
}

export function recordGoalTaskRemoval(
  goal: Goal, taskName: string, record: z.infer<typeof GoalTaskRemovalRecordSchema>,
): Goal {
  if (!goal.workUnits?.some((unit) => unit.taskName === taskName)) {
    throw new Error('Task has no work unit in this goal');
  }
  return {
    ...goal,
    workUnits: goal.workUnits.map((unit) => unit.taskName !== taskName
      || unit.removals?.some((saved) => saved.operationId === record.operationId)
      ? unit : { ...unit, removals: [...(unit.removals ?? []), record] }),
  };
}
