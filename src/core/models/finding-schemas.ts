import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingManagerDecisions,
  FindingManagerOutput,
  RawFinding,
  RawFindingRelation,
} from './finding-types.js';
import {
  RAW_FINDING_KINDS,
  RAW_FINDING_RELATIONS,
  CONFLICT_DECISION_KINDS,
  DISPUTE_DECISION_KINDS,
  FINDING_CONFLICT_ADJUDICATION_OUTCOMES,
  FINDING_CONFLICT_ADJUDICATION_TRANSITIONS,
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
  invalidatedAt: nonEmptyString.optional(),
  invalidatedEvidence: nonEmptyString.optional(),
  supersededByFindingId: nonEmptyString.optional(),
}).strict();

/**
 * Derives the authoritative `relation` from a parsed raw finding whose `relation`
 * field may be absent (pre-existing data, or a schema predating this field).
 * Backward compatibility rule: relation undefined + kind 'resolution_confirmation'
 * -> 'resolution_confirmation'; relation undefined + kind 'issue'/undefined with
 * targetFindingId set -> 'persists' (this is exactly how pre-relation ledgers
 * recorded a re-report against an existing finding — real v3-r2 ledger data has
 * numerous kind:'issue' raws with targetFindingId set, e.g. "This is a
 * continuation of the issue tracked as F-0002"); relation undefined + kind
 * 'issue'/undefined with no targetFindingId -> 'new'.
 */
function deriveRawFindingRelation(
  kind: RawFinding['kind'],
  relation: RawFindingRelation | undefined,
  targetFindingId: string | undefined,
): RawFindingRelation {
  if (relation !== undefined) {
    return relation;
  }
  if (kind === 'resolution_confirmation') {
    return 'resolution_confirmation';
  }
  return targetFindingId !== undefined ? 'persists' : 'new';
}

interface RawFindingRelationFields {
  kind?: RawFinding['kind'];
  relation?: RawFindingRelation;
  targetFindingId?: string;
}

/**
 * Derives `relation` and validates the invariants from the feature spec in one
 * pass: relation=new forbids targetFindingId; every other relation requires it;
 * kind and relation must agree where both are present (kept for the transition
 * period — relation is authoritative, kind is retained for callers that have not
 * migrated). Shared by RawFindingSchema and ReviewerRawFindingSchema so the two
 * wire shapes (manager-facing vs. reviewer-facing) can't drift.
 */
function resolveRawFindingRelation<T extends RawFindingRelationFields>(
  value: T,
  ctx: z.RefinementCtx,
): T & { relation: RawFindingRelation } {
  const relation = deriveRawFindingRelation(value.kind, value.relation, value.targetFindingId);
  if (relation === 'new' && value.targetFindingId !== undefined) {
    ctx.addIssue({ code: 'custom', message: '"new" raw findings must not set targetFindingId', path: ['targetFindingId'] });
  }
  if (relation !== 'new' && value.targetFindingId === undefined) {
    ctx.addIssue({ code: 'custom', message: `"${relation}" raw findings require targetFindingId`, path: ['targetFindingId'] });
  }
  if (value.kind !== undefined) {
    const kindImpliesConfirmation = value.kind === 'resolution_confirmation';
    const relationIsConfirmation = relation === 'resolution_confirmation';
    if (kindImpliesConfirmation !== relationIsConfirmation) {
      ctx.addIssue({
        code: 'custom',
        message: `kind "${value.kind}" is inconsistent with relation "${relation}"`,
        path: ['relation'],
      });
    }
  }
  return { ...value, relation };
}

const RawFindingFieldsSchema = z.object({
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
  relation: z.enum(RAW_FINDING_RELATIONS).optional(),
  targetFindingId: nonEmptyString.optional(),
}).strict();

export const RawFindingSchema = RawFindingFieldsSchema.transform(resolveRawFindingRelation);

const ReviewerRawFindingFieldsSchema = z.object({
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
  relation: z.enum(RAW_FINDING_RELATIONS).optional(),
  // 構造化出力の strict 様式では全プロパティが required になるため、
  // issue 行は空文字で埋める。空文字は未指定として扱う。
  targetFindingId: z.string().optional().transform((value) => (value ? value : undefined)),
}).strict();

