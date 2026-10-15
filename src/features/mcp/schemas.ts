import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { GoalIdSchema, GoalQuestionInputSchema, GoalNotificationInputSchema, GoalWorkLogInputSchema } from '../../infra/goals/schema.js';
import { MCP_TEXT_PAGE_BYTES } from './response.js';
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
  .describe('Whether the queued task should run in a TAKT-managed worktree. Omission saves true. When true, successful execution attempts to auto-commit resulting changes locally; autoPr false does not disable that.');
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
  draftPr: z.boolean().optional()
    .describe('Whether an automatically created pull request should be a draft. Explicit true or false is saved and overrides project and global draft_pr settings. Omission saves no draft_pr value and preserves configuration inheritance. The success result echoes the saved value, or null when omitted. This setting is saved even when autoPr is false.'),
  issue: issueSchema.optional(),
  taskContext: taskContextSchema,
}).strict();

export const enqueueTaskInputSchema = taskSaveOptionsSchema;

const goalReadLimitSchema = z.number().int().min(1).max(50).optional();
const readOffsetSchema = z.number().int().safe().nonnegative().optional();
const textReadShape = {
  textOffset: readOffsetSchema.describe('UTF-8 byte offset into the selected string.'),
  maxBytes: z.number().int().min(4).max(MCP_TEXT_PAGE_BYTES).optional().describe('Maximum UTF-8 text bytes, up to 4096; the complete response is bounded to 64 KiB.'),
};
const goalIdentityInputSchema = z.object({
  cwd: absolutePathSchema.describe('Absolute path to the TAKT project where goals are stored in .takt/goals/.'),
}).strict();
export const listGoalsInputSchema = goalIdentityInputSchema.extend({
  limit: goalReadLimitSchema,
  offset: readOffsetSchema,
  errorOffset: readOffsetSchema.describe('Offset into individual saved-record errors; independent of the healthy goal offset.'),
});
export const goalWriteInputSchema = goalIdentityInputSchema.extend({ goalId: GoalIdSchema });
export const getGoalInputSchema = goalWriteInputSchema.extend({
  path: z.string().max(512).regex(/^(objective|outOfScope|acceptanceCriteria|constraints|completion|questions|workLog|notifications)(\.(\d+|body|summary|recommendation|answer|text|options|instructions|reason|changeSummary|files|path|worktrees))*$/).optional()
    .describe('Saved field path, for example workLog.0.summary or completion.summary. Array indices refer to saved order.'),
  recordId: z.uuid().optional().describe('Select a saved record by ID when path selects questions, workLog or notifications.'),
  limit: goalReadLimitSchema, offset: readOffsetSchema, ...textReadShape,
});
export const recordGoalWorkLogInputSchema = goalWriteInputSchema.extend(GoalWorkLogInputSchema.shape);
export const listGoalRecordsInputSchema = goalWriteInputSchema.extend({ limit: goalReadLimitSchema, offset: readOffsetSchema });
export const enqueueGoalTaskInputSchema = goalWriteInputSchema.extend({
  workKey: z.string().min(1).max(MCP_TASK_MAX_LENGTH).refine((value) => value.trim().length > 0).optional()
    .describe('Stable work key used to find work already submitted to this goal.'),
  purpose: taskContentSchema.describe('Purpose of this ready work unit within the goal.'),
  task: taskContentSchema.describe('Self-contained instructions for ready goal work. Do not request merging.'),
  workflow: workflowSchema.describe('Workflow selected by the manager using takt_list_workflows names and descriptions.'),
});
export const askGoalQuestionInputSchema = goalWriteInputSchema.extend(GoalQuestionInputSchema.shape);
export const getGoalQuestionInputSchema = goalWriteInputSchema.extend({ questionId: z.uuid(),
  path: z.string().regex(/^(body|recommendation|answer\.text|options\.\d+)$/).optional(), ...textReadShape });
