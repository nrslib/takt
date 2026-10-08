import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { isValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';

const goalText = z.string().max(128 * 1024).refine((value) => value.trim().length > 0);
const goalBranch = z.string().refine(isValidLocalBranchName);
export const GoalIdSchema = z.uuid();

export const GoalTaskResultSchema = z.object({
  success: z.boolean(),
  interrupted: z.boolean(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  shaUnavailableReason: z.string().optional(),
  failureReason: z.string().optional(),
  workflowResult: z.enum(['completed', 'aborted', 'exceeded', 'error']).optional(),
}).strict();
export type GoalTaskResult = z.infer<typeof GoalTaskResultSchema>;

const summaryShape = {
  objective: goalText,
  outOfScope: z.array(goalText),
  acceptanceCriteria: z.array(goalText).min(1),
  creationOrigin: z.enum(['human', 'director']),
};

const confirmationShape = {
  confirmedAt: z.iso.datetime(),
  confirmedBy: goalText,
};

const GoalSummarySchema = z.object({
  ...summaryShape,
  startBranch: goalBranch.optional(),
  integrationBranch: goalBranch.optional(),
}).strict();

const SignedGoalConfirmationSchema = z.object({
  payload: z.string().min(1).max(512 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128),
}).strict();

export const GoalConfirmationPayloadSchema = GoalSummarySchema.extend({
  id: GoalIdSchema,
  projectRoot: z.string().refine(isAbsolute),
  ...confirmationShape,
});

export const GoalCreateInputSchema = GoalSummarySchema.extend({
  cwd: z.string().refine(isAbsolute),
  confirmation: SignedGoalConfirmationSchema,
});

const goalSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const GoalMergeRecordSchema = z.object({
  sourceBranch: goalBranch,
  expectedSha: goalSha,
  status: z.enum(['merged', 'conflict', 'checked_out']),
  goalSha: goalSha.optional(),
  conflicts: z.array(z.string()).optional(),
  worktrees: z.array(z.string()).optional(),
  recordedAt: z.iso.datetime(),
}).strict();

const GoalCompletionSchema = z.object({
  goalBranch: goalBranch,
  goalSha,
  targetBranch: goalBranch,
  summary: goalText,
  changeSummary: z.object({
    filesChanged: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(z.object({
      path: z.string(),
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
    }).strict()).max(50),
    truncated: z.boolean(),
    totalsTruncated: z.boolean(),
  }).strict(),
  instructions: z.array(z.string()),
  reason: z.string().optional(),
  worktrees: z.array(z.string()).optional(),
  targetSha: goalSha.optional(),
}).strict();

export const GoalSchema = z.object({
  id: GoalIdSchema,
  ...summaryShape,
  mode: z.literal('local'),
  status: z.enum(['created', 'awaiting_merge', 'completed']),
  branch: goalBranch,
  startBranch: goalBranch,
  integrationBranch: goalBranch,
  confirmation: z.object(confirmationShape).strict(),
  workUnits: z.array(z.object({
    taskName: z.string().min(1), purpose: goalText, integration: GoalMergeRecordSchema.optional(),
  }).strict()).optional(),
  completion: GoalCompletionSchema.optional(),
  events: z.array(z.object({
    taskName: z.string().min(1), runSlug: z.string().min(1),
    result: GoalTaskResultSchema, processed: z.boolean(), summary: z.string().optional(),
  }).strict()).optional(),
  sessions: z.array(z.object({ provider: z.string(), sessionId: z.string().min(1) }).strict()).optional(),
  decisions: z.array(z.object({
    decision: z.enum(['integrate', 'complete']), reason: goalText, recordedAt: z.iso.datetime(),
  }).strict()).optional(),
}).strict().superRefine((goal, ctx) => {
  if (goal.status !== 'created' && goal.completion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion'], message: 'Completion evidence is required' });
  }
  if (goal.status === 'completed' && goal.completion?.targetSha === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion', 'targetSha'], message: 'Integrated target SHA is required' });
  }
});

export type Goal = z.infer<typeof GoalSchema>;
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;
