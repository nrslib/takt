/**
 * Workflow YAML schemas.
 */

import { z } from 'zod/v4';
import { INTERACTIVE_MODES } from './interactive-mode.js';
import { isReviewMode, REVIEW_MODE_VALUES } from './review-mode.js';
import { getWorkflowStepKind } from './workflow-step-kind.js';
import {
  McpServersSchema,
  OutputContractsFieldSchema,
  PermissionModeSchema,
  ReportRelativePathSchema,
  QualityGatesSchema,
  RuntimeConfigSchema,
} from './schema-base.js';
import {
  StructuredOutputRawSchema,
  SystemInputRawSchema,
  validateSystemStepFields,
  WorkflowEffectRawSchema,
} from './workflow-system-schemas.js';
import {
  findSemanticAppendixConflicts,
  hasAggregateCondition,
  hasCompanionReference,
  isParallelSubStepRuleCondition,
  parseWorkflowRuleCondition,
  type SemanticAppendixRule,
} from './workflow-rule-condition.js';
import {
  SESSION_AGENT_STEP_REQUIRED_MESSAGE,
  SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
} from './workflow-session-constraints.js';
import {
  MAX_COMPLETION_RETRY,
  WORKFLOW_SESSION_MODES,
} from './workflow-types.js';
import { classifyReportRelativePath } from './reserved-report-names.js';

const RESERVED_WORKFLOW_CALL_RESULTS = ['COMPLETE', 'ABORT'] as const;
const WorkflowStepNameSchema = z.string().min(1);

// Issue #1208 Stage 1 — additive capability/MCP reference surface.
// `capabilities` names a capability-set (an existing provider-options named resource, formalized);
// `mcp` names one or more MCP servers defined at the workflow top level (or, later, in runtime.yaml).
const WorkflowCapabilitiesRefSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional();
const WorkflowMcpRefListSchema = z.array(z.string().min(1)).min(1).optional();

export const WorkflowParamReferenceRawSchema = z.object({
  $param: z.string().min(1),
}).strict();

const WorkflowFacetRefScalarSchema = z.string().min(1);
const WorkflowFacetRefArrayValueSchema = z.array(z.string().min(1));
const WorkflowFacetRefValueSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowFacetRefArrayValueSchema]);
const WorkflowFacetRefOrParamSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowParamReferenceRawSchema]);
// Preserve the normalizer's contextual empty-persona error and fragment provenance.
const WorkflowPersonaRefOrParamSchema = z.union([z.string(), WorkflowParamReferenceRawSchema]);
const WorkflowFacetRefListItemSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowParamReferenceRawSchema]);
const WorkflowFacetRefListOrParamSchema = z.union([
  WorkflowFacetRefScalarSchema,
  z.array(WorkflowFacetRefListItemSchema).min(1),
  WorkflowParamReferenceRawSchema,
]);
const WorkflowReferenceOrParamSchema = z.union([WorkflowFacetRefScalarSchema, WorkflowParamReferenceRawSchema]);

const SelectorGuidanceRawSchema = z.object({
  persona: WorkflowPersonaRefOrParamSchema.optional(),
  instruction: WorkflowFacetRefOrParamSchema,
}).strict();

const CompanionSelectionObjectRawSchema = z.object({
  fixed: z.array(z.string().trim().min(1)).optional().default([]),
  pool: z.array(z.string().trim().min(1)).optional().default([]),
  moderator: z.string().trim().min(1).optional(),
}).strict().superRefine((selection, ctx) => {
  if (selection.fixed.length === 0 && selection.pool.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'companion requires at least one fixed or pool reference',
    });
  }
  if (
    selection.moderator !== undefined
    && (selection.fixed.includes(selection.moderator) || selection.pool.includes(selection.moderator))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['moderator'],
      message: 'companion moderator cannot also be a fixed or pool reviewer',
    });
  }
});

const CompanionSelectionArgValueRawSchema = z.union([
  z.array(z.string().trim().min(1)),
  CompanionSelectionObjectRawSchema,
]);

export const WorkflowCallArgValueRawSchema = z.union([
  WorkflowFacetRefValueSchema,
  CompanionSelectionArgValueRawSchema,
]);

