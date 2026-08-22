import { z } from 'zod/v4';
import { buildTaskSchema } from './taskConfigSerialization.js';
import { getLocalBranchNameError } from '../../shared/utils/gitBranchValidation.js';
import { parseWorkflowResumePoint } from '../../core/workflow/resume-point-codec.js';
import { WorkflowRestartPointSchema } from '../../core/models/workflow-resume-schema.js';

const positiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: 'Expected a positive safe integer' },
);

const WorkflowResumePointCodecSchema = z.unknown().transform((value, ctx) => {
  try {
    return parseWorkflowResumePoint(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});

export const TASK_RESTART_POINT_KEY = 'restart_point' as const;
export const TaskExecutionConfigObjectSchema = z.object({
  worktree: z.union([z.boolean(), z.string()]).optional(),
  branch: z.string().optional(),
  base_branch: z.string().optional(),
  workflow: z.string().optional(),
  issue: positiveSafeIntegerSchema.optional(),
  start_step: z.string().optional(),
  retry_note: z.string().optional(),
  auto_pr: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
  managed_pr: z.boolean().optional(),
  should_publish_branch_to_origin: z.boolean().optional(),
  exceeded_max_steps: z.number().int().positive().optional(),
  exceeded_current_iteration: z.number().int().min(0).optional(),
  source: z.enum(['pr_review', 'issue', 'manual']).optional(),
  pr_number: positiveSafeIntegerSchema.optional(),
  context_pr_number: positiveSafeIntegerSchema.optional(),
  resume_point: WorkflowResumePointCodecSchema.optional(),
  [TASK_RESTART_POINT_KEY]: WorkflowRestartPointSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.resume_point !== undefined && data[TASK_RESTART_POINT_KEY] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'resume_point and restart_point cannot be specified together',
      path: [TASK_RESTART_POINT_KEY],
    });
  }
  if (data.start_step !== undefined && data[TASK_RESTART_POINT_KEY] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'start_step and restart_point cannot be specified together',
      path: [TASK_RESTART_POINT_KEY],
    });
  }
  if (data.exceeded_current_iteration !== undefined && data[TASK_RESTART_POINT_KEY] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exceeded_current_iteration and restart_point cannot be specified together',
      path: [TASK_RESTART_POINT_KEY],
    });
  }
  if (data.exceeded_max_steps !== undefined && data[TASK_RESTART_POINT_KEY] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exceeded_max_steps and restart_point cannot be specified together',
      path: [TASK_RESTART_POINT_KEY],
    });
  }
  if (data.source === 'pr_review' && data.pr_number === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pr_number is required when source is "pr_review"',
      path: ['pr_number'],
    });
  }
  if (data.source === 'pr_review' && data.branch === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'branch is required when source is "pr_review"',
      path: ['branch'],
    });
  }
  const branchError = data.branch === undefined ? undefined : getLocalBranchNameError(data.branch);
  if (data.source === 'pr_review' && branchError !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: branchError,
      path: ['branch'],
    });
  }
  const baseBranchError = data.base_branch === undefined
    ? undefined
    : getLocalBranchNameError(data.base_branch);
  if (data.source === 'pr_review' && baseBranchError !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: baseBranchError,
      path: ['base_branch'],
    });
  }
  if (data.managed_pr === true && data.auto_pr !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'managed_pr requires auto_pr to be true',
      path: ['auto_pr'],
    });
  }
  if (data.managed_pr === true && !data.worktree) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'managed_pr requires worktree to be enabled',
      path: ['worktree'],
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
