import { z } from 'zod/v4';
import { enqueueGoalTaskInputSchema, goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

export const removeGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  discardUnmerged: z.boolean().optional().describe('Explicitly discard a completed result that has not been integrated into its goal. Omission does not discard it.'),
  reason: enqueueGoalTaskInputSchema.shape.task
    .describe('Required reason for cancelling pending work, cleaning up stopped or integrated work, or explicitly discarding an unintegrated completed result.'),
});

export type RemoveGoalTaskInput = z.infer<typeof removeGoalTaskInputSchema>;