const WorkflowCallArgsRawSchema = z.record(
  z.string().min(1),
  z.union([
    WorkflowCallArgValueRawSchema,
    WorkflowParamReferenceRawSchema,
  ]),
);
const WorkflowCallVarsValueRawSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const WorkflowCallVarsRawSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
  WorkflowCallVarsValueRawSchema,
).superRefine((vars, ctx) => {
  if (!Object.hasOwn(vars, 'review_mode')) return;
  if (!isReviewMode(vars.review_mode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['review_mode'],
      message: `review_mode must be one of: ${REVIEW_MODE_VALUES.join(', ')}`,
    });
  }
});

const WORKFLOW_RUNTIME_PROVIDER_MESSAGE = 'workflow YAML no longer accepts provider execution settings; configure provider/model/options in runtime.yaml';
const WORKFLOW_RUNTIME_ROUTING_MESSAGE = 'workflow YAML no longer accepts provider routing settings; configure routing in runtime.yaml';
const WORKFLOW_RUNTIME_LADDER_MESSAGE = 'workflow promotion only accepts {at: N}; configure the target ladder in runtime.yaml';

function removedWorkflowRuntimeField(message: string): z.ZodOptional<z.ZodNever> {
  return z.never({ message }).optional();
}

const WorkflowFacetParamDeclarationRawSchema = z.object({
  type: z.enum(['facet_ref', 'facet_ref[]']),
  facet_kind: z.enum(['knowledge', 'policy', 'instruction', 'persona', 'report_format']),
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

const WorkflowReferenceParamDeclarationRawSchema = z.object({
  type: z.literal('workflow_ref'),
  default: WorkflowFacetRefScalarSchema.optional(),
}).strict();

const WorkflowFacetPoolParamDeclarationRawSchema = z.object({
  type: z.literal('facet_pool_ref'),
  default: WorkflowFacetRefScalarSchema.optional(),
}).strict();

const WorkflowCompanionParamDeclarationRawSchema = z.object({
  type: z.literal('companion_ref[]'),
  default: CompanionSelectionArgValueRawSchema.optional(),
}).strict();

const WorkflowParamDeclarationRawSchema = z.union([
  WorkflowFacetParamDeclarationRawSchema,
  WorkflowReferenceParamDeclarationRawSchema,
  WorkflowFacetPoolParamDeclarationRawSchema,
  WorkflowCompanionParamDeclarationRawSchema,
]);

const WorkflowRuleConditionRawSchema = z.string().trim().min(1).superRefine((condition, ctx) => {
  try {
    const parsed = parseWorkflowRuleCondition(condition);
    if (hasCompanionReference(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Workflow transition rules cannot reference advisory companion state',
      });
    }
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid workflow rule condition',
    });
  }
});

const WorkflowWideRuleReferenceSchema = z.string().trim().min(1);
const WorkflowWideRuleEntrySchema = z.union([
  WorkflowWideRuleReferenceSchema,
  z.object({
    ref: WorkflowWideRuleReferenceSchema,
    position: z.literal('before_instruction').optional(),
  }).strict(),
]);
const WorkflowAllStepsRawSchema = z.object({
  rules: z.array(WorkflowWideRuleEntrySchema).optional(),
}).strict().optional();

const WorkflowResultLabelSchema = z.string().trim().min(1);

/** Rule-based transition schema (new unified format) */
export const WorkflowRuleSchema = z.object({
  condition: WorkflowRuleConditionRawSchema,
  next: z.string().min(1).optional(),
  return: WorkflowResultLabelSchema.optional(),
  appendix: z.string().optional(),
  requires_user_input: z.boolean().optional(),
  interactive_only: z.boolean().optional(),
}).strict();

const WorkflowRulesSchema = z.array(WorkflowRuleSchema).superRefine((rules, ctx) => {
  const semanticRules: SemanticAppendixRule[] = [];
  rules.forEach((rule, index) => {
    const condition = WorkflowRuleConditionRawSchema.safeParse(rule.condition);
    if (!condition.success) return;
    semanticRules.push({
      ruleIndex: index,
      condition: parseWorkflowRuleCondition(condition.data),
      appendix: rule.appendix,
    });
  });
  for (const conflict of findSemanticAppendixConflicts(semanticRules)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [conflict.ruleIndex, 'appendix'],
      message: `Rules sharing semantic label "${conflict.label}" must use the same appendix`,
    });
  }
});

