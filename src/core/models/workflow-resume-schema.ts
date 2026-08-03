import { z } from 'zod/v4';
import { validateWorkflowResumePointInvocationSemantics } from './workflow-resume-contract.js';
import { ProviderTypeSchema } from './schema-base.js';

const nonBlankStringSchema = z.string().min(1).refine((value) => value.trim().length > 0);

export const WorkflowResumePointEntrySchema = z.object({
  workflow: z.string().min(1),
  workflow_ref: z.string().min(1).optional(),
  step: z.string().min(1),
  kind: z.enum(['agent', 'system', 'workflow_call']),
  step_iterations: z.record(z.string().min(1), z.number().int().positive()).optional(),
  call_instance: z.number().int().positive().optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.kind === 'workflow_call' && entry.call_instance === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['call_instance'],
      message: 'workflow_call resume entry requires call_instance',
    });
  }
});

export const WorkflowRestartPointEntrySchema = z.object({
  workflow: nonBlankStringSchema,
  workflow_ref: nonBlankStringSchema,
  step: nonBlankStringSchema,
  kind: z.enum(['agent', 'system', 'workflow_call']),
  call_instance: z.literal(1).optional(),
  step_iterations: z.never().optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.kind === 'workflow_call' && entry.call_instance === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['call_instance'],
      message: 'workflow_call restart entry requires call_instance',
    });
  }
  if (entry.kind !== 'workflow_call' && entry.call_instance !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['call_instance'],
      message: 'Only workflow_call restart entries may define call_instance',
    });
  }
});

export const WorkflowRestartPointSchema = z.object({
  stack: z.array(WorkflowRestartPointEntrySchema).min(1),
  iteration: z.never().optional(),
  elapsed_ms: z.never().optional(),
}).strict();

export const DynamicParallelSelectionSnapshotSchema = z.object({
  identity: z.string().min(1),
  step_name: z.string().min(1),
  round: z.number().int().positive(),
  selected_pool_ids: z.array(z.string().min(1)),
  effective_selection_ids: z.array(z.string().min(1)).min(1),
}).strict();

export const WorkflowCallInvocationRecordSchema = z.object({
  call_instance: z.number().int().positive(),
  child_workflow_ref: z.string().min(1),
}).strict();

export const WorkflowStepParticipationRecordSchema = z.object({
  report_names: z.array(z.string().min(1)),
}).strict();

const WorkflowPendingLoopJudgeBaseSchema = z.object({
  triggering_step: z.string().min(1),
  cycle: z.array(z.string().min(1)).min(1),
  cycle_count: z.number().int().positive(),
  fallback_next_step: z.string().min(1),
});

export const WorkflowPendingLoopJudgeSchema = z.discriminatedUnion('status', [
  WorkflowPendingLoopJudgeBaseSchema.extend({
    status: z.literal('budget_wait'),
  }).strict(),
  WorkflowPendingLoopJudgeBaseSchema.extend({
    status: z.literal('started'),
    judge_step: z.string().min(1),
    iteration: z.number().int().positive(),
    step_iteration: z.number().int().positive(),
  }).strict(),
]);

const RateLimitFallbackProviderSchema = z.object({
  provider: ProviderTypeSchema,
  model: z.string().min(1).optional(),
}).strict();

export const WorkflowPendingFallbackSchema = z.object({
  context: z.object({
    reason: z.literal('rate_limited'),
    reasonDetail: z.string().min(1),
    originalIteration: z.number().int().positive(),
    previousProvider: ProviderTypeSchema,
    previousModel: z.string().min(1).optional(),
    currentProvider: ProviderTypeSchema,
    currentModel: z.string().min(1).optional(),
    stepName: z.string().min(1),
    reportDir: z.string().min(1),
  }).strict(),
  attempts: z.array(RateLimitFallbackProviderSchema).min(2),
}).strict();

