import { z } from 'zod/v4';

export const WorkflowResumePointEntrySchema = z.object({
  workflow: z.string().min(1),
  workflow_ref: z.string().min(1),
  step: z.string().min(1),
  kind: z.enum(['agent', 'system', 'workflow_call', 'parallel']),
  occurrence: z.number().int().positive(),
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

export const DynamicParallelSelectionSnapshotSchema = z.object({
  identity: z.string().min(1),
  step_name: z.string().min(1),
  round: z.number().int().positive(),
  selected_pool_ids: z.array(z.string().min(1)),
  effective_selection_ids: z.array(z.string().min(1)).min(1),
}).strict();

export const WorkflowCallInvocationRecordSchema = z.object({
  call_instance: z.number().int().positive(),
  report_namespace_segment: z.string().regex(
    /^iteration-[1-9]\d*--step-[^/]+--workflow-[^/]+$/,
    'Invalid workflow-call report namespace segment',
  ),
}).strict();

export const WorkflowStepParticipationRecordSchema = z.object({
  report_names: z.array(z.string().min(1)),
}).strict();

export const WorkflowResumePointSchema = z.object({
  version: z.literal(2),
  stack: z.array(WorkflowResumePointEntrySchema).min(1),
  iteration: z.number().int().min(0),
  elapsed_ms: z.number().int().min(0),
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
