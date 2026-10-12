import { z } from 'zod/v4';
import { enqueueGoalTaskInputSchema, goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

const startStepSchema = z.string().trim().min(1).max(1024).optional()
  .describe('Position to restart from: a root step name, or a nested position written as step names joined by " > ".'
    + ' Omission resumes from the saved resume position, or from the default start when none is saved;'
    + ' when the saved resume position cannot be used, the call fails with the reason and the accepted startStep values.');

export const requeueGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  retryNote: enqueueGoalTaskInputSchema.shape.task.optional()
    .describe('Additional instruction passed as a note when resuming the stopped task.'),
  startStep: startStepSchema,
});

export const retryGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  task: enqueueGoalTaskInputSchema.shape.task
    .describe('Corrected full instructions saved to the canonical task order.'),
  startStep: startStepSchema,
});

export type RequeueGoalTaskInput = z.infer<typeof requeueGoalTaskInputSchema>;
export type RetryGoalTaskInput = z.infer<typeof retryGoalTaskInputSchema>;
