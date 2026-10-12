import { z } from 'zod/v4';
import { enqueueGoalTaskInputSchema, goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

export const removeGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  reason: enqueueGoalTaskInputSchema.shape.task
    .describe('Required reason for cancelling pending work or cleaning up stopped or integrated work.'),
});

export type RemoveGoalTaskInput = z.infer<typeof removeGoalTaskInputSchema>;
