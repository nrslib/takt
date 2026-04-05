/**
 * Workflow YAML schemas and alias normalization.
 */

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { INTERACTIVE_MODES } from './interactive-mode.js';
import {
  McpServersSchema,
  MovementProviderOptionsSchema,
  OutputContractsFieldSchema,
  PermissionModeSchema,
  PieceProviderOptionsSchema,
  ProviderReferenceSchema,
  QualityGatesSchema,
} from './schema-base.js';

/** Rule-based transition schema (new unified format) */
export const PieceRuleSchema = z.object({
  condition: z.string().min(1),
  next: z.string().min(1).optional(),
  appendix: z.string().optional(),
  requires_user_input: z.boolean().optional(),
  interactive_only: z.boolean().optional(),
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

/** Sub-movement schema for parallel execution */
export const ParallelSubMovementRawSchema = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
  persona_name: z.string().optional(),
  policy: z.union([z.string(), z.array(z.string())]).optional(),
  knowledge: z.union([z.string(), z.array(z.string())]).optional(),
  allowed_tools: z.never().optional(),
  mcp_servers: McpServersSchema,
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: MovementProviderOptionsSchema,
  edit: z.boolean().optional(),
  allow_git_commit: z.boolean().optional().default(false),
  instruction: z.string().optional(),
  instruction_template: z.never().optional(),
  rules: z.array(PieceRuleSchema).optional(),
  output_contracts: OutputContractsFieldSchema,
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional().default(true),
});

/** Piece movement schema - raw YAML format */
export const PieceMovementRawSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  session: z.enum(['continue', 'refresh']).optional(),
  persona: z.string().optional(),
  persona_name: z.string().optional(),
  policy: z.union([z.string(), z.array(z.string())]).optional(),
  knowledge: z.union([z.string(), z.array(z.string())]).optional(),
  allowed_tools: z.never().optional(),
  mcp_servers: McpServersSchema,
  provider: ProviderReferenceSchema.optional(),
  model: z.string().optional(),
  permission_mode: z.never().optional(),
  required_permission_mode: PermissionModeSchema.optional(),
  provider_options: MovementProviderOptionsSchema,
  edit: z.boolean().optional(),
  allow_git_commit: z.boolean().optional().default(false),
  instruction: z.string().optional(),
  instruction_template: z.never().optional(),
  rules: z.array(PieceRuleSchema).optional(),
  output_contracts: OutputContractsFieldSchema,
  quality_gates: QualityGatesSchema,
  pass_previous_response: z.boolean().optional().default(true),
  parallel: z.array(ParallelSubMovementRawSchema).optional(),
  concurrency: z.number().int().min(1).optional(),
  arpeggio: ArpeggioConfigRawSchema.optional(),
  team_leader: TeamLeaderConfigRawSchema.optional(),
}).refine(
  (data) => [data.parallel, data.arpeggio, data.team_leader].filter((value) => value != null).length <= 1,
  {
    message: "'parallel', 'arpeggio', and 'team_leader' are mutually exclusive",
    path: ['parallel'],
  },
);

/** Loop monitor rule schema */
export const LoopMonitorRuleSchema = z.object({
  condition: z.string().min(1),
  next: z.string().min(1),
});

