/**
 * Workflow YAML schemas.
 */

import { z } from 'zod/v4';
import { INTERACTIVE_MODES } from './interactive-mode.js';
import { getWorkflowStepKind } from './workflow-step-kind.js';
import {
  McpServersSchema,
  StepProviderOptionsSchema,
  OutputContractsFieldSchema,
  PermissionModeSchema,
  WorkflowProviderOptionsSchema,
  ProviderReferenceSchema,
  QualityGatesSchema,
} from './schema-base.js';
import {
  StructuredOutputRawSchema,
  SystemInputRawSchema,
  validateSystemStepFields,
  WorkflowEffectRawSchema,
} from './workflow-system-schemas.js';

const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;
const AGGREGATE_CONDITION_REGEX = /^(all|any)\((.+)\)$/;
const RESERVED_WORKFLOW_CALL_RESULTS = ['COMPLETE', 'ABORT'] as const;

export const WorkflowParamReferenceRawSchema = z.object({
  $param: z.string().min(1),
}).strict();

const WorkflowFacetRefScalarSchema = z.string().min(1);
const WorkflowFacetRefListSchema = z.array(z.string().min(1)).min(1);
const WorkflowFacetRefValueSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowFacetRefListSchema]);
const WorkflowFacetRefOrParamSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowParamReferenceRawSchema]);
const WorkflowFacetRefListOrParamSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowFacetRefListSchema, WorkflowParamReferenceRawSchema]);

const WorkflowCallArgsRawSchema = z.record(z.string().min(1), WorkflowFacetRefValueSchema);

const WorkflowParamDeclarationRawSchema = z.object({
  type: z.enum(['facet_ref', 'facet_ref[]']),
  facet_kind: z.enum(['knowledge', 'policy', 'instruction', 'report_format']),
  default: WorkflowFacetRefValueSchema.optional(),
}).strict().superRefine((data, ctx) => {
  const isArrayDefault = Array.isArray(data.default);
  if (data.type === 'facet_ref' && isArrayDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default'],
      message: 'facet_ref params require a scalar default',
    });
  }
  if (data.type === 'facet_ref[]' && data.default !== undefined && !isArrayDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default'],
      message: 'facet_ref[] params require an array default',
    });
  }
});

/** Rule-based transition schema (new unified format) */
export const WorkflowRuleSchema = z.object({
  condition: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  next: z.string().min(1).optional(),
  return: z.string().min(1).optional(),
  appendix: z.string().optional(),
  requires_user_input: z.boolean().optional(),
  interactive_only: z.boolean().optional(),
}).refine(
  (data) => (data.condition != null) !== (data.when != null),
  {
    message: "Rule requires exactly one of 'condition' or 'when'",
    path: ['condition'],
  },
);

/** Arpeggio merge configuration schema */
export const ArpeggioMergeRawSchema = z.object({
  strategy: z.enum(['concat', 'custom']).optional().default('concat'),
  inline_js: z.string().optional(),
  file: z.string().optional(),
  separator: z.string().optional(),
}).refine(
  (data) => data.strategy !== 'custom' || data.inline_js != null || data.file != null,
  { message: "Custom merge strategy requires either 'inline_js' or 'file'" }
).refine(
  (data) => data.strategy !== 'concat' || (data.inline_js == null && data.file == null),
  { message: "Concat merge strategy does not accept 'inline_js' or 'file'" }
);

/** Arpeggio configuration schema for data-driven batch processing */
export const ArpeggioConfigRawSchema = z.object({
  source: z.string().min(1),
  source_path: z.string().min(1),
  batch_size: z.number().int().positive().optional().default(1),
  concurrency: z.number().int().positive().optional().default(1),
  template: z.string().min(1),
  merge: ArpeggioMergeRawSchema.optional(),
  max_retries: z.number().int().min(0).optional().default(2),
  retry_delay_ms: z.number().int().min(0).optional().default(1000),
  output_path: z.string().optional(),
});

/** Team leader configuration schema for dynamic part decomposition */
export const TeamLeaderConfigRawSchema = z.object({
  persona: z.string().optional(),
  max_parts: z.number().int().positive().max(3).optional().default(3),
  refill_threshold: z.number().int().min(0).optional().default(0),
  timeout_ms: z.number().int().positive().optional().default(900000),
  part_persona: z.string().optional(),
  part_allowed_tools: z.array(z.string()).optional(),
  part_edit: z.boolean().optional(),
  part_permission_mode: PermissionModeSchema.optional(),
}).refine(
  (data) => data.refill_threshold <= data.max_parts,
  {
    message: "'refill_threshold' must be less than or equal to 'max_parts'",
    path: ['refill_threshold'],
  },
);

