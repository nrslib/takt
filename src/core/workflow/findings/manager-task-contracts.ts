import { z } from 'zod';
import { FINDING_DISMISSAL_BASES } from '../../models/finding-types.js';
import {
  RAW_DECISION_KINDS,
  type FindingLifecycleEntityHead,
  type FindingManagerRawDecision,
  type FindingMutationPrecondition,
} from './types.js';

export const MAIN_MANAGER_RAW_TASK_MAX_ITEMS = 16;
export const ENTITY_BINDING_TASK_MAX_ITEMS = 128;
export const MAIN_MANAGER_INPUT_MAX_BYTES = 24_000;

const taskIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const componentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export interface MainManagerRawTask {
  taskId: string;
  ownedRawFindingIds: string[];
  componentIdByRawFindingId: ReadonlyMap<string, string>;
  capturedTargetHeads: ReadonlyMap<string, FindingLifecycleEntityHead | null>;
  rawFindings: FindingManagerRawTaskInput[];
}

export interface FindingManagerRawTaskInput {
  rawFindingId: string;
  componentId: string;
  targetFindingId: string | null;
  targetPrecondition: FindingMutationPrecondition | null;
}

export interface MainManagerRawTaskDecision extends FindingManagerRawDecision {
  componentId: string;
}

export interface MainManagerRawTaskOutput {
  taskId: string;
  decisions: MainManagerRawTaskDecision[];
}

const mainManagerRawTaskDecisionSchema = z.object({
  componentId: componentIdSchema,
  rawFindingId: z.string().min(1),
  decision: z.enum(RAW_DECISION_KINDS),
  anchorRelevance: z.enum(['relevant', 'not_relevant', 'not_applicable']),
  findingId: z.string(),
  evidence: z.string().min(1).max(2_048),
}).strict();

const mainManagerRawTaskOutputSchema = z.object({
  taskId: taskIdSchema,
  decisions: z.array(mainManagerRawTaskDecisionSchema)
    .max(MAIN_MANAGER_RAW_TASK_MAX_ITEMS),
}).strict();

export const MainManagerRawTaskOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'decisions'],
  properties: {
    taskId: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    decisions: {
      type: 'array',
      maxItems: MAIN_MANAGER_RAW_TASK_MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'componentId',
          'rawFindingId',
          'decision',
          'anchorRelevance',
          'findingId',
          'evidence',
        ],
        properties: {
          componentId: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
          },
          rawFindingId: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: RAW_DECISION_KINDS },
          anchorRelevance: {
            type: 'string',
            enum: ['relevant', 'not_relevant', 'not_applicable'],
          },
          findingId: { type: 'string' },
          evidence: { type: 'string', minLength: 1, maxLength: 2_048 },
        },
      },
    },
  },
} as const;

export function parseMainManagerRawTaskOutput(value: unknown): MainManagerRawTaskOutput {
  return mainManagerRawTaskOutputSchema.parse(value);
}

export const ENTITY_BINDING_DECISION_KINDS = [
  'bind_existing',
  'new_entity',
  'ambiguous',
] as const;

export type EntityBindingDecisionKind =
  typeof ENTITY_BINDING_DECISION_KINDS[number];

export interface FindingEntityBindingTaskOutput {
  taskId: string;
  decisions: Array<{
    rawFindingId: string;
    decision: EntityBindingDecisionKind;
    findingId: string;
    groupRawFindingId: string;
    reason: string;
  }>;
}

const findingEntityBindingTaskOutputSchema = z.object({
  taskId: taskIdSchema,
  decisions: z.array(z.object({
    rawFindingId: z.string().min(1),
    decision: z.enum(ENTITY_BINDING_DECISION_KINDS),
    findingId: z.string(),
    groupRawFindingId: z.string(),
    reason: z.string().min(1).max(2_048),
  }).strict()).max(ENTITY_BINDING_TASK_MAX_ITEMS),
}).strict();

export const FindingEntityBindingTaskOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'decisions'],
  properties: {
    taskId: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    decisions: {
      type: 'array',
      maxItems: ENTITY_BINDING_TASK_MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'rawFindingId',
          'decision',
          'findingId',
          'groupRawFindingId',
          'reason',
        ],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          decision: {
            type: 'string',
            enum: ENTITY_BINDING_DECISION_KINDS,
          },
          findingId: { type: 'string' },
          groupRawFindingId: { type: 'string' },
          reason: { type: 'string', minLength: 1, maxLength: 2_048 },
        },
      },
    },
  },
} as const;

export function parseFindingEntityBindingTaskOutput(
  value: unknown,
): FindingEntityBindingTaskOutput {
  return findingEntityBindingTaskOutputSchema.parse(value);
}

