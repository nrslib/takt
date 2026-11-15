import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { isValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import { MANAGER_NOTIFICATION_KINDS } from '../../core/models/config-types.js';

export const GoalExecutionOriginSchema = z.enum(['human', 'manager']);
export type GoalExecutionOrigin = z.infer<typeof GoalExecutionOriginSchema>;

const goalText = z.string().max(128 * 1024).refine((value) => value.trim().length > 0);
const goalBranch = z.string().refine(isValidLocalBranchName);
const goalSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const GoalIdSchema = z.uuid();
export const GoalQuestionInputSchema = z.object({
  recipient: z.literal('human').default('human'),
  body: goalText,
  options: z.array(goalText).min(1).optional(),
  recommendation: goalText.optional(),
}).strict();
const GoalOperationInputSchema = z.object({
  toolName: goalText,
  args: z.string(),
  cwd: z.string().refine(isAbsolute),
}).strict();
// Approval fields remain readable for historical manager records; they no longer authorize tool execution.
export const GoalInquiryInputSchema = GoalQuestionInputSchema.extend({
  kind: z.enum(['question', 'approval', 'operation_request']).default('question'),
  operation: GoalOperationInputSchema.optional(),
  targetSha: goalSha.optional(),
  permissionProposal: goalText.optional(),
});
const goalAnswerFields = {
  text: z.string().max(128 * 1024).default(''),
  decision: z.enum(['allow', 'deny']).optional(),
  report: z.enum(['completed', 'unable']).optional(),
  scope: z.enum(['once', 'goal', 'project', 'workspace', 'global']).optional(),
};
export const GoalAnswerInputSchema = z.object(goalAnswerFields).strict();
export const GoalAnswerSchema = GoalAnswerInputSchema.extend({
  source: z.enum(['tui', 'slack', 'mcp']), answeredAt: z.iso.datetime(),
}).superRefine((answer, ctx) => {
  if (answer.text.trim().length === 0 && answer.decision === undefined && answer.report === undefined) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'An answer requires text or a structured response' });
  }
  if (answer.scope !== undefined && answer.decision !== 'allow') {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Only allowed approvals have a scope' });
  }
}).transform((answer) => answer.decision === 'allow' ? { ...answer, scope: answer.scope ?? 'once' as const } : answer);
export type GoalAnswerInput = z.input<z.ZodObject<typeof goalAnswerFields>>;
export const GoalQuestionSchema = GoalInquiryInputSchema.extend({
  operation: GoalOperationInputSchema.extend({ argsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  id: z.uuid(), status: z.enum(['pending', 'answered', 'withdrawn']),
  createdAt: z.iso.datetime().optional(),
  answer: GoalAnswerSchema.optional(),
  answerPublicationPending: z.literal(true).optional(),
  withdrawalReason: goalText.optional(),
  withdrawnAt: z.iso.datetime().optional(),
  consumedAt: z.iso.datetime().optional(),
}).superRefine((question, ctx) => {
  if ((question.status === 'answered') !== (question.answer !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Only answered questions require an answer' });
  }
  if (question.answerPublicationPending && question.status !== 'answered') {
    ctx.addIssue({ code: 'custom', path: ['answerPublicationPending'], message: 'Only answered questions can await publication' });
  }
  if (question.kind === 'approval' && question.operation === undefined) {
    ctx.addIssue({ code: 'custom', path: ['operation'], message: 'An approval requires an operation' });
  }
  const answer = question.answer;
  if (answer !== undefined) {
    if (question.kind === 'question' && (answer.text.trim().length === 0 || answer.decision !== undefined || answer.report !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Questions require a text answer' });
    }
    if (question.kind === 'approval' && (answer.decision === undefined || answer.report !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Approvals require an explicit decision' });
    }
    if (question.kind === 'operation_request' && (answer.report === undefined || answer.decision !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Operation requests require a report' });
    }
  }
  if (question.consumedAt !== undefined && (question.kind !== 'approval' || question.status !== 'answered' || answer?.decision !== 'allow')) {
    ctx.addIssue({ code: 'custom', path: ['consumedAt'], message: 'Only allowed approvals can be consumed' });
  }
});
export const GoalNotificationInputSchema = z.object({
  kind: z.enum(MANAGER_NOTIFICATION_KINDS),
  body: z.string().refine((value) => value.trim().length > 0),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  source: z.literal('manager_turn_failure').optional(),
}).strict();
// Existing callers may construct questions without kind; parsing always supplies it.
export type GoalQuestion = Omit<z.infer<typeof GoalQuestionSchema>, 'kind'> & {
  kind?: z.infer<typeof GoalQuestionSchema>['kind'];
};
export type GoalQuestionInput = z.input<typeof GoalInquiryInputSchema>;
export type GoalNotificationInput = z.infer<typeof GoalNotificationInputSchema>;

export const GoalBranchSyncSchema = z.object({
  status: z.enum(['no_origin', 'unpublished', 'unchanged', 'local_ahead', 'fast_forward', 'diverged', 'checked_out']),
  localSha: goalSha,
  remoteSha: goalSha.optional(),
  worktrees: z.array(z.string()).optional(),
}).strict();
export type GoalBranchSync = z.infer<typeof GoalBranchSyncSchema>;

export const GoalTaskResultSchema = z.object({
  success: z.boolean(),
  interrupted: z.boolean(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  shaUnavailableReason: z.string().optional(),
  failureReason: z.string().optional(),
  mergeOutcome: z.enum(['prepared', 'merged', 'unresolved']).optional(),
  branchSynchronization: GoalBranchSyncSchema.optional(),
  workflowResult: z.enum(['completed', 'aborted', 'exceeded', 'error']).optional(),
}).strict();
export type GoalTaskResult = z.infer<typeof GoalTaskResultSchema>;

export const GoalSpecificationsSchema = z.object({
  gherkin: goalText.optional(),
  quint: goalText.optional(),
  alloy: goalText.optional(),
}).strict();
export type GoalSpecifications = z.infer<typeof GoalSpecificationsSchema>;

const summaryShape = {
  objective: goalText,
  outOfScope: z.array(goalText),
  acceptanceCriteria: z.array(goalText).min(1),
  constraints: z.array(goalText),
  specifications: GoalSpecificationsSchema.optional(),
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

export const GoalCompletionSchema = z.object({
  goalBranch: goalBranch,
  goalSha,
  targetBranch: goalBranch,
  summary: goalText,
  humanChecks: goalText.optional(),
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
  pullRequest: z.object({ number: z.number().int().safe().positive(), url: z.url() }).strict().optional(),
}).strict();
const readableGoal = GoalRecordObjectSchema.extend({ pullRequestFailure: z.unknown().optional() })
  .transform(({ pullRequestFailure: _retiredFailure, ...goal }) => goal);
export const GoalSchema = readableGoal.superRefine((goal, ctx) => {
  if (goal.status !== 'created' && goal.completion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion'], message: 'Completion evidence is required' });
  }
  if (goal.status === 'completed' && goal.completion?.targetSha === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completion', 'targetSha'], message: 'Integrated target SHA is required' });
  }
});

export type Goal = Omit<z.infer<typeof GoalSchema>, 'questions'> & { questions?: GoalQuestion[] };
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;