function isSemanticWorkflowRuleCondition(condition: string): boolean {
  try {
    return parseWorkflowRuleCondition(condition).kind === 'semantic';
  } catch {
    return false;
  }
}

function validateWorkflowCallRules(
  rules: readonly z.output<typeof WorkflowRuleSchema>[] | undefined,
  ctx: z.core.$RefinementCtx,
  options: { allowExtendedConditions: boolean },
): void {
  rules?.forEach((rule, index) => {
    const isBuiltInCondition = rule.condition === 'COMPLETE' || rule.condition === 'ABORT';
    const isExtendedCondition = options.allowExtendedConditions
      && isSemanticWorkflowRuleCondition(rule.condition);

    if (!isBuiltInCondition && !isExtendedCondition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'condition'],
        message: options.allowExtendedConditions
          ? 'workflow_call rules only allow COMPLETE, ABORT, or callable return conditions'
          : 'workflow_call rules only allow COMPLETE or ABORT conditions',
      });
    }
  });
}

function validateParallelSubStepRules(
  rules: readonly z.output<typeof WorkflowRuleSchema>[] | undefined,
  ctx: z.core.$RefinementCtx,
): void {
  rules?.forEach((rule, index) => {
    const condition = WorkflowRuleConditionRawSchema.safeParse(rule.condition);
    if (!condition.success) return;
    if (!isParallelSubStepRuleCondition(parseWorkflowRuleCondition(condition.data))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'condition'],
        message: 'parallel sub-step rules do not allow aggregate conditions',
      });
    }
  });
}

function validateAggregateRulePlacement(
  rules: readonly z.output<typeof WorkflowRuleSchema>[] | undefined,
  aggregateAllowed: boolean,
  ctx: z.core.$RefinementCtx,
): void {
  if (aggregateAllowed) {
    return;
  }
  rules?.forEach((rule, index) => {
    const condition = WorkflowRuleConditionRawSchema.safeParse(rule.condition);
    if (!condition.success || !hasAggregateCondition(parseWorkflowRuleCondition(condition.data))) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules', index, 'condition'],
      message: 'aggregate conditions are only allowed on parallel parent steps with sub-steps',
    });
  });
}

const WorkflowPromotionRawSchema = z.object({
  at: z.number().int().positive().optional(),
  condition: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_LADDER_MESSAGE),
  provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_LADDER_MESSAGE),
  model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_LADDER_MESSAGE),
  provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_LADDER_MESSAGE),
}).strict().superRefine((data, ctx) => {
  if (data.at === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflow promotion entry requires "at"; only {at:N} advances the runtime.yaml ladder',
    });
  }
});

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

export const FacetPoolCandidateRawSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  policy: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  knowledge: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.policy === undefined && candidate.knowledge === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'Facet pool candidate requires at least one of "policy" or "knowledge"',
    });
  }
});

export const InlineFacetPoolRawSchema = z.object({
  policies: z.record(z.string(), z.string()).optional(),
  knowledge: z.record(z.string(), z.string()).optional(),
  candidates: z.array(FacetPoolCandidateRawSchema).min(1),
}).strict().superRefine((pool, ctx) => {
  const ids = new Set<string>();
  for (const [index, candidate] of pool.candidates.entries()) {
    if (ids.has(candidate.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates', index, 'id'],
        message: `Facet pool candidate id "${candidate.id}" is duplicate within this pool`,
      });
    }
    ids.add(candidate.id);
  }
});

export const ExternalFacetPoolRawSchema = z.object({
  uses: z.string().min(1),
}).strict();

export const FacetPoolRawSchema = z.union([
  InlineFacetPoolRawSchema,
  ExternalFacetPoolRawSchema,
]).superRefine((pool, ctx) => {
  if ('uses' in pool && ('policies' in pool || 'knowledge' in pool || 'candidates' in pool)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['uses'],
      message: 'Facet pool "uses" cannot be combined with inline "policies", "knowledge", or "candidates"',
    });
  }
});