export const listGoalQuestionsInputSchema = goalWriteInputSchema.extend({ limit: goalReadLimitSchema, offset: readOffsetSchema });
export const withdrawGoalQuestionInputSchema = goalWriteInputSchema.extend({ questionId: z.uuid() });
export const notifyGoalInputSchema = goalWriteInputSchema.extend({
  ...GoalNotificationInputSchema.shape, kind: z.enum(['blocked', 'custom']),
});
export type AskGoalQuestionInput = z.input<typeof askGoalQuestionInputSchema>;
export type GetGoalQuestionInput = z.infer<typeof getGoalQuestionInputSchema>;
export type NotifyGoalInput = z.infer<typeof notifyGoalInputSchema>;
const reviewedShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const goalTaskNameSchema = z.string().min(1).max(1024);
export const mergeGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: goalTaskNameSchema, expectedSha: reviewedShaSchema,
});
export const completeGoalInputSchema = goalWriteInputSchema.extend({
  expectedSha: reviewedShaSchema, summary: taskContentSchema.describe('Satisfied acceptance criteria and their supporting evidence.'),
});
export const goalDiffInputSchema = goalWriteInputSchema.extend({
  taskName: goalTaskNameSchema.optional(), file: z.string().min(1).max(4096).refine((value) => !value.includes('\0')).optional(),
  limit: goalReadLimitSchema,
});
export const goalHistoryInputSchema = goalWriteInputSchema.extend({
  taskName: goalTaskNameSchema.optional(), limit: goalReadLimitSchema,
});
export type EnqueueGoalTaskInput = z.infer<typeof enqueueGoalTaskInputSchema>;
export type MergeGoalTaskInput = z.infer<typeof mergeGoalTaskInputSchema>;
export type CompleteGoalInput = z.infer<typeof completeGoalInputSchema>;
export type GoalDiffInput = z.infer<typeof goalDiffInputSchema>;
export type GoalHistoryInput = z.infer<typeof goalHistoryInputSchema>;
export type ListGoalsInput = z.infer<typeof listGoalsInputSchema>;
export type GetGoalInput = z.infer<typeof getGoalInputSchema>;
export type GoalIdentityInput = z.infer<typeof goalWriteInputSchema>;

export const listTasksInputSchema = z.object({
  cwd: absolutePathSchema,
  view: z.literal('workspace').optional().describe('Manager only: read the current assigned workspace. cwd is validated as an absolute path but does not select the workspace.'),
  limit: goalReadLimitSchema, offset: readOffsetSchema,
  path: z.string().max(512).regex(/^(name|repositoryDirectories\.\d+)$/).optional()
    .describe('Workspace string to read; repository indices refer to saved order.'),
  ...textReadShape,
}).strict();

export const getRunInputSchema = z.object({
  cwd: absolutePathSchema,
  runSlug: z.string().trim().min(1).max(255),
  view: z.enum(['summary', 'log', 'report', 'instructions', 'task']).optional(),
  instructionId: z.number().int().safe().positive().optional()
    .describe('Saved instruction ID from tell or the instructions list; requires view instructions. Omit to list instructions.'),
  stepIndex: z.number().int().safe().nonnegative().optional().describe('Index from stepLogs; omission selects the last completed step.'),
  report: z.string().min(1).max(4096).refine((value) => !value.includes('\0')).optional().describe('Relative filename from the report list; required for view report.'),
  limit: goalReadLimitSchema,
  offset: readOffsetSchema.describe('List offset, bytes skipped backwards from the log end, or forward UTF-8 bytes in task text, a report or selected instruction.'),
  maxBytes: textReadShape.maxBytes,
}).strict().refine((input) => input.instructionId === undefined || input.view === 'instructions', {
  message: 'instructionId requires view instructions',
  path: ['instructionId'],
});

export const tellRunInputSchema = z.object({
  cwd: absolutePathSchema,
  runSlug: z.string().trim().min(1).max(255),
  content: z.string().max(MCP_TASK_MAX_LENGTH).refine((value) => value.trim().length > 0, {
    message: 'content is required',
  }).describe('Additional instruction to deliver to the selected running clone task.'),
}).strict();

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;
export type GetRunInput = z.infer<typeof getRunInputSchema>;
export type TellRunInput = z.infer<typeof tellRunInputSchema>;
