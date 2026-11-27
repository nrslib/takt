import { randomUUID } from 'node:crypto';
import { GoalWorkLogInputSchema, type Goal } from './schema.js';
import type { z } from 'zod/v4';

export function appendGoalWorkLog(goal: Goal, raw: z.infer<typeof GoalWorkLogInputSchema>): Goal {
  const input = GoalWorkLogInputSchema.parse(raw);
  const record = { ...input, id: randomUUID(), recordedAt: new Date().toISOString() };
  return { ...goal, workLog: [...goal.workLog, record] };
}