export const DynamicFacetsRawSchema = z.object({
  pool: z.union([z.string().min(1), WorkflowParamReferenceRawSchema]),
  max_selected: z.number().int().positive().optional(),
  selector: SelectorGuidanceRawSchema.optional(),
}).strict();

/** Team leader configuration schema for dynamic part decomposition */
export const TeamLeaderConfigRawSchema = z.object({
  persona: z.string().optional(),
  max_parts: z.number().int().positive().max(3).optional(),
  max_concurrency: z.number().int().positive().max(3).optional(),
  initial_max_parts: z.number().int().positive().optional(),
  fail_on_part_error: z.boolean().optional(),
  refill_threshold: z.literal(0).optional(),
  timeout_ms: z.number().int().positive().optional(),
  inspect_tools: z.array(z.string()).optional(),
  part_persona: z.string().optional(),
  part_tags: z.array(z.string().min(1)).optional(),
  part_allowed_tools: z.array(z.string()).optional(),
  part_edit: z.boolean().optional(),
  part_permission_mode: PermissionModeSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.max_parts !== undefined && data.max_concurrency !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max_concurrency'],
      message: "'max_parts' and 'max_concurrency' cannot be specified together",
    });
  }
});

/** Workflow step schema - raw YAML format */
const WorkflowStepKindSchema = z.enum(['agent', 'system', 'workflow_call']);

const CompletionRetryOptionsRawSchema = z.object({
  min_retry: z.number().int().min(0).max(MAX_COMPLETION_RETRY).optional(),
  max_retry: z.number().int().min(0).optional(),
  retry_instruction: WorkflowFacetRefOrParamSchema,
}).strict().superRefine((data, ctx) => {
  const minRetry = data.min_retry ?? 0;
  const maxRetry = data.max_retry ?? MAX_COMPLETION_RETRY;
  if (minRetry > maxRetry) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['min_retry'],
      message: 'completion_retry.min_retry must be less than or equal to max_retry',
    });
  }
});

const CompletionRetryRawSchema = CompletionRetryOptionsRawSchema;

function validateCompletionRetryOptIn(
  data: {
    completion_retry?: unknown;
    parallel?: unknown;
    arpeggio?: unknown;
    team_leader?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    data.completion_retry !== undefined
    && (data.parallel !== undefined || data.arpeggio !== undefined || data.team_leader !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completion_retry'],
      message: 'completion_retry is only supported on normal agent steps and parallel agent sub-steps',
    });
  }
}

const AgentParallelSubStepRawObjectSchema = z.object({
  name: WorkflowStepNameSchema,
  description: z.never().optional(),
  kind: z.never().optional(),
  mode: z.never().optional(),
  call: z.never().optional(),
  args: z.never().optional(),
  overrides: z.never().optional(),
  session_key: z.string().trim().min(1).optional(),
  session: z.enum(WORKFLOW_SESSION_MODES).optional(),
  persona: WorkflowPersonaRefOrParamSchema.optional(),
  persona_name: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  completion_retry: CompletionRetryRawSchema.optional(),
  policy: WorkflowFacetRefListOrParamSchema.optional(),
  knowledge: WorkflowFacetRefListOrParamSchema.optional(),
  allow_git_commit: z.boolean().optional(),
  allowed_tools: z.never().optional(),
  capabilities: WorkflowCapabilitiesRefSchema,
  mcp: WorkflowMcpRefListSchema,
  mcp_servers: McpServersSchema,
  provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  promotion: z.never().optional(),
  companion: z.never().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  edit: z.boolean().optional(),
  requires_user_input: z.never().optional(),
  instruction: WorkflowFacetRefOrParamSchema.optional(),
  instruction_template: z.never().optional(),
  delay_before_ms: z.never().optional(),
  structured_output: z.never().optional(),
  system_inputs: z.never().optional(),
  effects: z.never().optional(),
  rules: WorkflowRulesSchema.optional(),
  output_contracts: OutputContractsFieldSchema,
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional(),
  parallel: z.never().optional(),
  concurrency: z.never().optional(),
  arpeggio: z.never().optional(),
  team_leader: z.never().optional(),
  dynamic_facets: DynamicFacetsRawSchema.optional(),
});