const WorkflowResumePointObjectSchema = z.object({
  version: z.literal(2),
  stack: z.array(WorkflowResumePointEntrySchema).min(1),
  iteration: z.number().int().min(0),
  max_steps: z.union([z.number().int().positive(), z.literal('infinite')]).optional(),
  elapsed_ms: z.number().int().min(0),
  pending_loop_judge: WorkflowPendingLoopJudgeSchema.optional(),
  pending_fallback: WorkflowPendingFallbackSchema.optional(),
  dynamic_parallel_selections: z.record(z.string().min(1), DynamicParallelSelectionSnapshotSchema).optional(),
  workflow_call_invocations: z.record(
    z.string().min(1),
    WorkflowCallInvocationRecordSchema,
  ),
  workflow_step_participations: z.record(
    z.string().min(1),
    WorkflowStepParticipationRecordSchema,
  ),
}).strict();

type PendingValidationResumePoint = Pick<
  z.infer<typeof WorkflowResumePointObjectSchema>,
  'stack' | 'iteration' | 'pending_loop_judge' | 'pending_fallback'
>;

function validatePendingLoopJudgeSemantics(
  resumePoint: PendingValidationResumePoint,
  ctx: z.RefinementCtx,
): void {
  const pending = resumePoint.pending_loop_judge;
  if (pending === undefined) {
    return;
  }
  const owner = resumePoint.stack.at(-1)!;
  const expectedOwner = pending.status === 'started'
    ? pending.judge_step
    : pending.triggering_step;
  if (owner.step !== expectedOwner) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_loop_judge', 'triggering_step'],
      message: `Pending loop judge owner must match terminal resume stack entry "${owner.step}"`,
    });
  }
  if (pending.status === 'started' && owner.kind !== 'agent') {
    ctx.addIssue({
      code: 'custom',
      path: ['stack', resumePoint.stack.length - 1, 'kind'],
      message: 'Started loop judge owner must be an agent step',
    });
  }
  if (pending.status !== 'started') {
    return;
  }
  if (pending.iteration !== resumePoint.iteration) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_loop_judge', 'iteration'],
      message: 'Started loop judge iteration must match resume point iteration',
    });
  }
  if (owner.step_iterations?.[pending.judge_step] !== pending.step_iteration) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_loop_judge', 'step_iteration'],
      message: 'Started loop judge step iteration must match terminal resume stack entry',
    });
  }
}

function matchesFallbackProvider(
  attempt: z.infer<typeof RateLimitFallbackProviderSchema>,
  expected: { provider: z.infer<typeof ProviderTypeSchema>; model?: string },
): boolean {
  return attempt.provider === expected.provider && attempt.model === expected.model;
}

function validatePendingFallbackSemantics(
  resumePoint: PendingValidationResumePoint,
  ctx: z.RefinementCtx,
): void {
  const pending = resumePoint.pending_fallback;
  if (pending === undefined) {
    return;
  }
  const owner = resumePoint.stack.at(-1)!;
  if (owner.kind !== 'agent') {
    ctx.addIssue({
      code: 'custom',
      path: ['stack', resumePoint.stack.length - 1, 'kind'],
      message: 'Pending fallback owner must be an agent step',
    });
  }
  if (owner.step !== pending.context.stepName || resumePoint.iteration !== pending.context.originalIteration - 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_fallback'],
      message: 'Pending fallback must match the terminal step and rolled-back iteration',
    });
  }
  const previousAttempt = pending.attempts.at(-2)!;
  const currentAttempt = pending.attempts.at(-1)!;
  if (!matchesFallbackProvider(previousAttempt, {
    provider: pending.context.previousProvider,
    ...(pending.context.previousModel === undefined ? {} : { model: pending.context.previousModel }),
  })) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_fallback', 'attempts', pending.attempts.length - 2],
      message: 'Pending fallback previous attempt must match fallback context',
    });
  }
  if (!matchesFallbackProvider(currentAttempt, {
    provider: pending.context.currentProvider,
    ...(pending.context.currentModel === undefined ? {} : { model: pending.context.currentModel }),
  })) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_fallback', 'attempts', pending.attempts.length - 1],
      message: 'Pending fallback current attempt must match fallback context',
    });
  }
}

export const WorkflowResumePointSchema = WorkflowResumePointObjectSchema.superRefine((resumePoint, ctx) => {
  validatePendingLoopJudgeSemantics(resumePoint, ctx);
  validatePendingFallbackSemantics(resumePoint, ctx);
  try {
    validateWorkflowResumePointInvocationSemantics(resumePoint);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['workflow_call_invocations'],
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
