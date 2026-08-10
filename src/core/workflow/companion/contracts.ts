import { z } from 'zod';
import { projectNativeStructuredOutputSchema } from '../../models/native-structured-output-schema.js';
import {
  assertCompanionOutputEnvelope,
  COMPANION_OUTPUT_LIMITS,
} from './output-envelope.js';

const CompanionFindingSeveritySchema = z.enum(['must_fix', 'should_fix', 'nit']);
const CompanionFindingUpdateStatusSchema = z.enum([
  'resolved',
  'unresolved',
  'wontfix_accepted',
]);
const CompanionFindingUpdatesSchema = z.array(z.object({
  id: z.string().min(1),
  status: CompanionFindingUpdateStatusSchema,
}).strict()).max(COMPANION_OUTPUT_LIMITS.maxArrayItems);

export const CompanionReviewOutputSchema = z.object({
  findings: z.array(z.object({
    severity: CompanionFindingSeveritySchema,
    file: z.string().min(1),
    line: z.number().int().positive(),
    finding: z.string().min(1),
  }).strict()).max(COMPANION_OUTPUT_LIMITS.maxArrayItems),
  updates: CompanionFindingUpdatesSchema,
  notes: z.string().nullable().optional(),
}).strict().transform(({ notes, ...output }) => ({
  ...output,
  ...(notes === null || notes === undefined ? {} : { notes }),
}));

export type CompanionReviewOutput = z.infer<typeof CompanionReviewOutputSchema>;

const REVIEW_OUTPUT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'updates', 'notes'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'finding'],
        properties: {
          severity: { type: 'string', enum: ['must_fix', 'should_fix', 'nit'] },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          finding: { type: 'string' },
        },
      },
      maxItems: COMPANION_OUTPUT_LIMITS.maxArrayItems,
    },
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['resolved', 'unresolved', 'wontfix_accepted'] },
        },
      },
      maxItems: COMPANION_OUTPUT_LIMITS.maxArrayItems,
    },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;

export const REVIEW_OUTPUT_JSON_SCHEMA = projectNativeStructuredOutputSchema(
  REVIEW_OUTPUT_VALIDATION_SCHEMA,
);

const MODERATOR_OUTPUT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'updates'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'sourceIndex', 'severity', 'finding', 'targetId'],
        properties: {
          action: { type: 'string', enum: ['accept', 'reject', 'merge', 'downgrade'] },
          sourceIndex: { type: 'integer', minimum: 0 },
          severity: {
            anyOf: [
              { type: 'string', enum: ['must_fix', 'should_fix', 'nit'] },
              { type: 'null' },
            ],
          },
          finding: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          targetId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      maxItems: COMPANION_OUTPUT_LIMITS.maxArrayItems,
    },
    updates: REVIEW_OUTPUT_VALIDATION_SCHEMA.properties.updates,
  },
} as const;

export const MODERATOR_OUTPUT_JSON_SCHEMA = projectNativeStructuredOutputSchema(
  MODERATOR_OUTPUT_VALIDATION_SCHEMA,
);

export const ModeratorOutputSchema = z.object({
  findings: z.array(z.object({
    action: z.enum(['accept', 'reject', 'merge', 'downgrade']),
    sourceIndex: z.number().int().nonnegative(),
    severity: z.enum(['must_fix', 'should_fix', 'nit']).nullable().optional(),
    finding: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
  }).strict()).max(COMPANION_OUTPUT_LIMITS.maxArrayItems),
  updates: CompanionFindingUpdatesSchema,
}).strict().transform(({ findings, updates }) => ({
  findings: findings.map(({ severity, finding, targetId, ...decision }) => ({
    ...decision,
    ...(severity === null || severity === undefined ? {} : { severity }),
    ...(finding === null || finding === undefined ? {} : { finding }),
    ...(targetId === null || targetId === undefined ? {} : { targetId }),
  })),
  updates,
}));

const LOOP_JUDGE_OUTPUT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['continue', 'escalate'] },
    reason: { type: 'string' },
  },
} as const;

export const LOOP_JUDGE_OUTPUT_JSON_SCHEMA = projectNativeStructuredOutputSchema(
  LOOP_JUDGE_OUTPUT_VALIDATION_SCHEMA,
);

export const LoopJudgeOutputSchema = z.object({
  decision: z.enum(['continue', 'escalate']),
  reason: z.string(),
}).strict();

export function parseCompanionReviewOutput(value: unknown): CompanionReviewOutput {
  assertCompanionOutputEnvelope(value);
  return CompanionReviewOutputSchema.parse(value);
}

export type ModeratorOutput = z.infer<typeof ModeratorOutputSchema>;

export function parseModeratorOutput(value: unknown): ModeratorOutput {
  assertCompanionOutputEnvelope(value);
  return ModeratorOutputSchema.parse(value);
}

export type LoopJudgeOutput = z.infer<typeof LoopJudgeOutputSchema>;

export function parseLoopJudgeOutput(value: unknown): LoopJudgeOutput {
  assertCompanionOutputEnvelope(value);
  return LoopJudgeOutputSchema.parse(value);
}
