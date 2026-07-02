import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import {
  isValidTaskContextBranchName,
  isValidTaskContextPrNumber,
} from '../tasks/taskContextValidation.js';

const absolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: 'cwd must be an absolute path',
}).describe('Absolute path to the TAKT project where .takt/tasks.yaml is read or written.');

const taskContentSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'task is required',
}).describe('Task body to save as a pending TAKT task. Boundary whitespace is preserved.');
const workflowSchema = z.string().trim().min(1)
  .describe('Workflow identifier to store on the queued task. Defaults to the TAKT default workflow.')
  .optional();
const worktreeSchema = z.boolean()
  .describe('Whether the queued task should run in a TAKT-managed worktree.')
  .optional();
const branchSchema = z.string().refine(isValidTaskContextBranchName, {
  message: 'branch must be a valid local branch name',
}).describe('Plain local Git branch name for task execution context.');
const prNumberSchema = z.number().refine(isValidTaskContextPrNumber, {
  message: 'prNumber must be a positive safe integer',
}).describe('PR number used as task execution context, not as PR-review provenance.');

const taskContextSchema = z.object({
  branch: branchSchema.optional(),
  baseBranch: branchSchema.optional(),
  prNumber: prNumberSchema.optional(),
}).strict()
  .describe('Optional Git context to pass to the queued or executed task without changing task provenance.')
  .optional();

const taskSaveOptionsSchema = z.object({
  cwd: absolutePathSchema,
  task: taskContentSchema,
  workflow: workflowSchema,
  worktree: worktreeSchema,
  autoPr: z.boolean()
    .describe('Whether successful worktree execution should automatically open a pull request.')
    .optional(),
  taskContext: taskContextSchema,
}).strict();

export const enqueueTaskInputSchema = taskSaveOptionsSchema;

export const createIssueAndEnqueueTaskInputSchema = taskSaveOptionsSchema.extend({
  labels: z.array(z.string().trim().min(1))
    .describe('Issue labels to request from the configured issue provider.')
    .optional(),
}).strict();

export const runNextTaskInputSchema = z.object({
  cwd: absolutePathSchema,
  provider: z.enum(PROVIDER_TYPES)
    .describe('Agent provider override for this task execution.')
    .optional(),
  model: z.string().trim().min(1)
    .describe('Model override for this task execution.')
    .optional(),
  taskContext: taskContextSchema,
}).strict();

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export type CreateIssueAndEnqueueTaskInput = z.infer<typeof createIssueAndEnqueueTaskInputSchema>;
export type RunNextTaskInput = z.infer<typeof runNextTaskInputSchema>;
