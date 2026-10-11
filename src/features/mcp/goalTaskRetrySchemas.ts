import { z } from 'zod/v4';
import { enqueueGoalTaskInputSchema, goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

export const requeueGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  retryNote: enqueueGoalTaskInputSchema.shape.task.optional()
    .describe('Additional instruction passed as a note when resuming the stopped task.'),
});

export const retryGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  task: enqueueGoalTaskInputSchema.shape.task
    .describe('Corrected full instructions saved to the canonical task order.'),
  startStep: z.string().trim().min(1).max(1024).optional()
    .describe('Authored root step to restart from. Omission uses the existing retry default.'),
});

export type RequeueGoalTaskInput = z.infer<typeof requeueGoalTaskInputSchema>;
export type RetryGoalTaskInput = z.infer<typeof retryGoalTaskInputSchema>;