export const ReviewerRawFindingSchema = ReviewerRawFindingFieldsSchema.transform(resolveRawFindingRelation);

export const FindingConflictAdjudicationOutcomeSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_OUTCOMES);
export const FindingConflictAdjudicationTransitionSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_TRANSITIONS);

export const FindingConflictAdjudicationRecordSchema = z.object({
  evidenceHash: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  findingTransition: FindingConflictAdjudicationTransitionSchema,
  evidence: z.array(nonEmptyString),
  actionableFix: z.string(),
  decidedAt: FindingObservationSchema,
}).strict();

export const FindingConflictAdjudicationAttemptSchema = z.object({
  evidenceHash: nonEmptyString,
  startedAt: FindingObservationSchema,
  originStep: nonEmptyString.optional(),
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
  adjudications: z.array(FindingConflictAdjudicationRecordSchema).optional(),
  adjudicationAttempts: z.array(FindingConflictAdjudicationAttemptSchema).optional(),
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
  // 追加的（既存台帳 v1 の内部表現に対して後方互換）。既存呼び出しはこの2配列を
  // 渡さないことがあるため default([]) で補う。
  invalidatedFindings: z.array(z.object({
    findingId: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
  duplicateFindings: z.array(z.object({
    canonicalFindingId: nonEmptyString,
    duplicateFindingIds: z.array(nonEmptyString),
    evidence: nonEmptyString,
  }).strict()).optional().default([]),
}).strict();

// LLM に返させるのは判断だけ。8配列への組み立てと不変条件の強制は
// decision-assembly.ts（コード側）が行う。findingId は same/resolved/reopened/
// conflict でのみ必須なため、strict 様式の制約上は required に含めつつ、
// 該当なし（new/unsupported）は空文字で埋めさせて未指定として扱う。
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

/** Candidate eligibility (which findingId values may appear here) is enforced by decision-assembly.ts, not by this schema — see FindingManagerInvalidateDecision. */
export const FindingManagerInvalidateDecisionSchema = z.object({
  findingId: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDuplicateDecisionSchema = z.object({
  canonicalFindingId: nonEmptyString,
  duplicateFindingIds: z.array(nonEmptyString).min(1),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDecisionsSchema = z.object({
  rawDecisions: z.array(FindingManagerRawDecisionSchema),
  disputeDecisions: z.array(FindingManagerDisputeDecisionSchema),
  conflictDecisions: z.array(FindingManagerConflictDecisionSchema),
  invalidateDecisions: z.array(FindingManagerInvalidateDecisionSchema).optional().default([]),
  duplicateDecisions: z.array(FindingManagerDuplicateDecisionSchema).optional().default([]),
}).strict();

export const FindingManagerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'newFindings', 'resolvedFindings', 'reopenedFindings', 'conflicts', 'resolvedConflicts', 'waivedFindings', 'disputeNotes', 'invalidatedFindings', 'duplicateFindings'],
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
    invalidatedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    duplicateFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalFindingId', 'duplicateFindingIds', 'evidence'],
        properties: {
          canonicalFindingId: { type: 'string', minLength: 1 },
          duplicateFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
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
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions', 'invalidateDecisions', 'duplicateDecisions'],
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
            description: 'same = matches an existing open finding (familyTag and line-number differences alone are not disqualifying; judge by failure mode, trigger, impact, and required fix). new = no related finding exists yet. resolved = confirms an existing open finding is fixed. reopened = a previously resolved/waived finding reappeared. conflict = contradicts an existing finding. unsupported = the raw finding explicitly referenced an existing finding (targetFindingId) as persists/reopened but the reference does not hold up; do not fall back to new.',
          },
          findingId: {
            type: 'string',
            description: 'Ledger finding id. Required for same/resolved/reopened/conflict. Empty string for new/unsupported.',
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
    invalidateDecisions: {
      type: 'array',
      description: 'One optional decision per finding id listed as an invalidation candidate in the prompt (the engine already deterministically verified its location fails). Leave empty when there are no candidates or you disagree with all of them. You cannot invalidate a finding that is not in the candidate list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    duplicateDecisions: {
      type: 'array',
      description: 'Merge open findings that are the same underlying problem (same failure mode, trigger, impact, and fix) into one canonical finding. Leave empty when there are no duplicates among the open findings shown.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalFindingId', 'duplicateFindingIds', 'evidence'],
        properties: {
          canonicalFindingId: { type: 'string', minLength: 1 },
          duplicateFindingIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

// LLM が返す一次出力。outcome と findingTransition の整合はスキーマでは強制しない
// （enum ペアの相互制約は JSON Schema / zod の素朴な組み合わせでは表現できない）。
// 整合の検証（不一致は reject して例外）と、outcome + actionableFix からの
// disposition 導出は adjudication-apply.ts の責務（"決定可能なものはコードで
// 処理し LLM には判断だけ残す" という Finding Contract 全体の設計方針に合わせる）。
export const FindingConflictAdjudicationOutputSchema = z.object({
  conflictId: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  findingTransition: FindingConflictAdjudicationTransitionSchema,
  evidence: z.array(nonEmptyString).min(1),
  actionableFix: z.string(),
}).strict();

export const FindingConflictAdjudicationOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conflictId', 'outcome', 'findingTransition', 'evidence', 'actionableFix'],
  properties: {
    conflictId: {
      type: 'string',
      minLength: 1,
      description: 'The conflict id given to you in the prompt. Echo it back unchanged.',
    },
    outcome: {
      enum: FINDING_CONFLICT_ADJUDICATION_OUTCOMES,
      description: 'finding_valid = the reviewer finding is legitimate and still stands; state the concrete coder fix in actionableFix so the workflow can route to the fix step (a finding_valid with an empty actionableFix is treated as undetermined). finding_stale = the finding no longer applies (already fixed, or the code it describes no longer exists). evidence_invalid = the finding\'s own premise does not hold (it was never a real problem). undetermined = you could not reach a conclusion from the evidence available.',
    },
    findingTransition: {
      enum: FINDING_CONFLICT_ADJUDICATION_TRANSITIONS,
      description: 'The finding-side effect that matches your outcome: finding_valid -> keep_open (the finding stays open for the coder to fix), finding_stale -> resolved, evidence_invalid -> invalidated, undetermined -> keep_open. The engine rejects output where this does not match outcome.',
    },
    evidence: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'Concrete evidence for your outcome. For findingTransition "resolved", include at least one file:line citation the engine can verify against the current code.',
    },
    actionableFix: {
      type: 'string',
      description: 'For finding_valid: the concrete code change the coder must make (REQUIRED, non-empty — leaving it empty downgrades your verdict to undetermined and blocks the run). Empty string for every other outcome.',
    },
  },
} as const;

export function parseFindingConflictAdjudicationOutput(value: unknown): FindingConflictAdjudicationOutput {
  return FindingConflictAdjudicationOutputSchema.parse(value);
}

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
        required: ['rawFindingId', 'kind', 'relation', 'targetFindingId', 'familyTag', 'severity', 'title', 'location', 'description', 'suggestion'],
        properties: {
          rawFindingId: { type: 'string', minLength: 1 },
          kind: {
            enum: RAW_FINDING_KINDS,
            description: 'Legacy field, kept for compatibility. issue = observed problem. resolution_confirmation = verified that an open ledger finding is fixed. Set relation instead; kind is derived from it (new/persists/reopened -> issue).',
          },
          relation: {
            enum: RAW_FINDING_RELATIONS,
            description: 'This finding\'s relationship to the ledger. new = a fresh observation with no target (targetFindingId must be empty). persists = you still observe an existing open finding (targetFindingId required). reopened = a previously resolved/waived finding reappeared (targetFindingId required). resolution_confirmation = you verified an open finding is fixed (targetFindingId required).',
          },
          targetFindingId: {
            type: 'string',
            description: 'Ledger finding id this entry refers to. Required for persists/reopened/resolution_confirmation. Empty string for new.',
          },
          familyTag: {
            type: 'string',
            minLength: 1,
            description: 'Structured form of the Observed Findings family_tag value. A classification/search hint only — it is not used to determine whether two findings are the same issue.',
          },
          severity: { enum: FINDING_SEVERITIES },
          title: { type: 'string', minLength: 1 },
          location: {
            type: 'string',
            description: 'file:line evidence. Empty string when not applicable. The line number is evidence of where you currently observed the issue, not part of its identity.',
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
