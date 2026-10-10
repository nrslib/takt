import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { isValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import { MANAGER_NOTIFICATION_KINDS } from '../../core/models/config-types.js';

const goalText = z.string().max(128 * 1024).refine((value) => value.trim().length > 0);
const goalBranch = z.string().refine(isValidLocalBranchName);
export const GoalIdSchema = z.uuid();
export const GoalQuestionInputSchema = z.object({
  recipient: z.enum(['human', 'director']).default('human'),
  body: goalText,
  options: z.array(goalText).min(1).optional(),
  recommendation: goalText.optional(),
  dependentWorkKeys: z.array(goalText).optional(),
}).strict();
export const GoalAnswerSchema = z.object({
  text: goalText, source: z.enum(['tui', 'slack', 'director']), answeredAt: z.iso.datetime(),
}).strict();
export const GoalQuestionSchema = GoalQuestionInputSchema.extend({
  id: z.uuid(), status: z.enum(['pending', 'answered', 'withdrawn']),
  answer: GoalAnswerSchema.optional(),
}).superRefine((question, ctx) => {
  if ((question.status === 'answered') !== (question.answer !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Only answered questions require an answer' });
  }
});
export const GoalNotificationInputSchema = z.object({
  kind: z.enum(MANAGER_NOTIFICATION_KINDS),
  body: z.string().refine((value) => value.trim().length > 0),
  severity: z.enum(['info', 'warning', 'error']).optional(),
}).strict();
export type GoalQuestion = z.infer<typeof GoalQuestionSchema>;
export type GoalQuestionInput = z.input<typeof GoalQuestionInputSchema>;
export type GoalNotificationInput = z.infer<typeof GoalNotificationInputSchema>;

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

export const GoalCompletionSchema = z.object({
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

const eventShape = { id: z.string().min(1), processed: z.boolean(), summary: z.string().optional() };
export const GoalEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventShape, kind: z.literal('completion'), taskName: z.string().min(1), runSlug: z.string().min(1), result: GoalTaskResultSchema }).strict(),
  z.object({ ...eventShape, kind: z.literal('answer'), questionId: z.uuid(), answer: GoalAnswerSchema }).strict(),
  z.object({ ...eventShape, kind: z.literal('delegation_completion'), requestId: z.string().min(1), result: z.record(z.string(), z.unknown()), evidenceRefs: z.array(z.string().min(1)) }).strict(),
]);
export type GoalEvent = z.infer<typeof GoalEventSchema>;

export const GoalDecisionInputSchema = z.object({
  eventId: z.string().min(1), targetSha: goalSha.optional(),
  operation: goalText, reason: goalText, evidenceRefs: z.array(goalText),
  supersedesDecisionId: z.string().min(1).optional(),
  actor: z.enum(['manager', 'human', 'adjudicator']),
  acceptanceCriteriaVersion: z.number().int().positive(),
}).strict();
export const GoalDecisionSchema = GoalDecisionInputSchema.extend({
  id: z.string().min(1), recordedAt: z.iso.datetime(),
  eventId: z.string().min(1).nullable(), actor: z.enum(['manager', 'human', 'adjudicator']).nullable(),
});
export const GoalOperationSchema = z.object({
  id: z.string().min(1), eventId: z.string().min(1), operationName: goalText,
  tool: z.enum(['enqueue', 'integrate', 'complete', 'check_completion', 'question', 'withdraw_question', 'notify']),
  arguments: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'completed', 'failed']), recordedAt: z.iso.datetime(),
  recovery: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((operation, ctx) => {
  if (operation.status === 'completed' && operation.result === undefined) {
    ctx.addIssue({ code: 'custom', path: ['result'], message: 'Completed operations require a result' });
  }
  if (operation.status === 'failed' && (typeof operation.result?.reason !== 'string' || operation.result.reason.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['result', 'reason'], message: 'Failed operations require a reason' });
  }
});
export type GoalOperation = z.infer<typeof GoalOperationSchema>;

export const GoalRecordObjectSchema = z.object({
  id: GoalIdSchema,
  ...summaryShape,
  mode: z.literal('local'),
  status: z.enum(['created', 'awaiting_merge', 'completed']),
  executionStatus: z.enum(['active', 'paused', 'aborted']),
  acceptanceCriteriaVersion: z.number().int().positive(),
  branch: goalBranch,
  startBranch: goalBranch,
  integrationBranch: goalBranch,
  confirmation: z.object(confirmationShape).strict(),
  workUnits: z.array(z.object({
    taskName: z.string().min(1), purpose: goalText, workKey: goalText.optional(), integration: GoalMergeRecordSchema.optional(),
  }).strict()).optional(),
  questions: z.array(GoalQuestionSchema).optional(),
  notifications: z.array(GoalNotificationInputSchema.extend({
    id: z.uuid(), recordedAt: z.iso.datetime(),
  })).optional(),
  completion: GoalCompletionSchema.optional(),
  events: z.array(GoalEventSchema).optional(),
  decisions: z.array(GoalDecisionSchema).optional(),
  operations: z.array(GoalOperationSchema).optional(),
}).strict();
export const GoalSchema = GoalRecordObjectSchema.superRefine((goal, ctx) => {
  if (goal.status !== 'created' && goal.completion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion'], message: 'Completion evidence is required' });
  }
  if (goal.status === 'completed' && goal.completion?.targetSha === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion', 'targetSha'], message: 'Integrated target SHA is required' });
  }
});

export type Goal = z.infer<typeof GoalSchema>;
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;
