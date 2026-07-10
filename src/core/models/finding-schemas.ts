import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import type {
  FindingLedger,
  FindingManagerDecisions,
  FindingManagerOutput,
  RawFinding,
} from './finding-types.js';
import {
  RAW_FINDING_KINDS,
  CONFLICT_DECISION_KINDS,
  DISPUTE_DECISION_KINDS,
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RAW_DECISION_KINDS,
} from './finding-types.js';

const nonEmptyString = z.string().min(1);

export const FindingContractManagerConfigRawSchema = z.object({
  persona: nonEmptyString,
  instruction: nonEmptyString,
  output_contract: nonEmptyString,
  provider: z.enum(PROVIDER_TYPES).optional(),
  model: nonEmptyString.optional(),
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
  waivers: z.array(z.object({
    reason: nonEmptyString,
    evidence: nonEmptyString,
    decidedAt: FindingObservationSchema,
  }).strict()).optional(),
  disputes: z.array(z.object({
    reason: nonEmptyString,
    evidence: nonEmptyString,
    recordedAt: FindingObservationSchema,
  }).strict()).optional(),
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
  waivedFindings: z.array(z.object({
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
  disputeNotes: z.array(z.object({
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
}).strict();

// LLM に返させるのは判断だけ。8配列への組み立てと不変条件の強制は
// decision-assembly.ts（コード側）が行う。findingId は same/resolved/reopened/
// conflict でのみ必須なため、strict 様式の制約上は required に含めつつ、
// 該当なし（new）は空文字で埋めさせて未指定として扱う。
export const FindingManagerRawDecisionSchema = z.object({
  rawFindingId: nonEmptyString,
  decision: z.enum(RAW_DECISION_KINDS),
  findingId: z.string().optional().transform((value) => (value ? value : undefined)),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDisputeDecisionSchema = z.object({
  findingId: nonEmptyString,
  decision: z.enum(DISPUTE_DECISION_KINDS),
  reason: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

export const FindingManagerConflictDecisionSchema = z.object({
  conflictId: nonEmptyString,
  decision: z.enum(CONFLICT_DECISION_KINDS),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDecisionsSchema = z.object({
  rawDecisions: z.array(FindingManagerRawDecisionSchema),
  disputeDecisions: z.array(FindingManagerDisputeDecisionSchema),
  conflictDecisions: z.array(FindingManagerConflictDecisionSchema),
}).strict();

export const FindingManagerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'newFindings', 'resolvedFindings', 'reopenedFindings', 'conflicts', 'resolvedConflicts', 'waivedFindings', 'disputeNotes'],
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
    waivedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    disputeNotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

/**
 * findings-manager が実際に返す structured output。FindingManagerOutputJsonSchema
 * （8配列を自力で組み立てる旧形式、台帳の内部表現として残置）とは異なり、
 * raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを問う。
 * 組み立てと不変条件の強制は decision-assembly.ts が行うため、弱いモデルでも
 * 出力すべき形が単純になる。
 */
export const FindingManagerDecisionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions'],
  properties: {
    rawDecisions: {
      type: 'array',
      description: 'Exactly one decision per residual raw finding listed in the prompt.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'decision', 'findingId', 'evidence'],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          decision: {
            enum: RAW_DECISION_KINDS,
            description: 'same = matches an existing open finding. new = no related finding exists yet. resolved = confirms an existing open finding is fixed. reopened = a previously resolved/waived finding reappeared. conflict = contradicts an existing finding.',
          },
          findingId: {
            type: 'string',
            description: 'Ledger finding id. Required for same/resolved/reopened/conflict. Empty string for new.',
          },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    disputeDecisions: {
      type: 'array',
      description: 'One decision per finding id claimed in the "Disputed Findings" heading of the prior step response. Empty if there is no such heading.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'decision', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          decision: {
            enum: DISPUTE_DECISION_KINDS,
            description: 'waive = approve the dispute and remove the finding from the blocking set. note = reject the dispute and keep the finding open.',
          },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    conflictDecisions: {
      type: 'array',
      description: 'One decision per active conflict in the previous ledger. Empty if there is no active conflict.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['conflictId', 'decision', 'evidence'],
        properties: {
          conflictId: { type: 'string', minLength: 1 },
          decision: {
            enum: CONFLICT_DECISION_KINDS,
            description: 'resolve = the conflict is adjudicated. keep = the conflict is still unresolved.',
          },
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

export function parseFindingManagerDecisions(value: unknown): FindingManagerDecisions {
  return FindingManagerDecisionsSchema.parse(value);
}