/** Sub-step schema for parallel execution */
export const ParallelSubStepRawSchema = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
  persona_name: z.string().optional(),
  policy: WorkflowFacetRefListOrParamSchema.optional(),
  knowledge: WorkflowFacetRefListOrParamSchema.optional(),
  allowed_tools: z.never().optional(),
  mcp_servers: McpServersSchema,
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: StepProviderOptionsSchema,
  edit: z.boolean().optional(),
  instruction: WorkflowFacetRefOrParamSchema.optional(),
  instruction_template: z.never().optional(),
  rules: z.array(WorkflowRuleSchema).optional(),
  output_contracts: OutputContractsFieldSchema,
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional(),
}).superRefine((data, ctx) => {
  data.rules?.forEach((rule, index) => {
    if (rule.return !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'return'],
        message: 'parallel sub-step rules do not allow "return"',
      });
    }
  });
});

/** Workflow step schema - raw YAML format */
const WorkflowStepKindSchema = z.enum(['agent', 'system', 'workflow_call']);

const WorkflowCallOverridesRawSchema = z.object({
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  provider_options: StepProviderOptionsSchema,
}).strict().refine(
  (data) => data.provider !== undefined || data.model !== undefined || data.provider_options !== undefined,
  {
    message: "workflow_call overrides require at least one of 'provider', 'model', or 'provider_options'",
  },
);

const WorkflowSubworkflowRawSchema = z.object({
  callable: z.boolean().optional(),
  visibility: z.enum(['internal']).optional(),
  returns: z.array(z.string().min(1)).optional(),
  params: z.record(z.string().min(1), WorkflowParamDeclarationRawSchema).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.callable === true) {
    data.returns?.forEach((value, index) => {
      if (RESERVED_WORKFLOW_CALL_RESULTS.includes(value as typeof RESERVED_WORKFLOW_CALL_RESULTS[number])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['returns', index],
          message: `subworkflow.returns must not include reserved result "${value}"`,
        });
      }
    });
    return;
  }

  for (const field of ['visibility', 'returns', 'params'] as const) {
    if (data[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `subworkflow.${field} requires callable: true`,
      });
    }
  }
});

