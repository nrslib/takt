import { z } from 'zod/v4';
import { goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

export const stopGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
  executionId: z.string().min(1).describe('Execution ID returned by takt_list_tasks for the running task.'),
});

export type StopGoalTaskInput = z.infer<typeof stopGoalTaskInputSchema>;