function validateAgentParallelSubStepRules(
  data: {
    rules?: z.output<typeof WorkflowRulesSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  validateParallelSubStepRules(data.rules, ctx);
  data.rules?.forEach((rule, index) => {
    if (rule.return !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'return'],
        message: 'parallel sub-step rules do not allow "return"',
      });
    }
  });
}

const AgentParallelSubStepRawSchema = AgentParallelSubStepRawObjectSchema.superRefine(
  validateAgentParallelSubStepRules,
);

const WorkflowCallParallelSubStepRawSchema = z.object({
  name: WorkflowStepNameSchema,
  kind: z.literal('workflow_call').optional(),
  mode: z.never().optional(),
  call: WorkflowReferenceOrParamSchema,
  overrides: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  args: WorkflowCallArgsRawSchema.optional(),
  vars: WorkflowCallVarsRawSchema.optional(),
  description: z.string().optional(),
  session_key: z.never().optional(),
  session: z.never().optional(),
  persona: z.never().optional(),
  persona_name: z.never().optional(),
  tags: z.never().optional(),
  completion_retry: z.never().optional(),
  policy: z.never().optional(),
  knowledge: z.never().optional(),
  allow_git_commit: z.never().optional(),
  allowed_tools: z.never().optional(),
  mcp_servers: z.never().optional(),
  provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  promotion: z.never().optional(),
  companion: z.never().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: z.never().optional(),
  provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  edit: z.never().optional(),
  requires_user_input: z.never().optional(),
  instruction: z.never().optional(),
  instruction_template: z.never().optional(),
  delay_before_ms: z.never().optional(),
  structured_output: z.never().optional(),
  system_inputs: z.never().optional(),
  effects: z.never().optional(),
  rules: WorkflowRulesSchema.optional(),
  output_contracts: z.never().optional(),
  quality_gates: z.never().optional(),
  pass_previous_response: z.never().optional(),
  parallel: z.never().optional(),
  concurrency: z.never().optional(),
  arpeggio: z.never().optional(),
  team_leader: z.never().optional(),
  dynamic_facets: z.never().optional(),
}).superRefine((data, ctx) => {
  validateParallelSubStepRules(data.rules, ctx);
  validateWorkflowCallRules(data.rules, ctx, { allowExtendedConditions: true });
});

/** Sub-step schema for parallel execution */
export const ParallelSubStepRawSchema = z.union([
  WorkflowCallParallelSubStepRawSchema,
  AgentParallelSubStepRawSchema,
]);

const DynamicParallelPoolSubStepRawSchema = AgentParallelSubStepRawObjectSchema.extend({
  description: z.string().trim().min(1),
}).superRefine(validateAgentParallelSubStepRules);

const DynamicParallelRawSchema = z.object({
  fixed: z.array(AgentParallelSubStepRawSchema).optional().default([]),
  pool: z.array(DynamicParallelPoolSubStepRawSchema).min(1),
  selection: z.object({
    mode: z.enum(['replace', 'cumulative']).optional().default('replace'),
    reports: z.array(ReportRelativePathSchema).optional(),
    selector: SelectorGuidanceRawSchema.optional(),
  }).strict().optional().default({ mode: 'replace' }),
}).strict();

const CompanionSelectionRawSchema = z.union([
  z.array(z.string().trim().min(1)).min(1),
  WorkflowParamReferenceRawSchema,
  CompanionSelectionObjectRawSchema,
]);

