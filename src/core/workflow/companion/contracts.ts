import { z } from 'zod';
import { projectNativeStructuredOutputSchema } from '../../models/native-structured-output-schema.js';
import {
  assertCompanionOutputEnvelope,
  COMPANION_OUTPUT_LIMITS,
} from './output-envelope.js';

const CompanionFindingSeveritySchema = z.enum(['must_fix', 'should_fix', 'nit']);

export const CompanionReviewOutputSchema = z.object({
  findings: z.array(z.object({
    severity: CompanionFindingSeveritySchema,
    file: z.string().min(1),
    line: z.number().int().positive(),
    finding: z.string().min(1),
  }).strict()).max(COMPANION_OUTPUT_LIMITS.maxArrayItems),
  notes: z.string().nullable().optional(),
}).strict().transform(({ notes, ...output }) => ({
  ...output,
  ...(notes === null || notes === undefined ? {} : { notes }),
}));

export type CompanionReviewOutput = z.infer<typeof CompanionReviewOutputSchema>;

const REVIEW_OUTPUT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'notes'],
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
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;

export const REVIEW_OUTPUT_JSON_SCHEMA = projectNativeStructuredOutputSchema(
  REVIEW_OUTPUT_VALIDATION_SCHEMA,
);

const MODERATOR_OUTPUT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'sourceIndex'],
        properties: {
          action: { type: 'string', enum: ['accept', 'reject'] },
          sourceIndex: { type: 'integer', minimum: 0 },
        },
      },
      maxItems: COMPANION_OUTPUT_LIMITS.maxArrayItems,
    },
  },
} as const;

export const MODERATOR_OUTPUT_JSON_SCHEMA = projectNativeStructuredOutputSchema(
  MODERATOR_OUTPUT_VALIDATION_SCHEMA,
);

export const ModeratorOutputSchema = z.object({
  findings: z.array(z.object({
    action: z.enum(['accept', 'reject']),
    sourceIndex: z.number().int().nonnegative(),
  }).strict()).max(COMPANION_OUTPUT_LIMITS.maxArrayItems),
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
