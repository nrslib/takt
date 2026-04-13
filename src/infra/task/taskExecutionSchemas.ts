import { z } from 'zod/v4';
import { buildTaskSchema } from './taskConfigSerialization.js';

const ResumePointEntrySchema = z.object({
  workflow: z.string().min(1),
  workflow_ref: z.string().min(1).optional(),
  step: z.string().min(1),
  kind: z.enum(['agent', 'system', 'workflow_call']),
}).strict();

const ResumePointSchema = z.object({
  version: z.literal(1),
  stack: z.array(ResumePointEntrySchema).min(1),
  iteration: z.number().int().min(0),
  elapsed_ms: z.number().int().min(0),
}).strict();

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
  resume_point: ResumePointSchema.optional(),
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
