import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import {
  isValidTaskContextBranchName,
  isValidTaskContextPrNumber,
} from '../tasks/taskContextValidation.js';

const MCP_TASK_MAX_LENGTH = 128 * 1024;
const MCP_WORKFLOW_MAX_LENGTH = 128;
const MCP_ISSUE_TITLE_MAX_LENGTH = 255;
const MCP_LABEL_MAX_LENGTH = 100;
const MCP_LABEL_MAX_COUNT = 20;

const absolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: 'cwd must be an absolute path',
}).describe('Absolute path to the TAKT project where .takt/tasks.yaml is read or written.');

const taskContentSchema = z.string().max(MCP_TASK_MAX_LENGTH).refine((value) => value.trim().length > 0, {
  message: 'task is required',
}).describe('Task body to save as a pending TAKT task. Boundary whitespace is preserved.');
const workflowSchema = z.string().trim().min(1).max(MCP_WORKFLOW_MAX_LENGTH)
  .describe('Workflow identifier to store on the queued task. Ask the user which workflow to use before enqueueing.');
const worktreeSchema = z.boolean()
  .optional()
  .describe('Whether the queued task should run in a TAKT-managed worktree. When true, successful execution attempts to auto-commit resulting changes locally; autoPr false does not disable that.');
const branchSchema = z.string().refine(isValidTaskContextBranchName, {
  message: 'branch must be a valid local branch name',
}).describe('Plain local Git branch name for task execution context.');
const prNumberSchema = z.number().refine(isValidTaskContextPrNumber, {
  message: 'prNumber must be a positive safe integer',
}).describe('PR number used as task execution context, not as PR-review provenance.');

const taskContextSchema = z.object({
  branch: branchSchema.optional().describe('Plain local Git branch name for task execution context.'),
  baseBranch: branchSchema.optional().describe('Plain local Git base branch name used when creating or resolving a task worktree.'),
  prNumber: prNumberSchema.optional().describe('PR number used as task execution context, not as PR-review provenance.'),
}).strict()
  .optional()
  .describe('Optional Git context to pass to the queued or executed task without changing task provenance.');

const issueNumberSchema = z.number().int().safe().positive({
  message: 'issue number must be a positive safe integer',
});
const issueTitleSchema = z.string().trim().min(1).max(MCP_ISSUE_TITLE_MAX_LENGTH);
const issueLabelsSchema = z.array(z.string().trim().min(1).max(MCP_LABEL_MAX_LENGTH))
  .max(MCP_LABEL_MAX_COUNT);
const issueSchema = z.union([
  z.object({ number: issueNumberSchema }).strict(),
  z.object({
    create: z.literal(true),
    title: issueTitleSchema.optional(),
    labels: issueLabelsSchema.optional(),
  }).strict(),
]).describe('Optional issue linkage. Provide either an existing issue number or create settings.');

const taskSaveOptionsSchema = z.object({
  cwd: absolutePathSchema,
  task: taskContentSchema,
  workflow: workflowSchema,
  worktree: worktreeSchema,
  autoPr: z.boolean()
    .describe('Whether successful worktree execution should push the branch and automatically open a pull request. Ask the user before enqueueing; do not infer this from branch or PR context. When false, worktree execution may still auto-commit local changes.'),
  issue: issueSchema.optional(),
  taskContext: taskContextSchema,
}).strict();

export const enqueueTaskInputSchema = taskSaveOptionsSchema;

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
