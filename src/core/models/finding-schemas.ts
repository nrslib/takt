import { z } from 'zod/v4';
import type {
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from './finding-types.js';
import {
  RAW_FINDING_KINDS,
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
} from './finding-types.js';

const nonEmptyString = z.string().min(1);

export const FindingContractManagerConfigRawSchema = z.object({
  persona: nonEmptyString,
  instruction: nonEmptyString,
  output_contract: nonEmptyString,
}).strict();

export const FindingContractConfigRawSchema = z.object({
  ledger_path: nonEmptyString,
  raw_findings_path: nonEmptyString,
  manager: FindingContractManagerConfigRawSchema,
}).strict();

export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export const FindingLifecycleSchema = z.enum(FINDING_LIFECYCLES);

export const FindingObservationSchema = z.object({
  runId: nonEmptyString,
  stepName: nonEmptyString,
  timestamp: nonEmptyString,
}).strict();

export const FindingLedgerEntrySchema = z.object({
  id: nonEmptyString,
  status: FindingStatusSchema,
  lifecycle: FindingLifecycleSchema,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  location: nonEmptyString.optional(),
  description: nonEmptyString.optional(),
  suggestion: nonEmptyString.optional(),
  reviewers: z.array(nonEmptyString),
  rawFindingIds: z.array(nonEmptyString),
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: nonEmptyString.optional(),
  resolvedEvidence: nonEmptyString.optional(),
  reopenedEvidence: nonEmptyString.optional(),
}).strict();

export const RawFindingSchema = z.object({
  rawFindingId: nonEmptyString,
  stepName: nonEmptyString,
  reviewer: nonEmptyString,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // 該当なしの欄は空文字で埋められる。空文字は未指定として扱う。
  location: z.string().optional().transform((value) => (value ? value : undefined)),
  description: nonEmptyString,
  suggestion: z.string().optional().transform((value) => (value ? value : undefined)),
  kind: z.enum(RAW_FINDING_KINDS).optional(),
  targetFindingId: nonEmptyString.optional(),
}).strict();

export const ReviewerRawFindingSchema = z.object({
  rawFindingId: nonEmptyString,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // 該当なしの欄は空文字で埋められる。空文字は未指定として扱う。
  location: z.string().optional().transform((value) => (value ? value : undefined)),
  description: nonEmptyString,
  suggestion: z.string().optional().transform((value) => (value ? value : undefined)),
  kind: z.enum(RAW_FINDING_KINDS).optional(),
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // issue 行は空文字で埋める。空文字は未指定として扱う。
  targetFindingId: z.string().optional().transform((value) => (value ? value : undefined)),
}).strict();

export const FindingLedgerConflictSchema = z.object({
  id: nonEmptyString,
  status: z.enum(FINDING_CONFLICT_STATUSES),
  findingIds: z.array(nonEmptyString),
  rawFindingIds: z.array(nonEmptyString),
  description: nonEmptyString,
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: nonEmptyString.optional(),
  resolvedEvidence: nonEmptyString.optional(),
}).strict();

export const FindingLedgerSchema = z.object({
  version: z.literal(1),
  workflowName: nonEmptyString,
  nextId: z.number().int().positive(),
  updatedAt: nonEmptyString,
  findings: z.array(FindingLedgerEntrySchema),
  rawFindings: z.array(RawFindingSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
}).strict();

export const FindingManagerOutputSchema = z.object({
  matches: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString.nullable().optional().transform((value) => value ?? undefined),
  }).strict()),
  newFindings: z.array(z.object({
    rawFindingIds: z.array(nonEmptyString),
    title: nonEmptyString,
    severity: FindingSeveritySchema,
  }).strict()),
  resolvedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString,
  }).strict()),
  reopenedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString,
  }).strict()),
  conflicts: z.array(z.object({
    findingIds: z.array(nonEmptyString).optional().default([]),
    rawFindingIds: z.array(nonEmptyString),
    description: nonEmptyString,
  }).strict()),
  resolvedConflicts: z.array(z.object({
    conflictId: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()),
}).strict();

export const FindingManagerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'newFindings', 'resolvedFindings', 'reopenedFindings', 'conflicts', 'resolvedConflicts'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: ['string', 'null'], minLength: 1 },
        },
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingIds', 'title', 'severity'],
        properties: {
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          title: { type: 'string', minLength: 1 },
          severity: { enum: FINDING_SEVERITIES },
        },
      },
    },
    resolvedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    reopenedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingIds', 'rawFindingIds', 'description'],
        properties: {
          findingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          rawFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
    resolvedConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['conflictId', 'evidence'],
        properties: {
          conflictId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

export const RawFindingsOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawFindings'],
  properties: {
    rawFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'kind', 'targetFindingId', 'familyTag', 'severity', 'title', 'location', 'description', 'suggestion'],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          kind: {
            enum: RAW_FINDING_KINDS,
            description: 'issue = observed problem. resolution_confirmation = verified that an open ledger finding is fixed.',
          },
          targetFindingId: {
            type: 'string',
            description: 'Ledger finding id being confirmed as resolved. Empty string for issue entries.',
          },
          familyTag: {
            type: 'string',
            minLength: 1,
            description: 'Structured form of the Observed Findings family_tag value.',
          },
          severity: { enum: FINDING_SEVERITIES },
          title: { type: 'string', minLength: 1 },
          location: {
            type: 'string',
            description: 'file:line evidence. Empty string when not applicable.',
          },
          description: { type: 'string', minLength: 1 },
          suggestion: {
            type: 'string',
            description: 'Fix direction. Empty string when not applicable (e.g. resolution confirmations).',
          },
        },
      },
    },
  },
} as const;

export function parseFindingLedger(value: unknown): FindingLedger {
  return FindingLedgerSchema.parse(value);
}

export function parseRawFindings(value: unknown): RawFinding[] {
  return z.array(RawFindingSchema).parse(value);
}

export function parseReviewerRawFindings(value: unknown): Array<z.infer<typeof ReviewerRawFindingSchema>> {
  return z.array(ReviewerRawFindingSchema).parse(value);
}

export function parseFindingManagerOutput(value: unknown): FindingManagerOutput {
  return FindingManagerOutputSchema.parse(value);
}