/** Loop monitor judge schema */
export const LoopMonitorJudgeSchema = z.object({
  persona: z.string().optional(),
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

/** Interactive mode schema for piece-level default */
export const InteractiveModeSchema = z.enum(INTERACTIVE_MODES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeParallelSubMovementAliases(item: unknown): unknown {
  if (!isPlainRecord(item)) {
    return item;
  }

  const name = typeof item.name === 'string' ? item.name : undefined;
  const step = typeof item.step === 'string' ? item.step : undefined;
  if (name !== undefined && step !== undefined && name !== step) {
    throw new Error("Workflow definition conflict: parallel sub-step 'step' and 'name' must match when both are set.");
  }

  const resolvedName = name ?? step;
  const rest = { ...item };
  delete rest.step;

  if (resolvedName === undefined) {
    return rest;
  }

  return { ...rest, name: resolvedName };
}

function normalizeMovementsParallelAliases(movements: unknown): unknown {
  if (!Array.isArray(movements)) {
    return movements;
  }

  return movements.map((movement) => {
    if (!isPlainRecord(movement) || !Array.isArray(movement.parallel)) {
      return movement;
    }

    return {
      ...movement,
      parallel: movement.parallel.map((subMovement) => normalizeParallelSubMovementAliases(subMovement)),
    };
  });
}

function normalizePieceConfigAliases(input: unknown): unknown {
  if (!isPlainRecord(input)) {
    return input;
  }

  const {
    workflow_config: rawWorkflowConfig,
    steps: rawSteps,
    movements: rawMovements,
    initial_step: rawInitialStep,
    initial_movement: rawInitialMovement,
    max_steps: rawMaxSteps,
    max_movements: rawMaxMovements,
    ...rest
  } = input;

  const workflowConfig = rawWorkflowConfig;
  const pieceConfig = rest.piece_config;
  if (
    workflowConfig !== undefined
    && pieceConfig !== undefined
    && !isDeepStrictEqual(workflowConfig, pieceConfig)
  ) {
    throw new Error("Workflow definition conflict: 'workflow_config' and 'piece_config' must match when both are set.");
  }

  const normalizedSteps = rawSteps !== undefined ? normalizeMovementsParallelAliases(rawSteps) : undefined;
  const normalizedMovements = rawMovements !== undefined ? normalizeMovementsParallelAliases(rawMovements) : undefined;
  if (
    normalizedSteps !== undefined
    && normalizedMovements !== undefined
    && !isDeepStrictEqual(normalizedSteps, normalizedMovements)
  ) {
    throw new Error("Workflow definition conflict: 'steps' and 'movements' must match when both are set.");
  }

  const initialMovement = typeof rawInitialMovement === 'string' ? rawInitialMovement : undefined;
  const initialStep = typeof rawInitialStep === 'string' ? rawInitialStep : undefined;
  if (initialMovement !== undefined && initialStep !== undefined && initialMovement !== initialStep) {
    throw new Error("Workflow definition conflict: 'initial_step' and 'initial_movement' must match when both are set.");
  }

  const maxMovements = typeof rawMaxMovements === 'number' ? rawMaxMovements : undefined;
  const maxSteps = typeof rawMaxSteps === 'number' ? rawMaxSteps : undefined;
  if (maxMovements !== undefined && maxSteps !== undefined && maxMovements !== maxSteps) {
    throw new Error("Workflow definition conflict: 'max_steps' and 'max_movements' must match when both are set.");
  }

  const resolvedMovements = normalizedSteps ?? normalizedMovements;
  const resolvedInitialMovement = initialMovement ?? initialStep;
  const resolvedMaxMovements = maxMovements ?? maxSteps;

  return {
    ...rest,
    ...(workflowConfig !== undefined ? { piece_config: workflowConfig } : {}),
    ...(resolvedMovements !== undefined ? { movements: resolvedMovements } : {}),
    ...(resolvedInitialMovement !== undefined ? { initial_movement: resolvedInitialMovement } : {}),
    ...(resolvedMaxMovements !== undefined ? { max_movements: resolvedMaxMovements } : {}),
  };
}

/** Piece configuration schema - raw YAML format */
export const PieceConfigRawSchema = z.preprocess(
  normalizePieceConfigAliases,
  z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    piece_config: PieceProviderOptionsSchema,
    workflow_config: PieceProviderOptionsSchema,
    permission_mode: z.never().optional(),
    personas: z.record(z.string(), z.string()).optional(),
    policies: z.record(z.string(), z.string()).optional(),
    knowledge: z.record(z.string(), z.string()).optional(),
    instructions: z.record(z.string(), z.string()).optional(),
    report_formats: z.record(z.string(), z.string()).optional(),
    movements: z.array(PieceMovementRawSchema).min(1),
    steps: z.array(PieceMovementRawSchema).min(1).optional(),
    initial_movement: z.string().optional(),
    initial_step: z.string().optional(),
    max_steps: z.number().int().positive().optional(),
    max_movements: z.number().int().positive().optional().default(10),
    loop_monitors: z.array(LoopMonitorSchema).optional(),
    interactive_mode: InteractiveModeSchema.optional(),
  }).transform(({
    workflow_config: _workflowConfig,
    steps: _steps,
    initial_step: _initialStep,
    max_steps: _maxSteps,
    ...config
  }) => config)
);
