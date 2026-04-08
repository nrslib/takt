import { z } from 'zod/v4';
import { buildTaskSchema } from './taskConfigSerialization.js';

export const TaskExecutionConfigObjectSchema = z.object({
  worktree: z.union([z.boolean(), z.string()]).optional(),
  branch: z.string().optional(),
  base_branch: z.string().optional(),
  workflow: z.string().optional(),
  issue: z.number().int().positive().optional(),
  start_step: z.string().optional(),
  retry_note: z.string().optional(),
  auto_pr: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
  should_publish_branch_to_origin: z.boolean().optional(),
  exceeded_max_steps: z.number().int().positive().optional(),
  exceeded_current_iteration: z.number().int().min(0).optional(),
  source: z.enum(['pr_review', 'issue', 'manual']).optional(),
  pr_number: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (data.source === 'pr_review' && data.pr_number === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pr_number is required when source is "pr_review"',
      path: ['pr_number'],
    });
  }
}).strict();

export const TaskExecutionConfigSchema = buildTaskSchema(TaskExecutionConfigObjectSchema);

export const TaskFileSchema = buildTaskSchema(
  TaskExecutionConfigObjectSchema.extend({
    task: z.string().min(1),
  }),
);

export type TaskFileData = z.infer<typeof TaskFileSchema>;
