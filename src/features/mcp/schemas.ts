import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import {
  isValidTaskContextBranchName,
  isValidTaskContextPrNumber,
} from '../tasks/taskContextValidation.js';

const absolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: 'cwd must be an absolute path',
});

const taskContentSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'task is required',
});
const workflowSchema = z.string().trim().min(1).optional();
const worktreeSchema = z.boolean().optional();
const branchSchema = z.string().refine(isValidTaskContextBranchName, {
  message: 'branch must be a valid local branch name',
});
const prNumberSchema = z.number().refine(isValidTaskContextPrNumber, {
  message: 'prNumber must be a positive integer',
});

const taskContextSchema = z.object({
  branch: branchSchema.optional(),
  baseBranch: branchSchema.optional(),
  prNumber: prNumberSchema.optional(),
}).strict().optional();

const taskSaveOptionsSchema = z.object({
  cwd: absolutePathSchema,
  task: taskContentSchema,
  workflow: workflowSchema,
  worktree: worktreeSchema,
  autoPr: z.boolean().optional(),
  taskContext: taskContextSchema,
}).strict();

export const enqueueTaskInputSchema = taskSaveOptionsSchema;

export const createIssueAndEnqueueTaskInputSchema = taskSaveOptionsSchema.extend({
  labels: z.array(z.string().trim().min(1)).optional(),
}).strict();

export const runNextTaskInputSchema = z.object({
  cwd: absolutePathSchema,
  provider: z.enum(PROVIDER_TYPES).optional(),
  model: z.string().trim().min(1).optional(),
  taskContext: taskContextSchema,
}).strict();

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export type CreateIssueAndEnqueueTaskInput = z.infer<typeof createIssueAndEnqueueTaskInputSchema>;
export type RunNextTaskInput = z.infer<typeof runNextTaskInputSchema>;
