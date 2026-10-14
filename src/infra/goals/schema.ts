import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { isValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import { MANAGER_NOTIFICATION_KINDS } from '../../core/models/config-types.js';

const goalText = z.string().max(128 * 1024).refine((value) => value.trim().length > 0);
const goalBranch = z.string().refine(isValidLocalBranchName);
export const GoalIdSchema = z.uuid();
export const GoalQuestionInputSchema = z.object({
  recipient: z.literal('human').default('human'),
  body: goalText,
  options: z.array(goalText).min(1).optional(),
  recommendation: goalText.optional(),
}).strict();
export const GoalAnswerSchema = z.object({
  text: goalText, source: z.enum(['tui', 'slack']), answeredAt: z.iso.datetime(),
}).strict();
export const GoalQuestionSchema = GoalQuestionInputSchema.extend({
  id: z.uuid(), status: z.enum(['pending', 'answered', 'withdrawn']),
  createdAt: z.iso.datetime().optional(),
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
  constraints: z.array(goalText),
};

export const GoalSummarySchema = z.object({
  ...summaryShape,
  startBranch: goalBranch.optional(),
  integrationBranch: goalBranch.optional(),
}).strict();

export const GoalCreateInputSchema = GoalSummarySchema.extend({
  id: GoalIdSchema,
  cwd: z.string().refine(isAbsolute),
});

export type ManagerGoalSummary = z.infer<typeof GoalSummarySchema>;

const goalSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
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

export const GoalWorkLogInputSchema = z.object({
  summary: goalText,
  kind: z.literal('patrol').optional(),
}).strict();
export const GoalWorkLogSchema = GoalWorkLogInputSchema.extend({
  id: z.uuid(), recordedAt: z.iso.datetime(),
});

export const GoalRecordObjectSchema = z.object({
  id: GoalIdSchema,
  createdAt: z.iso.datetime().optional(),
  lastPatrolCompletedAt: z.iso.datetime().optional(),
  ...summaryShape,
  mode: z.literal('local'),
  status: z.enum(['created', 'awaiting_merge', 'completed']),
  executionStatus: z.enum(['active', 'paused', 'aborted']),
  acceptanceCriteriaVersion: z.number().int().positive(),
  branch: goalBranch,
  startBranch: goalBranch,
  integrationBranch: goalBranch,
  workLog: z.array(GoalWorkLogSchema),
  questions: z.array(GoalQuestionSchema).optional(),
  notifications: z.array(GoalNotificationInputSchema.extend({
    id: z.uuid(), recordedAt: z.iso.datetime(),
  })).optional(),
  completion: GoalCompletionSchema.optional(),
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