const WorkflowSubworkflowRawSchema = z.object({
  callable: z.boolean().optional(),
  visibility: z.enum(['internal']).optional(),
  returns: z.array(WorkflowResultLabelSchema).optional(),
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
        return;
      }
      if (!isSemanticWorkflowRuleCondition(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['returns', index],
          message: `subworkflow.returns must use a semantic result label: "${value}"`,
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
    name: WorkflowStepNameSchema,
    description: z.string().optional(),
    session_key: z.string().trim().min(1).optional(),
    kind: WorkflowStepKindSchema.optional(),
    mode: z.literal('system').optional(),
    call: WorkflowReferenceOrParamSchema.optional(),
    overrides: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    args: WorkflowCallArgsRawSchema.optional(),
    vars: WorkflowCallVarsRawSchema.optional(),
    session: z.enum(WORKFLOW_SESSION_MODES).optional(),
    persona: WorkflowPersonaRefOrParamSchema.optional(),
    persona_name: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    completion_retry: CompletionRetryRawSchema.optional(),
    policy: WorkflowFacetRefListOrParamSchema.optional(),
    knowledge: WorkflowFacetRefListOrParamSchema.optional(),
    allow_git_commit: z.boolean().optional(),
    allowed_tools: z.never().optional(),
    capabilities: WorkflowCapabilitiesRefSchema,
    mcp: WorkflowMcpRefListSchema,
    mcp_servers: McpServersSchema,
    provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    promotion: z.array(WorkflowPromotionRawSchema).optional(),
    companion: CompanionSelectionRawSchema.optional(),
    permission_mode: z.never().optional(),
    required_permission_mode: PermissionModeSchema.optional(),
    provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    edit: z.boolean().optional(),
    requires_user_input: z.boolean().optional(),
    instruction: WorkflowFacetRefOrParamSchema.optional(),
    instruction_template: z.never().optional(),
    delay_before_ms: z.number().int().min(0).optional(),
    structured_output: StructuredOutputRawSchema.optional(),
    system_inputs: z.array(SystemInputRawSchema).optional(),
    effects: z.array(WorkflowEffectRawSchema).optional(),
    rules: WorkflowRulesSchema.optional(),
    output_contracts: OutputContractsFieldSchema,
    quality_gates: QualityGatesSchema,
    pass_previous_response: z.boolean().optional(),
    parallel: z.union([z.array(ParallelSubStepRawSchema), DynamicParallelRawSchema]).optional(),
    concurrency: z.number().int().min(1).optional(),
    arpeggio: ArpeggioConfigRawSchema.optional(),
    team_leader: TeamLeaderConfigRawSchema.optional(),
    dynamic_facets: DynamicFacetsRawSchema.optional(),
  }).refine(
    (data) => [data.parallel, data.arpeggio, data.team_leader].filter((value) => value != null).length <= 1,
    {
      message: "'parallel', 'arpeggio', and 'team_leader' are mutually exclusive",
      path: ['parallel'],
    },
  ).superRefine((data, ctx) => {
    validateCompletionRetryOptIn(data, ctx);
    if (data.kind !== undefined && data.mode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'Step kind must be expressed with either "kind" or "mode", not both',
      });
    }

    const stepKind = getWorkflowStepKind(data);
    if (data.completion_retry !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completion_retry'],
        message: 'completion_retry is only supported on agent steps',
      });
    }
    if (stepKind !== 'workflow_call') {
      const hasParallelSubSteps = Array.isArray(data.parallel)
        ? data.parallel.length > 0
        : data.parallel !== undefined;
      validateAggregateRulePlacement(data.rules, hasParallelSubSteps, ctx);
    }
    if (data.session_key !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session_key'],
        message: 'session_key is only supported on agent steps and parallel sub-steps',
      });
    }

    if (data.session_key !== undefined && data.parallel !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session_key'],
        message: 'session_key is not supported on parallel parent steps; set it on each parallel sub-step',
      });
    }

    if (data.session !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session'],
        message: SESSION_AGENT_STEP_REQUIRED_MESSAGE,
      });
    }

    if (
      data.session !== undefined
      && (data.parallel !== undefined || data.arpeggio !== undefined || data.team_leader !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session'],
        message: SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
      });
    }

    if (data.requires_user_input !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requires_user_input'],
        message: 'requires_user_input is only supported on agent steps',
      });
    }

    if (data.requires_user_input !== undefined && data.parallel !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requires_user_input'],
        message: 'requires_user_input is not supported on parallel parent steps',
      });
    }

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

    if (data.vars !== undefined && stepKind !== 'workflow_call') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vars'],
        message: 'Only workflow_call steps can declare "vars"',
      });
    }

    if (data.promotion !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotion'],
        message: 'promotion is only allowed on agent steps',
      });
    }

    if (
      data.promotion !== undefined
      && (data.parallel !== undefined || data.arpeggio !== undefined || data.team_leader !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotion'],
        message: 'promotion is only allowed on normal agent steps',
      });
    }

    if (data.companion !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companion'],
        message: 'companion is only allowed on normal agent steps',
      });
    }

    if (
      data.companion !== undefined
      && (data.parallel !== undefined || data.arpeggio !== undefined || data.team_leader !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companion'],
        message: 'companion is only allowed on normal agent steps',
      });
    }

    if (data.dynamic_facets !== undefined && stepKind !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dynamic_facets'],
        message: 'dynamic_facets is only allowed on normal agent steps',
      });
    }

    if (
      data.dynamic_facets !== undefined
      && (data.parallel !== undefined || data.arpeggio !== undefined || data.team_leader !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dynamic_facets'],
        message: 'dynamic_facets is only allowed on normal agent steps',
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
        'tags',
        'completion_retry',
        'policy',
        'knowledge',
        'allow_git_commit',
        'mcp_servers',
        'provider',
        'model',
        'promotion',
        'companion',
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
        'dynamic_facets',
      ] as const) {
        if (data[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `workflow_call step does not allow "${field}"`,
          });
        }
      }

      validateWorkflowCallRules(data.rules, ctx, {
        allowExtendedConditions: options?.relaxWorkflowCallConditions === true,
      });
    }

    validateSystemStepFields(data, ctx);
  }).transform((data) => {
    if (getWorkflowStepKind(data) !== 'agent') {
      return data;
    }

    return {
      ...data,
      allow_git_commit: data.allow_git_commit ?? false,
      ...(data.companion === undefined
        ? {}
        : {
            companion: Array.isArray(data.companion)
              ? { fixed: data.companion, pool: [] }
              : data.companion,
          }),
    };
  });
}