function createWorkflowStepRawSchema(options?: { relaxWorkflowCallConditions?: boolean }) {
  return z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  kind: WorkflowStepKindSchema.optional(),
  mode: z.literal('system').optional(),
  call: z.string().min(1).optional(),
  overrides: WorkflowCallOverridesRawSchema.optional(),
  args: WorkflowCallArgsRawSchema.optional(),
  session: z.enum(['continue', 'refresh']).optional(),
  persona: z.string().optional(),
  persona_name: z.string().optional(),
  policy: WorkflowFacetRefListOrParamSchema.optional(),
  knowledge: WorkflowFacetRefListOrParamSchema.optional(),
  allowed_tools: z.never().optional(),
  mcp_servers: McpServersSchema,
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: StepProviderOptionsSchema,
  edit: z.boolean().optional(),
  instruction: WorkflowFacetRefOrParamSchema.optional(),
  instruction_template: z.never().optional(),
  delay_before_ms: z.number().int().min(0).optional(),
  structured_output: StructuredOutputRawSchema.optional(),
  system_inputs: z.array(SystemInputRawSchema).optional(),
  effects: z.array(WorkflowEffectRawSchema).optional(),
  rules: z.array(WorkflowRuleSchema).optional(),
  output_contracts: OutputContractsFieldSchema,
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional(),
  parallel: z.array(ParallelSubStepRawSchema).optional(),
  concurrency: z.number().int().min(1).optional(),
  arpeggio: ArpeggioConfigRawSchema.optional(),
  team_leader: TeamLeaderConfigRawSchema.optional(),
}).refine(
  (data) => [data.parallel, data.arpeggio, data.team_leader].filter((value) => value != null).length <= 1,
  {
    message: "'parallel', 'arpeggio', and 'team_leader' are mutually exclusive",
    path: ['parallel'],
  },
).superRefine((data, ctx) => {
  if (data.kind !== undefined && data.mode !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kind'],
      message: 'Step kind must be expressed with either "kind" or "mode", not both',
    });
  }

  const stepKind = getWorkflowStepKind(data);

  if (data.call !== undefined && stepKind !== 'workflow_call') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['call'],
      message: 'Only workflow_call steps can declare "call"',
    });
  }

  if (data.overrides !== undefined && stepKind !== 'workflow_call') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overrides'],
      message: 'Only workflow_call steps can declare "overrides"',
    });
  }

  if (data.args !== undefined && stepKind !== 'workflow_call') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args'],
      message: 'Only workflow_call steps can declare "args"',
    });
  }

  if (stepKind === 'workflow_call') {
    if (data.call === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['call'],
        message: 'workflow_call step requires "call"',
      });
    }

    for (const field of [
      'persona',
      'persona_name',
      'policy',
      'knowledge',
      'mcp_servers',
      'provider',
      'model',
      'provider_options',
      'required_permission_mode',
      'edit',
      'instruction',
      'session',
      'delay_before_ms',
      'structured_output',
      'system_inputs',
      'effects',
      'parallel',
      'concurrency',
      'arpeggio',
      'team_leader',
      'output_contracts',
      'quality_gates',
      'pass_previous_response',
    ] as const) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `workflow_call step does not allow "${field}"`,
        });
      }
    }

    data.rules?.forEach((rule, index) => {
      if (rule.when !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'when'],
          message: 'workflow_call rules do not allow "when"; use condition: COMPLETE or ABORT',
        });
      }

      if (rule.condition === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'condition'],
          message: 'workflow_call rules require condition: COMPLETE or ABORT',
        });
        return;
      }

      const allowExtendedConditions = options?.relaxWorkflowCallConditions === true;
      const isBuiltInCondition = rule.condition === 'COMPLETE' || rule.condition === 'ABORT';
      const isExtendedCondition = allowExtendedConditions
        && !AI_CONDITION_REGEX.test(rule.condition)
        && !AGGREGATE_CONDITION_REGEX.test(rule.condition);

      if (!isBuiltInCondition && !isExtendedCondition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'condition'],
          message: allowExtendedConditions
            ? 'workflow_call rules only allow COMPLETE, ABORT, or callable return conditions'
            : 'workflow_call rules only allow COMPLETE or ABORT conditions',
        });
      }
    });
  }

  validateSystemStepFields(data, ctx);
});
}

export const WorkflowStepRawSchema = createWorkflowStepRawSchema();
const WorkflowConfigStepRawSchema = createWorkflowStepRawSchema({ relaxWorkflowCallConditions: true });

/** Loop monitor rule schema */
export const LoopMonitorRuleSchema = z.object({
  condition: z.string().min(1),
  next: z.string().min(1),
});

/** Loop monitor judge schema */
export const LoopMonitorJudgeSchema = z.object({
  persona: z.string().optional(),
  provider: ProviderReferenceSchema.optional(),
  model: z.string().min(1).optional(),
  instruction: z.string().optional(),
  instruction_template: z.never().optional(),
  rules: z.array(LoopMonitorRuleSchema).min(1),
});

/** Loop monitor configuration schema */
export const LoopMonitorSchema = z.object({
  cycle: z.array(z.string().min(1)).min(2),
  threshold: z.number().int().positive().optional().default(3),
  judge: LoopMonitorJudgeSchema,
});

/** Interactive mode schema for workflow-level default */
export const InteractiveModeSchema = z.enum(INTERACTIVE_MODES);
/** Workflow configuration schema - raw YAML format */
export const WorkflowConfigRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  subworkflow: WorkflowSubworkflowRawSchema.optional(),
  workflow_config: WorkflowProviderOptionsSchema,
  permission_mode: z.never().optional(),
  schemas: z.record(z.string(), z.string()).optional(),
  personas: z.record(z.string(), z.string()).optional(),
  policies: z.record(z.string(), z.string()).optional(),
  knowledge: z.record(z.string(), z.string()).optional(),
  instructions: z.record(z.string(), z.string()).optional(),
  report_formats: z.record(z.string(), z.string()).optional(),
  steps: z.array(WorkflowConfigStepRawSchema).min(1),
  initial_step: z.string().optional(),
  max_steps: z.number().int().positive().optional().default(10),
  loop_monitors: z.array(LoopMonitorSchema).optional(),
  interactive_mode: InteractiveModeSchema.optional(),
}).strict();