export const MAIN_MANAGER_CONTROL_TASK_KINDS = [
  'finding_control',
  'conflict',
] as const;

export type MainManagerControlTaskKind = typeof MAIN_MANAGER_CONTROL_TASK_KINDS[number];

export const MAIN_MANAGER_CONTROL_INTENT_KINDS = [
  'dispute',
  'conflict',
  'invalidate',
  'dismiss',
] as const;

export type MainManagerControlIntentKind =
  typeof MAIN_MANAGER_CONTROL_INTENT_KINDS[number];

export interface MainManagerControlIntent {
  intentId: string;
  kind: MainManagerControlIntentKind;
  entityId: string;
  note: string;
}

export interface MainManagerControlTask {
  taskId: string;
  kind: MainManagerControlTaskKind;
  ownedEntityIds: string[];
  targetHeads: ReadonlyMap<string, FindingLifecycleEntityHead | null>;
  conflictEvidenceSetHashes: ReadonlyMap<string, string>;
  candidateIntents: MainManagerControlIntent[];
}

const noActionResultSchema = z.object({
  kind: z.literal('no_action'),
  reason: z.string().min(1).max(2_048),
}).strict();

const disputeResultSchema = z.object({
  kind: z.enum(['waive', 'note']),
  findingId: z.string().min(1),
  reason: z.string().min(1).max(2_048),
  evidence: z.string().min(1).max(2_048),
}).strict();

const conflictResultSchema = z.object({
  kind: z.enum(['resolve', 'keep']),
  conflictId: z.string().min(1),
  evidence: z.string().min(1).max(2_048),
}).strict();

const invalidateResultSchema = z.object({
  kind: z.literal('invalidate'),
  findingId: z.string().min(1),
  evidence: z.string().min(1).max(2_048),
}).strict();

const dismissResultSchema = z.object({
  kind: z.literal('dismiss'),
  findingId: z.string().min(1),
  basis: z.enum(FINDING_DISMISSAL_BASES),
  reason: z.string().min(1).max(2_048),
}).strict();

export const MainManagerControlTaskResultSchema = z.union([
  noActionResultSchema,
  disputeResultSchema,
  conflictResultSchema,
  invalidateResultSchema,
  dismissResultSchema,
]);

export type MainManagerControlTaskResult = z.infer<
  typeof MainManagerControlTaskResultSchema
>;

export interface MainManagerControlTaskOutput {
  taskId: string;
  evaluations: Array<{
    intentId: string;
    result: MainManagerControlTaskResult;
  }>;
  selectedIntentId: string | null;
}

const mainManagerControlTaskOutputSchema = z.object({
  taskId: taskIdSchema,
  evaluations: z.array(z.object({
    intentId: taskIdSchema,
    result: MainManagerControlTaskResultSchema,
  }).strict()).max(16),
  selectedIntentId: taskIdSchema.nullable(),
}).strict();

const controlResultJsonSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'reason'],
    properties: {
      kind: { type: 'string', const: 'no_action' },
      reason: { type: 'string', minLength: 1, maxLength: 2_048 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'findingId', 'reason', 'evidence'],
    properties: {
      kind: { type: 'string', enum: ['waive', 'note'] },
      findingId: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1, maxLength: 2_048 },
      evidence: { type: 'string', minLength: 1, maxLength: 2_048 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'conflictId', 'evidence'],
    properties: {
      kind: { type: 'string', enum: ['resolve', 'keep'] },
      conflictId: { type: 'string', minLength: 1 },
      evidence: { type: 'string', minLength: 1, maxLength: 2_048 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'findingId', 'evidence'],
    properties: {
      kind: { type: 'string', const: 'invalidate' },
      findingId: { type: 'string', minLength: 1 },
      evidence: { type: 'string', minLength: 1, maxLength: 2_048 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'findingId', 'basis', 'reason'],
    properties: {
      kind: { type: 'string', const: 'dismiss' },
      findingId: { type: 'string', minLength: 1 },
      basis: { type: 'string', enum: FINDING_DISMISSAL_BASES },
      reason: { type: 'string', minLength: 1, maxLength: 2_048 },
    },
  },
] as const;

export const MainManagerControlTaskOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'evaluations', 'selectedIntentId'],
  properties: {
    taskId: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    evaluations: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['intentId', 'result'],
        properties: {
          intentId: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
          },
          result: {
            anyOf: controlResultJsonSchemas,
          },
        },
      },
    },
    selectedIntentId: {
      type: ['string', 'null'],
      pattern: '^[0-9a-f]{64}$',
    },
  },
} as const;

export function parseMainManagerControlTaskOutput(
  value: unknown,
): MainManagerControlTaskOutput {
  return mainManagerControlTaskOutputSchema.parse(value);
}