export const WorkflowStepRawSchema = createWorkflowStepRawSchema();
const WorkflowConfigStepRawSchema = createWorkflowStepRawSchema({ relaxWorkflowCallConditions: true });

/** Loop monitor rule schema */
export const LoopMonitorRuleSchema = z.object({
  condition: WorkflowRuleConditionRawSchema,
  next: z.string().min(1),
});

/** Loop monitor judge schema */
export const LoopMonitorJudgeSchema = z.object({
  session_key: z.never({ message: 'session_key is not supported on loop_monitors.judge; judges always use a fresh session' }).optional(),
  persona: z.string().optional(),
  provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
  instruction: z.string().optional(),
  instruction_template: z.never().optional(),
  rules: z.array(LoopMonitorRuleSchema).min(1),
}).superRefine((data, ctx) => {
  validateAggregateRulePlacement(data.rules, false, ctx);
});

/** Loop monitor configuration schema */
export const LoopMonitorSchema = z.object({
  cycle: z.array(z.string().min(1)).min(2),
  ignore_steps: z.array(z.string().min(1)).min(1).optional(),
  threshold: z.number().int().positive().optional().default(3),
  judge: LoopMonitorJudgeSchema,
}).superRefine((monitor, ctx) => {
  const cycleSteps = new Set(monitor.cycle);
  for (const [index, step] of (monitor.ignore_steps ?? []).entries()) {
    if (cycleSteps.has(step)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ignore_steps', index],
        message: `ignored step "${step}" cannot also be part of the monitored cycle`,
      });
    }
  }
});

/** Interactive mode schema for workflow-level default */
export const InteractiveModeSchema = z.enum(INTERACTIVE_MODES);

interface OutputContractStep {
  readonly output_contracts?: {
    readonly report?: readonly { readonly name: string }[];
  };
  readonly parallel?: readonly OutputContractStep[] | {
    readonly fixed: readonly OutputContractStep[];
    readonly pool: readonly OutputContractStep[];
  };
}

interface OutputContractProducer {
  readonly reportName: string;
  readonly stepPath: string;
  readonly parallelAncestry: ReadonlyMap<string, number>;
}

