import { z } from 'zod/v4';

export const StructuredOutputRawSchema = z.object({
  schema_ref: z.string().min(1),
});

const ScopedTemplateReferenceSchema = z.string().regex(
  /^\{(?:context|structured):[^.}]+(?:\.[^}]+)+\}$/,
  'Expected full template reference like "{context:step.value}"',
);

const EffectTemplateReferenceSchema = z.string().regex(
  /^\{effect:[^.}]+(?:\.[^}]+){2,}\}$/,
  'Effect references must use "{effect:step.type.field}"',
);

const TemplateReferenceSchema = z.union([
  ScopedTemplateReferenceSchema,
  EffectTemplateReferenceSchema,
]);

const SystemInputBindingSchema = z.object({
  as: z.string().min(1),
});

export const SystemInputRawSchema = z.discriminatedUnion('type', [
  SystemInputBindingSchema.extend({
    type: z.literal('task_context'),
    source: z.literal('current_task'),
  }),
  SystemInputBindingSchema.extend({
    type: z.literal('branch_context'),
    source: z.literal('current_task'),
  }),
  SystemInputBindingSchema.extend({
    type: z.literal('pr_context'),
    source: z.literal('current_branch'),
  }),
  SystemInputBindingSchema.extend({
    type: z.literal('issue_context'),
    source: z.literal('current_task'),
  }),
  SystemInputBindingSchema.extend({
    type: z.literal('task_queue_context'),
    source: z.literal('current_project'),
  }),
]);

const EffectReferenceScalarSchema = z.union([TemplateReferenceSchema, z.number().int().positive()]);

const EnqueueIssueRawSchema = z.object({
  create: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
}).strict();

const EnqueueWorktreeRawSchema = z.object({
  enabled: z.boolean().optional(),
  auto_pr: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
}).strict().superRefine((data, ctx) => {
  if ((data.auto_pr === true || data.draft_pr === true) && data.enabled !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enabled'],
      message: 'worktree.auto_pr and worktree.draft_pr require worktree.enabled to be true',
    });
  }
});

const EnqueueTaskEffectBaseSchema = z.object({
  type: z.literal('enqueue_task'),
  mode: z.enum(['new', 'from_pr']),
  workflow: z.string().min(1),
  task: z.string().min(1),
  pr: EffectReferenceScalarSchema.optional(),
  issue: z.union([EnqueueIssueRawSchema, TemplateReferenceSchema]).optional(),
  base_branch: z.string().min(1).optional(),
  worktree: EnqueueWorktreeRawSchema.optional(),
}).strict();

export const WorkflowEffectRawSchema = z.discriminatedUnion('type', [
  EnqueueTaskEffectBaseSchema.superRefine((data, ctx) => {
    if (data.mode === 'from_pr' && data.pr === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pr'],
        message: 'enqueue_task mode "from_pr" requires "pr"',
      });
    }
    if (data.mode === 'new' && data.pr !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pr'],
        message: 'enqueue_task mode "new" does not allow "pr"',
      });
    }
    if (data.mode === 'from_pr' && data.issue !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issue'],
        message: 'enqueue_task mode "from_pr" does not allow "issue"',
      });
    }
    if (data.mode === 'from_pr' && data.worktree !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['worktree'],
        message: 'enqueue_task mode "from_pr" does not allow "worktree"',
      });
    }
  }),
  z.object({
    type: z.literal('comment_pr'),
    pr: EffectReferenceScalarSchema,
    body: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('sync_with_root'),
    pr: EffectReferenceScalarSchema,
  }).strict(),
  z.object({
    type: z.literal('resolve_conflicts_with_ai'),
    pr: EffectReferenceScalarSchema,
  }).strict(),
  z.object({
    type: z.literal('merge_pr'),
    pr: EffectReferenceScalarSchema,
  }).strict(),
]);

export function validateSystemStepFields(
  data: {
    mode?: 'agent' | 'system';
    system_inputs?: Array<{ as?: string }>;
    effects?: Array<{ type: string }>;
  } & Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
): void {
  const hasSystemFields = data.system_inputs !== undefined || data.effects !== undefined;
  if (hasSystemFields && data.mode !== 'system') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'Steps with "system_inputs" or "effects" must set mode to "system"',
    });
  }

  if (data.mode === 'system') {
    for (const field of ['parallel', 'arpeggio', 'team_leader'] as const) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `System step does not allow "${field}"`,
        });
      }
    }

    for (const field of [
      'persona',
      'persona_name',
      'policy',
      'knowledge',
      'mcp_servers',
      'provider',
      'model',
      'required_permission_mode',
      'provider_options',
      'edit',
      'instruction',
      'structured_output',
      'output_contracts',
      'quality_gates',
    ] as const) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `System step does not allow "${field}"`,
        });
      }
    }
  }

  const systemInputBindings = new Set<string>();
  for (const [index, input] of (data.system_inputs ?? []).entries()) {
    if (!input.as) {
      continue;
    }
    if (systemInputBindings.has(input.as)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['system_inputs', index, 'as'],
        message: `Duplicate system input binding "${input.as}" is not allowed in a single step`,
      });
      continue;
    }
    systemInputBindings.add(input.as);
  }

  const effectTypes = new Set<string>();
  for (const [index, effect] of (data.effects ?? []).entries()) {
    if (effectTypes.has(effect.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effects', index, 'type'],
        message: `Duplicate effect type "${effect.type}" is not allowed in a single step`,
      });
      continue;
    }
    effectTypes.add(effect.type);
  }
}