function canOutputContractProducersRunConcurrently(
  left: OutputContractProducer,
  right: OutputContractProducer,
): boolean {
  for (const [blockPath, leftBranch] of left.parallelAncestry) {
    const rightBranch = right.parallelAncestry.get(blockPath);
    if (rightBranch !== undefined && rightBranch !== leftBranch) {
      return true;
    }
  }
  return false;
}

function validateOutputContractIdentities(
  steps: readonly OutputContractStep[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[] = ['steps'],
  identities: Map<string, OutputContractProducer[]> = new Map(),
  parentParallelAncestry: ReadonlyMap<string, number> = new Map(),
  parallelBlockPath?: string,
): void {
  steps.forEach((step, stepIndex) => {
    const stepPath = [...path, stepIndex];
    const parallelAncestry = parallelBlockPath === undefined
      ? parentParallelAncestry
      : new Map(parentParallelAncestry).set(parallelBlockPath, stepIndex);
    const stepPathIdentity = JSON.stringify(stepPath);
    step.output_contracts?.report?.forEach((contract, contractIndex) => {
      const classification = classifyReportRelativePath(contract.name);
      if (classification.kind !== 'public') {
        return;
      }
      const current: OutputContractProducer = {
        reportName: contract.name,
        stepPath: stepPathIdentity,
        parallelAncestry,
      };
      const existing = identities.get(classification.portableIdentity) ?? [];
      const conflict = existing.find((candidate) => (
        candidate.reportName !== current.reportName
        || candidate.stepPath === current.stepPath
        || canOutputContractProducersRunConcurrently(candidate, current)
      ));
      if (conflict !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...stepPath, 'output_contracts', 'report', contractIndex, 'name'],
          message: `output contract report name "${contract.name}" collides with "${conflict.reportName}"`,
        });
        return;
      }
      identities.set(classification.portableIdentity, [...existing, current]);
    });
    if (step.parallel !== undefined) {
      const childBlockPath = JSON.stringify([...stepPath, 'parallel']);
      const parallelSteps = 'fixed' in step.parallel
        ? [...step.parallel.fixed, ...step.parallel.pool]
        : step.parallel;
      validateOutputContractIdentities(
        parallelSteps,
        ctx,
        [...stepPath, 'parallel'],
        identities,
        parallelAncestry,
        childBlockPath,
      );
    }
  });
}

/** Workflow configuration schema - raw YAML format */
export const WorkflowConfigRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  subworkflow: WorkflowSubworkflowRawSchema.optional(),
  workflow_config: z.object({
    provider: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    model: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    provider_options: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_PROVIDER_MESSAGE),
    runtime: RuntimeConfigSchema,
  }).strict().optional(),
  // Issue #1208: workflow-level capability-set reference (the default for every step) and the
  // portable, bundled MCP server definitions that step/sub-step `mcp:` references resolve against.
  capabilities: WorkflowCapabilitiesRefSchema,
  mcp_servers: McpServersSchema,
  auto_routing: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_ROUTING_MESSAGE),
  rate_limit_fallback: removedWorkflowRuntimeField(WORKFLOW_RUNTIME_ROUTING_MESSAGE),
  permission_mode: z.never().optional(),
  schemas: z.record(z.string(), z.string()).optional(),
  personas: z.record(z.string(), z.string()).optional(),
  policies: z.record(z.string(), z.string()).optional(),
  knowledge: z.record(z.string(), z.string()).optional(),
  instructions: z.record(z.string(), z.string()).optional(),
  report_formats: z.record(z.string(), z.string()).optional(),
  all_steps: WorkflowAllStepsRawSchema,
  facet_pools: z.record(z.string().min(1), FacetPoolRawSchema).optional(),
  steps: z.array(WorkflowConfigStepRawSchema).min(1),
  initial_step: z.string().optional(),
  max_steps: z.union([z.number().int().positive(), z.literal('infinite')]).optional().default(10),
  loop_monitors: z.array(LoopMonitorSchema).optional(),
  interactive_mode: InteractiveModeSchema.optional(),
}).strict().superRefine((workflow, ctx) => {
  validateOutputContractIdentities(workflow.steps as readonly OutputContractStep[], ctx);
});
