import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { compareRfc3339Timestamps, normalizeRfc3339Timestamp } from './rfc3339.js';
import { collectFindingLedgerProjectionInvariantViolations } from './finding-ledger-invariants.js';
import { computeInterpretationBatchId } from './finding-interpretation-identity.js';
import {
  RAW_FINDING_FIELD_LIMITS,
  RAW_FINDING_NORMALIZER_LIMITS,
} from './finding-contract-limits.js';
import {
  ProviderRawFindingIdSchema,
  RawFindingIdSchema,
} from './finding-contract-field-schemas.js';
import {
  computeCandidateIdentityHash,
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from './finding-claim-identity.js';
import {
  canonicalRawFindingEvidenceIdentity,
  findingEvidenceRecordIdentityViolation,
  SHA256_HEX_PATTERN,
} from './finding-evidence-record.js';
import type {
  ConflictAdjudicationProposal,
  TerminalAdjudicationProposal,
  FindingLedger,
  FindingManagerOutput,
  FindingManagerValidationReport,
  FindingMutationPrecondition,
  RawFinding,
  RawFindingRelation,
} from './finding-types.js';
import {
  RAW_FINDING_RELATIONS,
  CONFLICT_DECISION_KINDS,
  DISPUTE_DECISION_KINDS,
  FINDING_CONFLICT_STATUSES,
  FINDING_DISMISSAL_BASES,
  FINDING_LIFECYCLES,
  FINDING_LIFECYCLE_ENTITY_KINDS,
  FINDING_LIFECYCLE_OPERATIONS,
  FINDING_MANAGER_AUTHORITIES,
  FINDING_REJECTED_OBSERVATION_CODES,
  FINDING_PROVISIONAL_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RAW_AMBIGUITY_CODES,
  RAW_DECISION_KINDS,
  REVIEWER_ANOMALY_KINDS,
  SEMANTIC_FINDING_DISMISSAL_BASES,
} from './finding-types.js';

export {
  ProviderRawFindingIdSchema,
  RawFindingIdSchema,
} from './finding-contract-field-schemas.js';

const nonEmptyString = z.string().min(1);
const Sha256Schema = z.string().regex(SHA256_HEX_PATTERN);
const rawFindingIdString = RawFindingIdSchema;
const providerRawFindingIdString = ProviderRawFindingIdSchema;
const findingIdString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars);
const familyTagString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars);
const rawFindingTitleString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxTitleChars);

function validateFindingDismissalAuthority(
  dismissal: {
    basis: typeof FINDING_DISMISSAL_BASES[number];
    authority: typeof FINDING_MANAGER_AUTHORITIES[number];
    evidence?: string;
    taskQuote?: string;
    workflowTaskDigest?: string;
    adjudicationTaskId?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    dismissal.authority !== 'terminal_adjudication'
    && SEMANTIC_FINDING_DISMISSAL_BASES.some((basis) => basis === dismissal.basis)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['authority'],
      message: `dismissal basis "${dismissal.basis}" requires terminal_adjudication authority`,
    });
  }
  if (dismissal.basis === 'outside_task_scope') {
    if (
      dismissal.taskQuote === undefined
      || dismissal.workflowTaskDigest === undefined
      || dismissal.adjudicationTaskId === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskQuote'],
        message: 'outside_task_scope dismissal requires taskQuote, workflowTaskDigest, and adjudicationTaskId',
      });
    }
    if (dismissal.evidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'outside_task_scope dismissal uses taskQuote instead of evidence',
      });
    }
  } else if (
    dismissal.authority !== 'terminal_adjudication'
    && dismissal.evidence === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: `dismissal basis "${dismissal.basis}" requires evidence`,
    });
  }
}
const rawFindingDescriptionString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars);
const rawFindingSuggestionString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxSuggestionChars);
function validateBinarySortedUniqueSet(
  values: readonly string[],
  ctx: z.RefinementCtx,
  label: string,
): void {
  const canonical = [...new Set(values)].sort(compareBinaryStrings);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    ctx.addIssue({
      code: 'custom',
      message: `Expected a binary-sorted unique ${label} set`,
    });
  }
}
const BinarySortedUniqueStringSetSchema = z.array(nonEmptyString)
  .superRefine((values, ctx) => validateBinarySortedUniqueSet(values, ctx, 'string'));
const BinarySortedUniqueRawFindingIdSetSchema = z.array(rawFindingIdString)
  .superRefine((values, ctx) => validateBinarySortedUniqueSet(values, ctx, 'raw finding id'));
const BinarySortedUniqueSha256SetSchema = z.array(Sha256Schema)
  .superRefine((values, ctx) => validateBinarySortedUniqueSet(values, ctx, 'SHA-256'));
export const Rfc3339TimestampSchema = z.string().min(1).transform((timestamp, ctx) => {
  try {
    return normalizeRfc3339Timestamp(timestamp);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Expected a valid RFC 3339 timestamp',
    });
    return z.NEVER;
  }
});

export const FindingContractManagerConfigRawSchema = z.object({
  persona: nonEmptyString,
  instruction: nonEmptyString,
  output_contract: nonEmptyString,
  provider: z.enum(PROVIDER_TYPES).optional(),
  model: nonEmptyString.optional(),
}).strict();

/** 有限停止予算。両方省略可 — max_rounds は省略時に既定値 40、max_minutes は省略時は時間上限なし（opt-in）。 */
export const FindingContractStopBudgetRawSchema = z.object({
  max_rounds: z.number().int().positive().optional(),
  max_minutes: z.number().int().positive().optional(),
}).strict();

/** review-integrity 予算（review-integrity requirement）。省略可 — 省略時は review-integrity.ts の DEFAULT_REVIEW_INTEGRITY_BUDGET が補う。 */
export const FindingContractReviewBudgetRawSchema = z.object({
  max_review_rounds: z.number().int().positive().optional(),
}).strict();

export const FindingContractConfigRawSchema = z.object({
  manager: FindingContractManagerConfigRawSchema,
  stop_budget: FindingContractStopBudgetRawSchema.optional(),
  review_budget: FindingContractReviewBudgetRawSchema.optional(),
}).strict();

export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export const FindingLifecycleSchema = z.enum(FINDING_LIFECYCLES);

export const FindingMutationPreconditionSchema = z.object({
  targetFindingId: nonEmptyString,
  targetRevision: z.number().int().positive(),
  targetStatus: FindingStatusSchema,
  targetEvidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const FindingObservationSchema = z.object({
  runId: nonEmptyString,
  stepName: nonEmptyString,
  timestamp: Rfc3339TimestampSchema,
}).strict();

export const FindingLifecycleEntityHeadSchema = z.object({
  entityKind: z.enum(FINDING_LIFECYCLE_ENTITY_KINDS),
  entityId: nonEmptyString,
  revision: z.number().int().positive(),
  eventId: Sha256Schema,
  projectionDigest: Sha256Schema,
}).strict();

export const FindingLifecycleMutationTargetSchema = z.object({
  entityKind: z.enum(FINDING_LIFECYCLE_ENTITY_KINDS),
  entityId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema.nullable(),
}).strict();

export const FindingEvidenceBindingSchema = z.object({
  bindingId: Sha256Schema,
  evidenceId: Sha256Schema,
  claimIdentityHash: Sha256Schema.nullable(),
  sourceRawFindingId: rawFindingIdString.nullable(),
  sourceRawIntegrityDigest: Sha256Schema.nullable(),
  contributionOrigin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('external') }).strict(),
    z.object({
      kind: z.literal('interpretation_case'),
      caseId: Sha256Schema,
    }).strict(),
  ]),
  operation: z.enum(FINDING_LIFECYCLE_OPERATIONS),
  target: FindingLifecycleMutationTargetSchema,
}).strict();

const FindingAnchorAuthorityAdjudicationSchema = z.object({
  rawFindingId: rawFindingIdString,
  decision: z.literal('relevant'),
  managerOutputBinding: Sha256Schema,
}).strict();

export const FindingLifecycleReservationContextSchema = z.object({
  kind: z.literal('transaction'),
}).strict();

export const FindingLifecycleAuthoritySchema = z.union([
  z.object({
    kind: z.literal('verified_evidence'),
  }).strict(),
  z.object({
    kind: z.literal('engine_policy'),
    decisionKind: z.enum([
      'waive',
      'dispute',
      'semantic_duplicate',
    ]),
    decisionDigest: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal('engine_policy'),
    decisionKind: z.literal('anchor_relevance'),
    decisionDigest: Sha256Schema,
    anchorAdjudications: z.array(FindingAnchorAuthorityAdjudicationSchema)
      .min(1)
      .superRefine((adjudications, ctx) => {
        const rawFindingIds = adjudications.map((adjudication) => adjudication.rawFindingId);
        const canonical = [...new Set(rawFindingIds)].sort(compareBinaryStrings);
        if (
          canonical.length !== rawFindingIds.length
          || canonical.some((rawFindingId, index) => rawFindingId !== rawFindingIds[index])
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Expected binary-sorted unique anchor adjudications',
          });
        }
      }),
  }).strict(),
  z.object({
    kind: z.literal('verified_conflict_adjudication'),
    conflictId: nonEmptyString,
    conflictSnapshotId: Sha256Schema,
    attemptId: Sha256Schema,
    verificationDigest: Sha256Schema,
    proofRecordIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    kind: z.literal('verified_terminal_adjudication'),
    episodeId: Sha256Schema,
    attemptId: Sha256Schema,
    verificationDigest: Sha256Schema,
    proofRecordIds: BinarySortedUniqueStringSetSchema,
    scopeBindingIds: BinarySortedUniqueSha256SetSchema,
  }).strict(),
  z.object({
    kind: z.literal('interpretation_unreserved_landing'),
    roundIdentity: Sha256Schema,
    budgetScopeId: Sha256Schema,
    reason: z.enum([
      'manager-budget-exhausted',
      'manager-input-overflow',
      'manager-output-discarded',
      'interpretation-interrupted',
    ]),
    rawFindingIds: BinarySortedUniqueRawFindingIdSetSchema.min(1),
    rawCanonicalSnapshotIds: BinarySortedUniqueSha256SetSchema.min(1),
  }).strict(),
  z.object({
    kind: z.literal('interpretation_case_rejection'),
    caseSnapshotId: Sha256Schema,
    attemptId: Sha256Schema,
    classification: z.enum(['decision_rejected_stale', 'decision_rejected_raw_invalid']),
    rawFindingIds: BinarySortedUniqueRawFindingIdSetSchema.min(1),
    staleCauseDigests: BinarySortedUniqueSha256SetSchema,
  }).strict(),
  z.object({
    kind: z.literal('system'),
    action: z.enum([
      'record_recovery_attempt',
      'settle_action_recovery',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('rejected_observation'),
    rawFindingId: rawFindingIdString,
    rawIntegrityDigest: Sha256Schema,
    rejectionCode: z.enum(FINDING_REJECTED_OBSERVATION_CODES),
  }).strict(),
]);

export const FindingLifecycleReservationSchema = z.object({
  reservationId: Sha256Schema,
  mutationId: Sha256Schema,
  operation: z.enum(FINDING_LIFECYCLE_OPERATIONS),
  targets: z.array(FindingLifecycleMutationTargetSchema).min(1),
  evidenceBindingIds: BinarySortedUniqueSha256SetSchema,
  authority: FindingLifecycleAuthoritySchema,
  context: FindingLifecycleReservationContextSchema,
  reservedAt: FindingObservationSchema,
}).strict();

export const FindingLifecycleTransitionSchema = z.object({
  before: FindingLifecycleEntityHeadSchema.nullable(),
  after: FindingLifecycleEntityHeadSchema,
}).strict();

export const FindingLifecycleOutcomeSchema = z.object({
  kind: z.literal('projection_applied'),
}).strict();

export const FindingLifecycleEventSchema = z.object({
  eventId: Sha256Schema,
  mutationId: Sha256Schema,
  reservationId: Sha256Schema,
  operation: z.enum(FINDING_LIFECYCLE_OPERATIONS),
  transitions: z.array(FindingLifecycleTransitionSchema).min(1),
  evidenceBindingIds: BinarySortedUniqueSha256SetSchema,
  outcome: FindingLifecycleOutcomeSchema,
  resultDigest: Sha256Schema,
  occurredAt: FindingObservationSchema,
}).strict();

// ---------------------------------------------------------------------------
// typed evidence protocol（review-integrity protocol: admission control 強化）
// ---------------------------------------------------------------------------

export const FileQuoteEvidenceSchema = z.object({
  kind: z.literal('file_quote'),
  path: nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  verbatimExcerpt: nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptChars),
  snapshotId: Sha256Schema.max(RAW_FINDING_FIELD_LIMITS.maxSnapshotIdChars),
}).strict();

export const EngineProofEvidenceSchema = z.object({
  kind: z.literal('engine_proof'),
  proofId: Sha256Schema.max(RAW_FINDING_FIELD_LIMITS.maxProofIdChars),
}).strict();

/** RawFinding.evidence の discriminated union。 */
export const RawFindingEvidenceSchema = z.discriminatedUnion('kind', [
  FileQuoteEvidenceSchema,
  EngineProofEvidenceSchema,
]);

export const FindingTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('review_scope'),
  }).strict(),
  z.object({
    kind: z.literal('code'),
    paths: BinarySortedUniqueStringSetSchema.min(1),
  }).strict(),
  z.object({
    kind: z.literal('structure'),
    scope: z.object({
      kind: z.literal('review_scope'),
      roots: BinarySortedUniqueStringSetSchema.min(1),
    }).strict(),
    manifestTargets: BinarySortedUniqueStringSetSchema.min(1),
  }).strict(),
  z.object({
    kind: z.literal('absence'),
    predicate: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('path_state'),
        path: nonEmptyString,
        expected: z.literal('absent'),
      }).strict(),
      z.object({
        kind: z.literal('exact_literal_search'),
        roots: BinarySortedUniqueStringSetSchema.min(1),
        literal: nonEmptyString,
        textDomain: z.literal('utf8'),
      }).strict(),
    ]),
  }).strict(),
]);

export const CandidateSourceBindingSchema = z.object({
  reportDigest: Sha256Schema,
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
  excerptDigest: Sha256Schema,
}).strict().superRefine((binding, ctx) => {
  if (binding.endByte <= binding.startByte) {
    ctx.addIssue({
      code: 'custom',
      path: ['endByte'],
      message: 'endByte must be greater than startByte',
    });
  }
});

const RawFindingEvidenceSetSchema = z.array(RawFindingEvidenceSchema).max(16)
  .superRefine((evidence, ctx) => {
    const identities = evidence.map(canonicalRawFindingEvidenceIdentity);
    const canonical = [...new Set(identities)].sort(compareBinaryStrings);
    if (
      canonical.length !== identities.length
      || canonical.some((identity, index) => identity !== identities[index])
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'evidence must be a binary-sorted set of exact evidence records',
      });
    }
  });

const ClaimEvidenceSubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repository_manifest'),
    scope: z.object({
      kind: z.literal('review_scope'),
      roots: BinarySortedUniqueStringSetSchema.min(1),
    }).strict(),
    manifestTargets: BinarySortedUniqueStringSetSchema.min(1),
    observedTargets: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    kind: z.literal('repository_query'),
    predicate: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('path_state'),
        path: nonEmptyString,
        expected: z.literal('absent'),
      }).strict(),
      z.object({
        kind: z.literal('exact_literal_search'),
        roots: BinarySortedUniqueStringSetSchema.min(1),
        literal: nonEmptyString,
        textDomain: z.literal('utf8'),
      }).strict(),
    ]),
    result: z.enum(['absent', 'zero_matches']),
    coverage: z.literal('complete'),
  }).strict(),
  z.object({
    kind: z.literal('authoritative_quote'),
    source: z.enum(['task', 'public_declaration']),
    declarationId: nonEmptyString,
    verbatimExcerpt: nonEmptyString,
  }).strict(),
]);

const LifecycleAuthoritySubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('finding_provisional_isolation'),
    findingId: nonEmptyString,
    provisionalKind: z.enum(FINDING_PROVISIONAL_KINDS),
    stableKey: nonEmptyString,
  }).strict(),
  z.object({
    kind: z.literal('finding_target_invalid'),
    findingId: nonEmptyString,
    reason: nonEmptyString,
  }).strict(),
  z.object({
    kind: z.literal('finding_claim_sets_equal'),
    findingIds: BinarySortedUniqueStringSetSchema,
    semanticClaimIdentityHashes: BinarySortedUniqueSha256SetSchema,
  }).strict(),
  z.object({
    kind: z.literal('finding_provisional_product_transition'),
    operation: z.enum(['promote_provisional', 'reopen_finding']),
    findingId: nonEmptyString,
    provisionalStableKey: nonEmptyString,
    provisionalLineageKey: Sha256Schema,
    targetIdentityHash: Sha256Schema,
    sourceRawFindings: z.array(z.object({
      rawFindingId: rawFindingIdString,
      integrityDigest: Sha256Schema,
    }).strict()).min(1).superRefine((values, ctx) => {
      const rawFindingIds = values.map((value) => value.rawFindingId);
      const canonical = [...new Set(rawFindingIds)].sort(compareBinaryStrings);
      if (
        canonical.length !== rawFindingIds.length
        || canonical.some((rawFindingId, index) => rawFindingId !== rawFindingIds[index])
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Expected binary-sorted unique provisional transition raw findings',
        });
      }
    }),
    expectedProductRawFindingIds: BinarySortedUniqueRawFindingIdSetSchema.min(1),
    transitionPreconditionDigest: Sha256Schema,
    expectedIntermediateHead: z.object({
      revision: z.number().int().positive(),
      projectionDigest: Sha256Schema,
    }).strict(),
    materializedProductClaimDigest: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal('finding_claim_identical'),
    adjudicationKind: z.enum(['conflict', 'terminal']),
    subjectIds: BinarySortedUniqueStringSetSchema.min(2),
    findingIds: BinarySortedUniqueStringSetSchema.min(2),
    expectedHeads: z.array(FindingLifecycleEntityHeadSchema).min(2),
    claimSnapshotDigests: BinarySortedUniqueSha256SetSchema.min(2),
    rawClaimRefIds: BinarySortedUniqueStringSetSchema,
    exactClaimIdentityDigest: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal('finding_claim_supported_after_verification'),
    adjudicationKind: z.enum(['conflict', 'terminal']),
    subjectId: nonEmptyString,
    findingId: nonEmptyString,
    expectedHead: FindingLifecycleEntityHeadSchema,
    rawClaimRefIds: BinarySortedUniqueStringSetSchema.min(1),
    productProjectionDigest: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal('finding_no_issue_after_verification'),
    adjudicationKind: z.enum(['conflict', 'terminal']),
    subjectId: nonEmptyString,
    findingId: nonEmptyString,
    expectedHead: FindingLifecycleEntityHeadSchema,
    claimSnapshotDigest: Sha256Schema,
    rawClaimRefIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    kind: z.literal('finding_claim_refuted'),
    adjudicationKind: z.enum(['conflict', 'terminal']),
    subjectId: nonEmptyString,
    findingId: nonEmptyString,
    expectedHead: FindingLifecycleEntityHeadSchema,
    claimSnapshotDigest: Sha256Schema,
    rawClaimRefIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
]);

const EngineProofRecordBaseSchema = z.object({
  evidenceId: Sha256Schema,
  proofId: Sha256Schema,
  kind: z.literal('engine_proof'),
  verifierId: nonEmptyString,
  verifierVersion: nonEmptyString,
  workflowName: nonEmptyString,
  runId: nonEmptyString,
  scopeIdentity: nonEmptyString,
  snapshotId: Sha256Schema,
  targetFindingId: nonEmptyString.nullable(),
  dependencyDigests: BinarySortedUniqueSha256SetSchema,
  resultDigest: Sha256Schema,
  issuedAt: Rfc3339TimestampSchema,
});

const EngineProofRecordSchema = z.discriminatedUnion('purpose', [
  EngineProofRecordBaseSchema.extend({
    purpose: z.literal('claim_evidence'),
    claimIdentityHash: Sha256Schema,
    subject: ClaimEvidenceSubjectSchema,
  }).strict(),
  EngineProofRecordBaseSchema.extend({
    purpose: z.literal('lifecycle_authority'),
    claimIdentityHash: Sha256Schema.nullable(),
    subject: LifecycleAuthoritySubjectSchema,
  }).strict(),
]);

export const FindingEvidenceRecordSchema = z.union([
  FileQuoteEvidenceSchema.extend({
    evidenceId: Sha256Schema,
    claimIdentityHash: Sha256Schema,
    fileHash: Sha256Schema,
  }).strict(),
  EngineProofRecordSchema,
]).superRefine((record, ctx) => {
  const violation = findingEvidenceRecordIdentityViolation(record);
  if (violation !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceId'],
      message: violation,
    });
  }
});

export const ReviewerAnomalyEntrySchema = z.object({
  id: nonEmptyString,
  kind: z.enum(REVIEWER_ANOMALY_KINDS),
  stableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  sourceRawFindingIds: z.array(rawFindingIdString),
  sourceIntakeIds: z.array(rawFindingIdString),
  reviewers: z.array(nonEmptyString),
  title: nonEmptyString,
  claimedLocation: nonEmptyString.optional(),
  claimedExcerpt: nonEmptyString.optional(),
  mismatchReason: nonEmptyString,
  firstObserved: FindingObservationSchema,
  lastObserved: FindingObservationSchema,
  occurrences: z.number().int().positive(),
  promotedFindingId: nonEmptyString.optional(),
  settlement: z.object({
    kind: z.enum([
      'target_resolved_by_verified_evidence',
      'target_dismissed_by_terminal_adjudication',
    ]),
    findingId: nonEmptyString,
    lifecycleEventId: nonEmptyString,
  }).strict().optional(),
}).strict();

const FindingActionRecoverySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invalidate'),
    findingId: nonEmptyString,
    evidence: nonEmptyString,
    targetPreconditions: z.array(FindingMutationPreconditionSchema).min(1),
  }).strict(),
  z.object({
    action: z.literal('waive'),
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
    targetPreconditions: z.array(FindingMutationPreconditionSchema).min(1),
  }).strict(),
  z.object({
    action: z.literal('duplicate'),
    canonicalFindingId: nonEmptyString,
    duplicateFindingIds: z.array(nonEmptyString).min(1),
    evidence: nonEmptyString,
    targetPreconditions: z.array(FindingMutationPreconditionSchema).min(1),
  }).strict(),
]).superRefine((recovery, ctx) => {
  const targetFindingIds = recovery.action === 'duplicate'
    ? [recovery.canonicalFindingId, ...recovery.duplicateFindingIds]
    : [recovery.findingId];
  const preconditionIds = recovery.targetPreconditions.map(
    (precondition) => precondition.targetFindingId,
  );
  const uniqueTargetIds = new Set(targetFindingIds);
  const uniquePreconditionIds = new Set(preconditionIds);
  if (uniqueTargetIds.size !== targetFindingIds.length
    || uniquePreconditionIds.size !== preconditionIds.length
    || targetFindingIds.length !== preconditionIds.length
    || targetFindingIds.some((findingId) => !uniquePreconditionIds.has(findingId))) {
    ctx.addIssue({
      code: 'custom',
      message: 'actionRecovery targetPreconditions must exactly match the action target findings',
      path: ['targetPreconditions'],
    });
  }
});

/** provisional メタデータ。 */
export const FindingProvisionalMetadataSchema = z.object({
  kind: z.enum(FINDING_PROVISIONAL_KINDS),
  stableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  sourceRawFindingIds: z.array(rawFindingIdString),
  reason: nonEmptyString,
  firstObservedAt: FindingObservationSchema,
  lastObservedAt: FindingObservationSchema,
  gateEffect: z.literal('block'),
  firstObservedRound: z.number().int().positive(),
  actionRecovery: FindingActionRecoverySchema.optional(),
  actionRecoveryAttempts: z.array(z.object({
    attempt: z.number().int().positive(),
    reason: nonEmptyString,
    at: FindingObservationSchema,
  }).strict()).optional(),
  recoveryReviewerStableKey: nonEmptyString.optional(),
}).strict();

export const FindingLedgerEntrySchema = z.object({
  id: nonEmptyString,
  status: FindingStatusSchema,
  lifecycle: FindingLifecycleSchema,
  target: FindingTargetSchema.nullable(),
  targetIdentityHash: Sha256Schema.nullable(),
  claimIdentityHash: Sha256Schema.nullable(),
  semanticClaimIdentityHash: Sha256Schema.nullable(),
  severity: FindingSeveritySchema.nullable(),
  title: nonEmptyString.nullable(),
  evidenceIds: BinarySortedUniqueStringSetSchema,
  description: nonEmptyString.optional(),
  suggestion: nonEmptyString.optional(),
  reviewers: z.array(nonEmptyString),
  rawFindingIds: z.array(rawFindingIdString),
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: Rfc3339TimestampSchema.optional(),
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
  invalidatedAt: Rfc3339TimestampSchema.optional(),
  invalidatedEvidence: nonEmptyString.optional(),
  supersededByFindingId: nonEmptyString.optional(),
  dismissal: z.object({
    basis: z.enum(FINDING_DISMISSAL_BASES),
    reason: nonEmptyString,
    evidence: nonEmptyString.optional(),
    taskQuote: nonEmptyString.optional(),
    workflowTaskDigest: Sha256Schema.optional(),
    adjudicationTaskId: Sha256Schema.optional(),
    authority: z.enum(FINDING_MANAGER_AUTHORITIES),
    decidedAt: FindingObservationSchema,
  }).strict().superRefine(validateFindingDismissalAuthority).optional(),
  revision: z.number().int().positive(),
  provisional: FindingProvisionalMetadataSchema.optional(),
  rejectedObservations: z.array(z.object({
    rawFindingId: rawFindingIdString,
    reason: nonEmptyString,
    observedAt: FindingObservationSchema,
  }).strict()).optional(),
}).strict().superRefine((finding, ctx) => {
  const identityFields = [
    finding.target,
    finding.targetIdentityHash,
    finding.claimIdentityHash,
    finding.semanticClaimIdentityHash,
  ];
  const allNull = identityFields.every((value) => value === null);
  const allPresent = identityFields.every((value) => value !== null);
  if (!allNull && !allPresent) {
    ctx.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'target, targetIdentityHash, claimIdentityHash, and semanticClaimIdentityHash must be all null or all present',
    });
    return;
  }
  if (finding.provisional === undefined && !allPresent) {
    ctx.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'non-provisional findings require target and all identity hashes',
    });
    return;
  }
  if (finding.provisional === undefined && finding.severity === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['severity'],
      message: 'non-provisional findings require severity',
    });
  }
  if (finding.provisional === undefined && finding.title === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: 'non-provisional findings require title',
    });
  }
  if (finding.provisional === undefined && finding.description === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['description'],
      message: 'non-provisional findings require description',
    });
  }
  if (
    finding.target !== null
    && finding.targetIdentityHash !== computeTargetIdentityHash(finding.target)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['targetIdentityHash'],
      message: 'targetIdentityHash does not match the canonical target',
    });
  }
});

interface RawFindingRelationFields {
  relation: RawFindingRelation | null;
  targetFindingId?: string | null;
  targetPrecondition?: FindingMutationPrecondition;
}

/**
 * relation と targetFindingId の現行契約を検証する。relation=new は target を
 * 禁止し、それ以外は target を必須とする。
 */
function validateRawFindingRelation<T extends RawFindingRelationFields>(
  value: T,
  ctx: z.RefinementCtx,
  requireEnginePrecondition: boolean,
): void {
  const relation = value.relation;
  if (relation === null) {
    if (value.targetPrecondition !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'raw findings with unknown relation must not set targetPrecondition',
        path: ['targetPrecondition'],
      });
    }
    return;
  }
  if (relation === 'new' && value.targetFindingId !== undefined && value.targetFindingId !== null) {
    ctx.addIssue({ code: 'custom', message: '"new" raw findings must not set targetFindingId', path: ['targetFindingId'] });
  }
  if (relation !== 'new' && (value.targetFindingId === undefined || value.targetFindingId === null)) {
    ctx.addIssue({ code: 'custom', message: `"${relation}" raw findings require targetFindingId`, path: ['targetFindingId'] });
  }
  if (!requireEnginePrecondition) {
    return;
  }
  if (relation === 'new' && value.targetPrecondition !== undefined) {
    ctx.addIssue({ code: 'custom', message: '"new" raw findings must not set targetPrecondition', path: ['targetPrecondition'] });
  }
  if (relation !== 'new' && value.targetPrecondition === undefined) {
    ctx.addIssue({ code: 'custom', message: `"${relation}" raw findings require targetPrecondition`, path: ['targetPrecondition'] });
  }
  if (
    value.targetFindingId !== undefined
    && value.targetFindingId !== null
    && value.targetPrecondition !== undefined
    && value.targetPrecondition.targetFindingId !== value.targetFindingId
  ) {
    ctx.addIssue({ code: 'custom', message: 'targetPrecondition must describe targetFindingId', path: ['targetPrecondition', 'targetFindingId'] });
  }
}

const RawFindingFieldsSchema = z.object({
  rawFindingId: rawFindingIdString,
  stepName: nonEmptyString,
  reviewer: nonEmptyString,
  familyTag: familyTagString.nullable(),
  severity: FindingSeveritySchema.nullable(),
  title: rawFindingTitleString.nullable(),
  description: rawFindingDescriptionString.nullable(),
  suggestion: rawFindingSuggestionString.nullable(),
  target: FindingTargetSchema,
  targetIdentityHash: Sha256Schema,
  claimIdentityHash: Sha256Schema,
  semanticClaimIdentityHash: Sha256Schema,
  candidateIdentityHash: Sha256Schema,
  sourceBinding: CandidateSourceBindingSchema,
  relation: z.enum(RAW_FINDING_RELATIONS).nullable(),
  targetFindingId: nonEmptyString.nullable(),
  targetPrecondition: FindingMutationPreconditionSchema.optional(),
  evidence: RawFindingEvidenceSetSchema,
}).strict();

export const RawFindingSchema = RawFindingFieldsSchema.superRefine((value, ctx) => {
  validateRawFindingRelation(value, ctx, true);
  try {
    const targetIdentityHash = computeTargetIdentityHash(value.target);
    const claimIdentityHash = computeClaimIdentityHash({
      target: value.target,
      familyTag: value.familyTag,
      severity: value.severity,
      title: value.title,
      description: value.description,
      suggestion: value.suggestion,
    });
    const semanticClaimIdentityHash = computeSemanticClaimIdentityHash({
      target: value.target,
      title: value.title,
      description: value.description,
    });
    const candidateIdentityHash = computeCandidateIdentityHash({
      claimIdentityHash,
      sourceBinding: value.sourceBinding,
    });
    for (const [path, actual, expected] of [
      ['targetIdentityHash', value.targetIdentityHash, targetIdentityHash],
      ['claimIdentityHash', value.claimIdentityHash, claimIdentityHash],
      [
        'semanticClaimIdentityHash',
        value.semanticClaimIdentityHash,
        semanticClaimIdentityHash,
      ],
      ['candidateIdentityHash', value.candidateIdentityHash, candidateIdentityHash],
    ] as const) {
      if (actual !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} does not match its canonical content address`,
        });
      }
    }
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['target'],
      message: error instanceof Error ? error.message : 'target is not canonical',
    });
  }
});

export const FindingEvidenceRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file_quote'),
    path: nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('engine_proof'),
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('repository_manifest') }).strict(),
      z.object({ kind: z.literal('repository_query') }).strict(),
      z.object({
        kind: z.literal('authoritative_quote'),
        source: z.enum(['task', 'public_declaration']),
        declarationId: nonEmptyString,
        verbatimExcerpt: nonEmptyString,
      }).strict(),
    ]),
  }).strict(),
]);

const ReviewerCandidatePayloadSchema = z.object({
  rawFindingId: providerRawFindingIdString.nullable(),
  familyTag: familyTagString.nullable(),
  severity: FindingSeveritySchema.nullable(),
  title: rawFindingTitleString.nullable(),
  description: rawFindingDescriptionString.nullable(),
  suggestion: rawFindingSuggestionString.nullable(),
  relation: z.enum(RAW_FINDING_RELATIONS).nullable(),
  targetFindingIds: z.array(
    findingIdString,
  ).max(RAW_FINDING_NORMALIZER_LIMITS.maxTargetFindingIdsPerCandidate),
  target: FindingTargetSchema.nullable(),
  evidenceRequests: z.array(FindingEvidenceRequestSchema).max(16),
}).strict();

export const ReviewerRawFindingSchema = z.object({
  rawExcerpt: nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
  candidate: ReviewerCandidatePayloadSchema.nullable(),
}).strict();

export const FindingLedgerConflictSchema = z.object({
  id: nonEmptyString,
  status: z.enum(FINDING_CONFLICT_STATUSES),
  findingIds: z.array(nonEmptyString),
  rawFindingIds: z.array(rawFindingIdString),
  description: nonEmptyString,
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: Rfc3339TimestampSchema.optional(),
  resolvedEvidence: nonEmptyString.optional(),
  revision: z.number().int().positive(),
}).strict();

export const InterpretationDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_independent') }).strict(),
  z.object({
    kind: z.literal('open_conflict'),
    targetFindingId: nonEmptyString,
  }).strict(),
  z.object({
    kind: z.literal('provisional'),
    reason: nonEmptyString,
  }).strict(),
]);

export const InterpretationCaseDecisionOutputSchema = z.object({
  caseId: Sha256Schema,
  decision: InterpretationDecisionSchema,
}).strict();

export type ParsedInterpretationCaseDecisionOutput = z.infer<
  typeof InterpretationCaseDecisionOutputSchema
>;

const CanonicalRawFindingProvenanceSchema = z.object({
  origin: z.enum(['reviewer', 'stored-ledger', 'system']),
  ambiguityOrigin: z.boolean(),
  clarificationAttempted: z.boolean(),
  ambiguityCodes: z.array(z.enum(RAW_AMBIGUITY_CODES)),
}).strict();

export const RawCanonicalSnapshotSchema = z.object({
  rawCanonicalSnapshotId: Sha256Schema,
  rawFindingId: rawFindingIdString,
  rawPayloadDigest: Sha256Schema,
  reviewerStableKey: Sha256Schema,
  lineageKey: Sha256Schema,
  targetIdentityHash: Sha256Schema,
  claimIdentityHash: Sha256Schema,
  semanticClaimIdentityHash: Sha256Schema,
  canonicalProvenance: CanonicalRawFindingProvenanceSchema,
  canonicalizationContextDigest: Sha256Schema,
  captureAdmissionSnapshotId: Sha256Schema,
  captureDependencyDigests: BinarySortedUniqueStringSetSchema,
  canonicalIntegrityDigest: Sha256Schema,
  capturedAt: FindingObservationSchema,
}).strict();

export const InterpretationCaseSnapshotSchema = z.object({
  caseSnapshotId: Sha256Schema,
  caseId: Sha256Schema,
  cohortId: Sha256Schema,
  roundIdentity: Sha256Schema,
  lineageKey: Sha256Schema,
  policyClass: z.enum(['general', 'confirmation', 'provisional_only']),
  semanticProjectionDigest: Sha256Schema,
  memberRawFindingIds: BinarySortedUniqueRawFindingIdSetSchema,
  memberObservationDigests: z.array(Sha256Schema),
  originSnapshotSetDigest: Sha256Schema,
  createdAt: FindingObservationSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.memberRawFindingIds.length !== snapshot.memberObservationDigests.length) {
    context.addIssue({
      code: 'custom',
      path: ['memberObservationDigests'],
      message: 'case snapshot raw members and observation digests must have equal lengths',
    });
  }
});

export const InterpretationRawObservationSchema = z.object({
  observationDigest: Sha256Schema,
  rawFindingId: rawFindingIdString,
  rawCanonicalSnapshotId: Sha256Schema,
  caseId: Sha256Schema,
  cohortId: Sha256Schema,
  caseSnapshotId: Sha256Schema,
  lineageKey: Sha256Schema,
  semanticProjectionDigest: Sha256Schema,
  originSnapshotDigests: BinarySortedUniqueStringSetSchema,
  recoveryOriginBindingIds: BinarySortedUniqueStringSetSchema,
}).strict();

export const InterpretationRecoveryOriginBindingSchema = z.object({
  bindingId: Sha256Schema,
  caseSnapshotId: Sha256Schema,
  caseId: Sha256Schema,
  cohortId: Sha256Schema,
  observationRawFindingId: rawFindingIdString,
  originFindingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  originProvisionalKind: z.enum(FINDING_PROVISIONAL_KINDS),
  originStableKey: Sha256Schema,
  originLineageKey: Sha256Schema,
  recoveryReviewerStableKey: Sha256Schema,
  sourceRawFindingIdsDigest: Sha256Schema,
  originSnapshotDigest: Sha256Schema,
  boundAt: FindingObservationSchema,
}).strict();

const InterpretationRecoveryOriginSettlementBaseSchema = z.object({
  settlementId: Sha256Schema,
  bindingId: Sha256Schema,
  caseSnapshotId: Sha256Schema,
  caseId: Sha256Schema,
  observationRawFindingId: rawFindingIdString,
  originFindingId: nonEmptyString,
  originSnapshotDigest: Sha256Schema,
  recordedAt: FindingObservationSchema,
});

export const InterpretationRecoveryOriginSettlementSchema = z.discriminatedUnion('outcome', [
  InterpretationRecoveryOriginSettlementBaseSchema.extend({
    outcome: z.literal('stale'),
    reason: nonEmptyString,
  }).strict(),
  InterpretationRecoveryOriginSettlementBaseSchema.extend({
    outcome: z.literal('retained'),
    reason: z.enum([
      'case_decision_provisional',
      'case_decision_rejected_stale',
      'case_decision_rejected_raw_invalid',
      'origin_not_targeted',
    ]),
  }).strict(),
  InterpretationRecoveryOriginSettlementBaseSchema.extend({
    outcome: z.literal('settled'),
    targetFindingId: nonEmptyString,
    lifecycleEventId: Sha256Schema,
  }).strict(),
]);

const InterpretationAttemptApplicationSchema = z.discriminatedUnion('classification', [
  z.object({
    classification: z.literal('decision_applied'),
    originSettlementIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    classification: z.literal('decision_rejected_stale'),
    staleCauseDigests: BinarySortedUniqueStringSetSchema,
    originSettlementIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    classification: z.literal('decision_rejected_raw_invalid'),
    invalidRawFindingIds: BinarySortedUniqueRawFindingIdSetSchema,
    originSettlementIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
]);

const InterpretationAttemptBaseSchema = z.object({
  attemptId: Sha256Schema,
  caseSnapshotId: Sha256Schema,
  caseId: Sha256Schema,
  cohortId: Sha256Schema,
  lineageKey: Sha256Schema,
  semanticProjectionDigest: Sha256Schema,
  attemptOrdinal: z.number().int().positive(),
  retryOrdinal: z.union([z.literal(0), z.literal(1)]),
  rawFindingIds: BinarySortedUniqueRawFindingIdSetSchema,
  providerCallId: Sha256Schema,
});

export const InterpretationAttemptSchema = z.discriminatedUnion('stage', [
  InterpretationAttemptBaseSchema.extend({
    stage: z.literal('started'),
    startedAt: FindingObservationSchema,
  }).strict(),
  InterpretationAttemptBaseSchema.extend({
    stage: z.literal('interrupted'),
    startedAt: FindingObservationSchema,
    interruptedAt: FindingObservationSchema,
    reason: z.literal('provider_result_unknown'),
  }).strict(),
  InterpretationAttemptBaseSchema.extend({
    stage: z.literal('completed'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    decision: InterpretationDecisionSchema,
  }).strict(),
  InterpretationAttemptBaseSchema.extend({
    stage: z.literal('applied'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    appliedAt: FindingObservationSchema,
    decision: InterpretationDecisionSchema,
    application: InterpretationAttemptApplicationSchema,
  }).strict(),
]).superRefine((attempt, context) => {
  if (
    attempt.stage === 'interrupted'
    && compareRfc3339Timestamps(attempt.startedAt.timestamp, attempt.interruptedAt.timestamp) > 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['interruptedAt', 'timestamp'],
      message: 'interruptedAt must not precede startedAt',
    });
  }
  if (
    (attempt.stage === 'completed' || attempt.stage === 'applied')
    && compareRfc3339Timestamps(attempt.startedAt.timestamp, attempt.completedAt.timestamp) > 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt', 'timestamp'],
      message: 'completedAt must not precede startedAt',
    });
  }
  if (
    attempt.stage === 'applied'
    && compareRfc3339Timestamps(attempt.completedAt.timestamp, attempt.appliedAt.timestamp) > 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['appliedAt', 'timestamp'],
      message: 'appliedAt must not precede completedAt',
    });
  }
});

export const InterpretationAttemptFenceSchema = z.object({
  attemptId: Sha256Schema,
  caseId: Sha256Schema,
  semanticProjectionDigest: Sha256Schema,
  rawFindingIds: BinarySortedUniqueRawFindingIdSetSchema,
}).strict();

export const InterpretationBatchReceiptSchema = z.object({
  batchId: Sha256Schema,
  fences: z.array(InterpretationAttemptFenceSchema),
}).strict().superRefine((receipt, context) => {
  const attemptIds = receipt.fences.map((fence) => fence.attemptId);
  const canonicalAttemptIds = [...new Set(attemptIds)].sort(compareBinaryStrings);
  if (
    canonicalAttemptIds.length !== attemptIds.length
    || canonicalAttemptIds.some((attemptId, index) => attemptId !== attemptIds[index])
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fences'],
      message: 'interpretation receipt fences must be unique and binary-sorted by attemptId',
    });
  }
  if (receipt.batchId !== computeInterpretationBatchId(receipt.fences)) {
    context.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: 'interpretation batch id must match its canonical fences',
    });
  }
});

export const RawInterpretationOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    rawFindingId: rawFindingIdString,
    kind: z.literal('pending_attempt'),
    attemptId: Sha256Schema,
  }).strict(),
  z.object({
    rawFindingId: rawFindingIdString,
    kind: z.literal('finding'),
    findingId: nonEmptyString,
    outcome: z.enum(['created', 'matched_with_proof']),
    landingEventId: Sha256Schema,
  }).strict(),
  z.object({
    rawFindingId: rawFindingIdString,
    kind: z.literal('provisional'),
    provisionalFindingId: nonEmptyString,
    landingEventId: Sha256Schema,
  }).strict(),
  z.object({
    rawFindingId: rawFindingIdString,
    kind: z.literal('conflict'),
    conflictId: nonEmptyString,
    rawClaimLandingId: Sha256Schema,
    provisionalFindingId: nonEmptyString,
    conflictLandingEventId: Sha256Schema,
    provisionalLandingEventId: Sha256Schema,
  }).strict(),
  z.object({
    rawFindingId: rawFindingIdString,
    kind: z.literal('reviewer_anomaly'),
    anomalyId: nonEmptyString,
  }).strict(),
]);

export const ConflictRawClaimLandingSchema = z.object({
  rawClaimLandingId: Sha256Schema,
  conflictId: nonEmptyString,
  rawFindingId: rawFindingIdString,
  rawCanonicalSnapshotId: Sha256Schema,
  rawPayloadDigest: Sha256Schema,
  claimSnapshotDigest: Sha256Schema,
  holdingAllocationId: Sha256Schema,
  holdingFindingId: nonEmptyString,
  holdingHeadAfterLanding: FindingLifecycleEntityHeadSchema,
  landingEventId: Sha256Schema,
  landedAt: FindingObservationSchema,
}).strict();

export const FindingManagerProviderBudgetLimitsSchema = z.object({
  maxCallsPerRound: z.number().int().positive(),
  maxAdapterVisibleInputTokensPerCall: z.number().int().positive(),
  maxOutputTokensPerCall: z.number().int().positive(),
  maxChargedInputTokensPerRound: z.number().int().positive(),
  maxChargedOutputTokensPerRound: z.number().int().positive(),
}).strict();

export const FindingManagerProviderBudgetScopeSchema = z.object({
  budgetScopeId: Sha256Schema,
  roundIdentity: Sha256Schema,
  scopeIdentity: nonEmptyString,
  workflowName: nonEmptyString,
  roundMarker: nonEmptyString,
  limits: FindingManagerProviderBudgetLimitsSchema,
  createdAt: FindingObservationSchema,
}).strict();

const FindingManagerAttemptKindSchema = z.enum([
  'interpretation',
  'terminal_adjudication',
  'conflict_adjudication',
]);
const FindingManagerCallFailurePhaseSchema = z.enum([
  'provider_failed',
  'parse_failed',
  'provider_contract_rejected',
  'output_oversize',
  'provider_result_unknown',
]);
const FindingManagerTokenChargeSchema = z.object({
  callCount: z.literal(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  inputBasis: z.enum([
    'provider_usage',
    'exact_tokenizer',
    'request_ceiling',
    'failure_ceiling',
  ]),
  outputBasis: z.enum([
    'provider_usage',
    'exact_tokenizer',
    'utf8_byte_upper_bound',
    'response_ceiling',
    'failure_ceiling',
  ]),
}).strict();
const FindingManagerProviderCallBaseSchema = z.object({
  providerCallId: Sha256Schema,
  budgetScopeId: Sha256Schema,
  purpose: FindingManagerAttemptKindSchema,
  callOrdinal: z.number().int().positive(),
  ownerAttemptKind: FindingManagerAttemptKindSchema,
  ownerAttemptId: Sha256Schema,
  attemptIds: BinarySortedUniqueStringSetSchema,
  requestDigest: Sha256Schema,
  requestByteLength: z.number().int().nonnegative(),
  measuredAdapterVisibleInputTokens: z.number().int().nonnegative(),
  inputMeasurementBasis: z.enum(['exact_tokenizer', 'utf8_byte_upper_bound']),
  reservedInputTokens: z.number().int().positive(),
  reservedOutputTokens: z.number().int().positive(),
  reservedAt: FindingObservationSchema,
});

export const FindingManagerProviderCallSchema = z.discriminatedUnion('state', [
  FindingManagerProviderCallBaseSchema.extend({ state: z.literal('reserved') }).strict(),
  FindingManagerProviderCallBaseSchema.extend({
    state: z.literal('dispatched'),
    dispatchedAt: FindingObservationSchema,
  }).strict(),
  FindingManagerProviderCallBaseSchema.extend({
    state: z.literal('settled'),
    dispatchedAt: FindingObservationSchema,
    settledAt: FindingObservationSchema,
    resultKind: z.enum(['accepted', 'rejected', 'interrupted_unknown']),
    failurePhase: FindingManagerCallFailurePhaseSchema.optional(),
    responseDigest: Sha256Schema.optional(),
    charge: FindingManagerTokenChargeSchema,
  }).strict(),
]);

const FindingScopePredicateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('target_path_roots'),
    allowedRoots: BinarySortedUniqueStringSetSchema,
  }).strict(),
  z.object({
    kind: z.literal('target_kind_set'),
    allowedKinds: z.array(z.enum(['review_scope', 'code', 'structure', 'absence'])),
  }).strict(),
  z.object({
    kind: z.literal('family_tag_set'),
    allowedFamilyTags: BinarySortedUniqueStringSetSchema,
  }).strict(),
]);

export const FindingScopeBindingSchema = z.object({
  bindingId: Sha256Schema,
  source: z.enum(['workflow_task_scope', 'finding_contract_scope']),
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  workflowTaskDigest: Sha256Schema,
  findingContractDigest: Sha256Schema,
  predicate: FindingScopePredicateSchema,
  result: z.literal('outside'),
  verifierId: nonEmptyString,
  verifierVersion: nonEmptyString,
  dependencyDigests: BinarySortedUniqueStringSetSchema,
  issuedAt: FindingObservationSchema,
}).strict();

const ProductFindingProjectionSchema = z.object({
  target: FindingTargetSchema,
  targetIdentityHash: Sha256Schema,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  description: nonEmptyString,
  suggestion: nonEmptyString.nullable(),
  claimIdentityHash: Sha256Schema,
  semanticClaimIdentityHash: Sha256Schema,
  evidenceRecordIds: BinarySortedUniqueStringSetSchema,
}).strict();

const findingTargetJsonSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: { kind: { const: 'review_scope' } },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'paths'],
      properties: {
        kind: { const: 'code' },
        paths: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'scope', 'manifestTargets'],
      properties: {
        kind: { const: 'structure' },
        scope: {
          type: 'object', additionalProperties: false, required: ['kind', 'roots'],
          properties: {
            kind: { const: 'review_scope' },
            roots: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
          },
        },
        manifestTargets: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'predicate'],
      properties: {
        kind: { const: 'absence' },
        predicate: {
          oneOf: [
            {
              type: 'object', additionalProperties: false, required: ['kind', 'path', 'expected'],
              properties: {
                kind: { const: 'path_state' }, path: { type: 'string', minLength: 1 }, expected: { const: 'absent' },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'roots', 'literal', 'textDomain'],
              properties: {
                kind: { const: 'exact_literal_search' },
                roots: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
                literal: { type: 'string', minLength: 1 }, textDomain: { const: 'utf8' },
              },
            },
          ],
        },
      },
    },
  ],
} as const;

const productFindingProjectionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'target', 'targetIdentityHash', 'familyTag', 'severity', 'title',
    'description', 'suggestion', 'claimIdentityHash',
    'semanticClaimIdentityHash', 'evidenceRecordIds',
  ],
  properties: {
    target: findingTargetJsonSchema,
    targetIdentityHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    familyTag: { type: 'string', minLength: 1 },
    severity: { enum: FINDING_SEVERITIES },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    suggestion: { type: ['string', 'null'], minLength: 1 },
    claimIdentityHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    semanticClaimIdentityHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    evidenceRecordIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
} as const;

const OptionalAdjudicationTextSchema = z.preprocess(
  (value) => value === null ? undefined : value,
  nonEmptyString.optional(),
);

const TerminalSourceClaimRefSchema = z.object({
  sourceClaimRefId: Sha256Schema,
  rawFindingId: rawFindingIdString,
  rawCanonicalSnapshotId: Sha256Schema,
  rawPayloadDigest: Sha256Schema,
  provenanceEventId: Sha256Schema,
}).strict();
const TerminalTargetCandidateRefSchema = z.object({
  targetRefId: Sha256Schema,
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  claimSnapshotDigest: Sha256Schema,
}).strict();
export const TerminalAdjudicationCandidateSnapshotSchema = z.object({
  candidateSnapshotDigest: Sha256Schema,
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  provisionalKind: z.enum(FINDING_PROVISIONAL_KINDS),
  provisionalStableKey: Sha256Schema,
  lineageKey: Sha256Schema,
  sourceClaims: z.array(TerminalSourceClaimRefSchema),
  targetCandidates: z.array(TerminalTargetCandidateRefSchema),
}).strict();
const TerminalAdjudicationSelectionMemberSchema = z.object({
  findingId: nonEmptyString,
  episodeId: Sha256Schema,
  candidateSnapshotDigest: Sha256Schema,
}).strict();
export const TerminalAdjudicationRoundSchema = z.object({
  roundIdentity: Sha256Schema,
  selectionId: Sha256Schema,
  members: z.array(TerminalAdjudicationSelectionMemberSchema),
  selectedAt: FindingObservationSchema,
}).strict();
export const TerminalAdjudicationEpisodeSchema = z.object({
  episodeId: Sha256Schema,
  selectionId: Sha256Schema,
  roundIdentity: Sha256Schema,
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  candidateSnapshotDigest: Sha256Schema,
  maxAttempts: z.literal(2),
  createdAt: FindingObservationSchema,
}).strict();

export const TerminalAdjudicationProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('promote_independent'),
    proposedProduct: ProductFindingProjectionSchema,
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('merge_existing'),
    targetRefId: Sha256Schema,
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('dismiss'),
    basis: z.enum([
      'outside_contract_jurisdiction',
      'outside_task_scope',
      'false_positive',
      'overreach',
      'no_issue_after_verification',
    ]),
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('undetermined'),
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
]);

export const TerminalAdjudicationProposalJsonSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'proposedProduct', 'authorityRefIds', 'rationale'],
      properties: {
        kind: { const: 'promote_independent' },
        proposedProduct: productFindingProjectionJsonSchema,
        authorityRefIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        rationale: { type: ['string', 'null'], minLength: 1 },
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'targetRefId', 'authorityRefIds', 'rationale'],
      properties: {
        kind: { const: 'merge_existing' }, targetRefId: { type: 'string', minLength: 1 },
        authorityRefIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        rationale: { type: ['string', 'null'], minLength: 1 },
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'basis', 'authorityRefIds', 'rationale'],
      properties: {
        kind: { const: 'dismiss' },
        basis: { enum: ['outside_contract_jurisdiction', 'outside_task_scope', 'false_positive', 'overreach', 'no_issue_after_verification'] },
        authorityRefIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        rationale: { type: ['string', 'null'], minLength: 1 },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'rationale'],
      properties: { kind: { const: 'undetermined' }, rationale: { type: ['string', 'null'], minLength: 1 } },
    },
  ],
} as const;

export function parseTerminalAdjudicationProposal(value: unknown): TerminalAdjudicationProposal {
  return TerminalAdjudicationProposalSchema.parse(value);
}
const AppliedTerminalAdjudicationProposalSchema = z.discriminatedUnion('kind', [
  TerminalAdjudicationProposalSchema.options[0],
  TerminalAdjudicationProposalSchema.options[1],
  TerminalAdjudicationProposalSchema.options[2],
]);
const TerminalAttemptBaseSchema = z.object({
  attemptId: Sha256Schema,
  episodeId: Sha256Schema,
  selectionId: Sha256Schema,
  roundIdentity: Sha256Schema,
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  candidateSnapshotDigest: Sha256Schema,
  attemptOrdinal: z.union([z.literal(1), z.literal(2)]),
  retryOrdinal: z.union([z.literal(0), z.literal(1)]),
  providerCallId: Sha256Schema,
  requestDigest: Sha256Schema,
  sourceClaimRefIds: BinarySortedUniqueStringSetSchema,
});
const TerminalDiagnosticResultSchema = z.object({
  kind: z.literal('diagnostic_undetermined'),
  code: z.enum([
    'provider_contract_rejected',
    'parse_failed',
    'provider_failed',
    'output_oversize',
  ]),
  responseDigest: Sha256Schema.nullable(),
  diagnosticDigest: Sha256Schema,
}).strict();
const TerminalVerificationResultSchema = z.object({
  kind: z.literal('verification_undetermined'),
  proposal: TerminalAdjudicationProposalSchema,
  proposalDigest: Sha256Schema,
  reasonCodes: BinarySortedUniqueStringSetSchema,
}).strict();
const TerminalStaleResultSchema = z.object({
  kind: z.literal('stale_precondition'),
  proposal: TerminalAdjudicationProposalSchema.nullable(),
  proposalDigest: Sha256Schema.nullable(),
  actualHead: FindingLifecycleEntityHeadSchema.nullable(),
}).strict().superRefine((result, ctx) => {
  if ((result.proposal === null) !== (result.proposalDigest === null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Stale terminal proposal and digest must both be present or both be absent',
    });
  }
});
export const TerminalAdjudicationAttemptSchema = z.discriminatedUnion('stage', [
  TerminalAttemptBaseSchema.extend({
    stage: z.literal('started'),
    startedAt: FindingObservationSchema,
  }).strict(),
  TerminalAttemptBaseSchema.extend({
    stage: z.literal('interrupted'),
    startedAt: FindingObservationSchema,
    interruptedAt: FindingObservationSchema,
    reason: z.literal('provider_result_unknown'),
  }).strict(),
  TerminalAttemptBaseSchema.extend({
    stage: z.literal('proposed'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    proposal: TerminalAdjudicationProposalSchema,
    proposalDigest: Sha256Schema,
  }).strict(),
  TerminalAttemptBaseSchema.extend({
    stage: z.literal('completed'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    result: z.union([
      TerminalDiagnosticResultSchema,
      TerminalVerificationResultSchema,
      TerminalStaleResultSchema,
    ]),
  }).strict(),
  TerminalAttemptBaseSchema.extend({
    stage: z.literal('applied'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    appliedAt: FindingObservationSchema,
    proposal: AppliedTerminalAdjudicationProposalSchema,
    proposalDigest: Sha256Schema,
    verificationDigest: Sha256Schema,
    settlementId: Sha256Schema,
    lifecycleEventIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
]);
const TerminalSettlementBaseSchema = z.object({
  settlementId: Sha256Schema,
  episodeId: Sha256Schema,
  attemptId: Sha256Schema,
  provisionalFindingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  sourceClaimRefIds: BinarySortedUniqueStringSetSchema,
  lifecycleEventIds: BinarySortedUniqueStringSetSchema,
  verificationDigest: Sha256Schema,
  recordedAt: FindingObservationSchema,
});
export const TerminalAdjudicationSettlementSchema = z.discriminatedUnion('outcome', [
  TerminalSettlementBaseSchema.extend({
    outcome: z.literal('promoted'),
    targetFindingId: nonEmptyString,
  }).strict(),
  TerminalSettlementBaseSchema.extend({
    outcome: z.literal('merged'),
    targetFindingId: nonEmptyString,
  }).strict(),
  TerminalSettlementBaseSchema.extend({ outcome: z.literal('dismissed') }).strict(),
  z.object({
    settlementId: Sha256Schema,
    episodeId: Sha256Schema,
    attemptId: Sha256Schema,
    provisionalFindingId: nonEmptyString,
    expectedHead: FindingLifecycleEntityHeadSchema,
    candidateSnapshotDigest: Sha256Schema,
    outcome: z.literal('exhausted'),
    reason: z.literal('stale_precondition'),
    supersedingEpisodeId: Sha256Schema.nullable(),
    supersedingCandidateSnapshotDigest: Sha256Schema.nullable(),
    recordedAt: FindingObservationSchema,
  }).strict(),
  z.object({
    settlementId: Sha256Schema,
    episodeId: Sha256Schema,
    provisionalFindingId: nonEmptyString,
    expectedHead: FindingLifecycleEntityHeadSchema,
    candidateSnapshotDigest: Sha256Schema,
    outcome: z.literal('superseded'),
    reason: z.enum(['candidate_snapshot_changed', 'subject_no_longer_candidate']),
    supersedingEpisodeId: Sha256Schema.nullable(),
    supersedingCandidateSnapshotDigest: Sha256Schema.nullable(),
    recordedAt: FindingObservationSchema,
  }).strict(),
]);

const ConflictProductSubjectSchema = z.object({
  subjectId: Sha256Schema,
  conflictId: nonEmptyString,
  role: z.literal('product_finding'),
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  targetIdentityHash: Sha256Schema.nullable(),
  claimIdentityHash: Sha256Schema.nullable(),
  semanticClaimIdentityHash: Sha256Schema.nullable(),
  claimSnapshotDigest: Sha256Schema,
  sourceRawFindingIds: BinarySortedUniqueRawFindingIdSetSchema,
  sourceRawPayloadDigests: BinarySortedUniqueStringSetSchema,
  rawClaimLandingIds: z.tuple([]),
  evidenceBindingIds: BinarySortedUniqueStringSetSchema,
  evidenceSetDigest: Sha256Schema,
}).strict();
const ConflictHoldingSubjectSchema = ConflictProductSubjectSchema.omit({
  role: true,
  rawClaimLandingIds: true,
}).extend({
  role: z.literal('holding_provisional'),
  rawClaimLandingIds: BinarySortedUniqueStringSetSchema.min(1),
}).strict();
const ConflictClaimSubjectSchema = z.discriminatedUnion('role', [
  ConflictProductSubjectSchema,
  ConflictHoldingSubjectSchema,
]);
export const ConflictAdjudicationSnapshotSchema = z.object({
  conflictSnapshotId: Sha256Schema,
  conflictId: nonEmptyString,
  expectedConflictHead: FindingLifecycleEntityHeadSchema,
  claimUniverseDigest: Sha256Schema,
  coverageSnapshotDigest: Sha256Schema,
  evidenceSnapshotDigest: Sha256Schema,
  rawClaimLandingIds: BinarySortedUniqueStringSetSchema,
  priorSettlementIds: BinarySortedUniqueStringSetSchema,
  subjects: z.array(ConflictClaimSubjectSchema),
  originStep: nonEmptyString.nullable(),
  createdAt: FindingObservationSchema,
}).strict();
export const ConflictAdjudicationEpisodeSchema = z.object({
  episodeId: Sha256Schema,
  conflictSnapshotId: Sha256Schema,
  conflictId: nonEmptyString,
  expectedConflictHead: FindingLifecycleEntityHeadSchema,
  maxAttempts: z.literal(2),
  createdAt: FindingObservationSchema,
}).strict();
const ConflictAdjudicationProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge_holding'),
    holdingSubjectId: Sha256Schema,
    targetProductSubjectId: Sha256Schema,
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    actionableFix: nonEmptyString.optional(),
    rationale: nonEmptyString.optional(),
  }).strict(),
  z.object({
    kind: z.literal('promote_holding'),
    holdingSubjectId: Sha256Schema,
    proposedProduct: ProductFindingProjectionSchema,
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    actionableFix: nonEmptyString.optional(),
    rationale: nonEmptyString.optional(),
  }).strict(),
  z.object({
    kind: z.literal('terminate_subject'),
    subjectId: Sha256Schema,
    basis: z.enum(['finding_no_issue_after_verification', 'finding_claim_refuted']),
    authorityRefIds: BinarySortedUniqueStringSetSchema,
    rationale: nonEmptyString.optional(),
  }).strict(),
  z.object({
    kind: z.literal('undetermined'),
    subjectIds: BinarySortedUniqueStringSetSchema,
    rationale: nonEmptyString.optional(),
  }).strict(),
]);
const AppliedConflictAdjudicationProposalSchema = z.discriminatedUnion('kind', [
  ConflictAdjudicationProposalSchema.options[0],
  ConflictAdjudicationProposalSchema.options[1],
  ConflictAdjudicationProposalSchema.options[2],
]);
const ConflictAttemptBaseSchema = z.object({
  attemptId: Sha256Schema,
  episodeId: Sha256Schema,
  conflictSnapshotId: Sha256Schema,
  conflictId: nonEmptyString,
  expectedConflictHead: FindingLifecycleEntityHeadSchema,
  attemptOrdinal: z.union([z.literal(1), z.literal(2)]),
  retryOrdinal: z.union([z.literal(0), z.literal(1)]),
  providerCallId: Sha256Schema,
  requestDigest: Sha256Schema,
  subjectIds: BinarySortedUniqueStringSetSchema,
  originStep: nonEmptyString.nullable(),
});
const ConflictVerificationResultSchema = z.object({
  kind: z.literal('verification_undetermined'),
  proposal: ConflictAdjudicationProposalSchema,
  proposalDigest: Sha256Schema,
  reasonCodes: BinarySortedUniqueStringSetSchema,
}).strict();
const ConflictStaleResultSchema = z.object({
  kind: z.literal('stale_precondition'),
  proposal: ConflictAdjudicationProposalSchema,
  proposalDigest: Sha256Schema,
}).strict();
export const ConflictAdjudicationAttemptSchema = z.discriminatedUnion('stage', [
  ConflictAttemptBaseSchema.extend({
    stage: z.literal('started'),
    startedAt: FindingObservationSchema,
  }).strict(),
  ConflictAttemptBaseSchema.extend({
    stage: z.literal('interrupted'),
    startedAt: FindingObservationSchema,
    interruptedAt: FindingObservationSchema,
    reason: z.literal('provider_result_unknown'),
  }).strict(),
  ConflictAttemptBaseSchema.extend({
    stage: z.literal('proposed'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    proposal: ConflictAdjudicationProposalSchema,
    proposalDigest: Sha256Schema,
  }).strict(),
  ConflictAttemptBaseSchema.extend({
    stage: z.literal('completed'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    result: z.union([
      TerminalDiagnosticResultSchema,
      ConflictVerificationResultSchema,
      ConflictStaleResultSchema,
    ]),
  }).strict(),
  ConflictAttemptBaseSchema.extend({
    stage: z.literal('applied'),
    startedAt: FindingObservationSchema,
    completedAt: FindingObservationSchema,
    appliedAt: FindingObservationSchema,
    proposal: AppliedConflictAdjudicationProposalSchema,
    proposalDigest: Sha256Schema,
    verificationDigest: Sha256Schema,
    claimSettlementIds: BinarySortedUniqueStringSetSchema,
    lifecycleEventIds: BinarySortedUniqueStringSetSchema,
  }).strict(),
]);
const ConflictClaimSettlementBaseSchema = z.object({
  settlementId: Sha256Schema,
  conflictId: nonEmptyString,
  conflictSnapshotId: Sha256Schema,
  subjectId: Sha256Schema,
  subjectRole: z.enum(['product_finding', 'holding_provisional']),
  findingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  attemptId: Sha256Schema,
  rawClaimLandingIds: BinarySortedUniqueStringSetSchema,
  lifecycleEventIds: BinarySortedUniqueStringSetSchema,
  verificationDigest: Sha256Schema,
  recordedAt: FindingObservationSchema,
});
export const ConflictClaimSettlementSchema = z.discriminatedUnion('outcome', [
  ConflictClaimSettlementBaseSchema.extend({
    outcome: z.literal('merged'),
    targetFindingId: nonEmptyString,
  }).strict(),
  ConflictClaimSettlementBaseSchema.extend({
    outcome: z.literal('promoted'),
    targetFindingId: nonEmptyString,
  }).strict(),
  ConflictClaimSettlementBaseSchema.extend({ outcome: z.literal('resolved') }).strict(),
  ConflictClaimSettlementBaseSchema.extend({ outcome: z.literal('invalidated') }).strict(),
]);

/** ラウンド跨ぎの fixpoint 比較スナップショット。 */
export const FindingLedgerFixpointSnapshotSchema = z.object({
  provisionalKeys: z.array(nonEmptyString),
  substantiveEntries: z.array(nonEmptyString),
  unadjudicatedConflictEntries: z.array(nonEmptyString),
}).strict();

export const FindingLedgerFixpointStateSchema = z.object({
  snapshot: FindingLedgerFixpointSnapshotSchema,
  reached: z.boolean(),
}).strict();

/** 有限停止予算のラウンド跨ぎ累積状態。roundsCompleted は roundMarkers.length から導出する（冪等な適用済み集合）。 */
export const FindingLedgerStopBudgetStateSchema = z.object({
  roundMarkers: BinarySortedUniqueStringSetSchema,
  firstRoundAt: Rfc3339TimestampSchema,
  exhausted: z.boolean(),
}).strict();

/** review-integrity 予算（review-integrity requirement）のラウンド跨ぎ累積状態。stopBudget と同形。 */
export const FindingLedgerReviewIntegrityStateSchema = z.object({
  roundMarkers: BinarySortedUniqueStringSetSchema,
  firstRoundAt: Rfc3339TimestampSchema,
  exhausted: z.boolean(),
}).strict();

const FindingManagerValidationAttemptReportSchema = z.object({
  attempt: z.number().int().positive(),
  managerOutput: z.unknown(),
  validationErrors: z.array(z.string()),
}).strict();

const RawAdmissionRejectionReportSchema = z.object({
  rawFindingId: rawFindingIdString,
  location: z.string(),
  reason: nonEmptyString,
}).strict();

const UnsupportedRawFindingReportSchema = z.object({
  rawFindingId: rawFindingIdString,
  targetFindingId: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

const ReviewerOutputOverflowReportSchema = z.object({
  reviewer: nonEmptyString,
  reason: nonEmptyString,
}).strict();

const RawNormalizationAuditRecordSchema = z.object({
  rawFindingId: rawFindingIdString,
  reviewer: nonEmptyString,
  claimedRelation: z.string().optional(),
  claimedTargetFindingId: z.string().optional(),
  normalizedRelation: z.enum(RAW_FINDING_RELATIONS).nullable(),
  wireTargetFindingId: z.string().optional(),
  ambiguityCodes: z.array(nonEmptyString),
  normalizations: z.array(z.enum([
    'relation-normalized',
    'target-dropped-from-wire',
    'required-fields-missing',
  ])),
}).strict();

const LandingReportSchema = z.object({
  kind: nonEmptyString,
  stableKey: nonEmptyString,
  reason: nonEmptyString,
  sourceRawFindingIds: z.array(rawFindingIdString),
}).strict();

const ReviewerAnomalyLandingReportSchema = z.object({
  kind: nonEmptyString,
  stableKey: nonEmptyString,
  reason: nonEmptyString,
  sourceRawFindingIds: z.array(rawFindingIdString),
  sourceIntakeIds: z.array(rawFindingIdString),
}).strict();

const InterpretationStatsReportSchema = z.object({
  ambiguousRawCount: z.number().int().nonnegative(),
  managerCalls: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
  reusedCompletedDecisions: z.number().int().nonnegative(),
  interruptedInterpretations: z.number().int().nonnegative(),
  budgetExhaustedLineages: z.number().int().nonnegative(),
}).strict();

const FindingManagerValidationReportSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  stepName: nonEmptyString,
  retryCount: z.number().int().nonnegative(),
  ledgerUpdated: z.boolean(),
  finalErrors: z.array(z.string()),
  attempts: z.array(FindingManagerValidationAttemptReportSchema),
  rawAdmissionRejections: z.array(RawAdmissionRejectionReportSchema).optional(),
  unsupportedRawFindings: z.array(UnsupportedRawFindingReportSchema).optional(),
  reviewerOutputOverflows: z.array(ReviewerOutputOverflowReportSchema).optional(),
  provisionalLandings: z.array(LandingReportSchema).optional(),
  reviewerAnomalyLandings: z.array(ReviewerAnomalyLandingReportSchema).optional(),
  rawNormalizations: z.array(RawNormalizationAuditRecordSchema).optional(),
  interpretationStats: InterpretationStatsReportSchema.optional(),
  relationClarifications: z.array(z.object({
    reviewer: nonEmptyString,
    flaggedRawFindingIds: z.array(providerRawFindingIdString),
  }).strict()).optional(),
  interpretationRecoverySettlements: z.array(
    InterpretationRecoveryOriginSettlementSchema,
  ).optional(),
  managerTaskAudits: z.array(z.discriminatedUnion('status', [
    z.object({
      taskId: Sha256Schema,
      taskKind: z.enum([
        'raw',
        'entity_binding',
        'finding_control',
        'dispute',
        'conflict',
        'invalidate',
        'duplicate',
        'dismiss',
      ]),
      ownedIds: z.array(rawFindingIdString),
      status: z.literal('succeeded'),
      inputBytes: z.number().int().nonnegative(),
      output: z.unknown(),
    }).strict(),
    z.object({
      taskId: Sha256Schema,
      taskKind: z.enum([
        'raw',
        'entity_binding',
        'finding_control',
        'dispute',
        'conflict',
        'invalidate',
        'duplicate',
        'dismiss',
      ]),
      ownedIds: z.array(rawFindingIdString),
      status: z.enum(['failed', 'input_overflow']),
      inputBytes: z.number().int().nonnegative().nullable(),
      reason: nonEmptyString,
    }).strict(),
  ])).optional(),
}).strict();

const FindingManagerCommitProjectionSchema = z.object({
  nextId: z.number().int().positive(),
  updatedAt: Rfc3339TimestampSchema,
  findings: z.array(FindingLedgerEntrySchema),
  evidenceRecords: z.array(FindingEvidenceRecordSchema),
  evidenceBindings: z.array(FindingEvidenceBindingSchema),
  lifecycleReservations: z.array(FindingLifecycleReservationSchema),
  lifecycleEvents: z.array(FindingLifecycleEventSchema),
  rawFindings: z.array(RawFindingSchema),
  rawCanonicalSnapshots: z.array(RawCanonicalSnapshotSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
  conflictRawClaimLandings: z.array(ConflictRawClaimLandingSchema),
  conflictAdjudicationSnapshots: z.array(ConflictAdjudicationSnapshotSchema),
  conflictAdjudicationEpisodes: z.array(ConflictAdjudicationEpisodeSchema),
  conflictAdjudicationAttempts: z.array(ConflictAdjudicationAttemptSchema),
  conflictClaimSettlements: z.array(ConflictClaimSettlementSchema),
  interpretationCaseSnapshots: z.array(InterpretationCaseSnapshotSchema),
  interpretationRawObservations: z.array(InterpretationRawObservationSchema),
  interpretationRecoveryOriginBindings: z.array(InterpretationRecoveryOriginBindingSchema),
  interpretationRecoveryOriginSettlements: z.array(InterpretationRecoveryOriginSettlementSchema),
  interpretationAttempts: z.array(InterpretationAttemptSchema),
  rawInterpretationOutcomes: z.array(RawInterpretationOutcomeSchema),
  findingManagerProviderBudgetScopes: z.array(FindingManagerProviderBudgetScopeSchema),
  findingManagerProviderCalls: z.array(FindingManagerProviderCallSchema),
  findingScopeBindings: z.array(FindingScopeBindingSchema),
  terminalAdjudicationRounds: z.array(TerminalAdjudicationRoundSchema),
  terminalAdjudicationEpisodes: z.array(TerminalAdjudicationEpisodeSchema),
  terminalAdjudicationAttempts: z.array(TerminalAdjudicationAttemptSchema),
  terminalAdjudicationSettlements: z.array(TerminalAdjudicationSettlementSchema),
  fixpoint: FindingLedgerFixpointStateSchema.optional(),
  stopBudget: FindingLedgerStopBudgetStateSchema.optional(),
  reviewerAnomalies: z.array(ReviewerAnomalyEntrySchema).optional(),
  reviewIntegrity: FindingLedgerReviewIntegrityStateSchema.optional(),
}).strict();

const FindingManagerReportPublicationSchema = z.object({
  publicationId: Sha256Schema,
  domainId: Sha256Schema,
  originRunId: nonEmptyString,
  destinationRunId: nonEmptyString,
  fileName: nonEmptyString,
  contentSha256: Sha256Schema,
  report: FindingManagerValidationReportSchema,
}).strict();

const FindingManagerPendingCommitSchema = z.object({
  roundMarker: nonEmptyString,
  publication: FindingManagerReportPublicationSchema,
  completed: FindingManagerCommitProjectionSchema,
}).strict();

export const FindingLedgerSchema = z.object({
  workflowName: nonEmptyString,
  nextId: z.number().int().positive(),
  updatedAt: Rfc3339TimestampSchema,
  findings: z.array(FindingLedgerEntrySchema),
  evidenceRecords: z.array(FindingEvidenceRecordSchema),
  evidenceBindings: z.array(FindingEvidenceBindingSchema),
  lifecycleReservations: z.array(FindingLifecycleReservationSchema),
  lifecycleEvents: z.array(FindingLifecycleEventSchema),
  rawFindings: z.array(RawFindingSchema),
  rawCanonicalSnapshots: z.array(RawCanonicalSnapshotSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
  conflictRawClaimLandings: z.array(ConflictRawClaimLandingSchema),
  conflictAdjudicationSnapshots: z.array(ConflictAdjudicationSnapshotSchema),
  conflictAdjudicationEpisodes: z.array(ConflictAdjudicationEpisodeSchema),
  conflictAdjudicationAttempts: z.array(ConflictAdjudicationAttemptSchema),
  conflictClaimSettlements: z.array(ConflictClaimSettlementSchema),
  interpretationCaseSnapshots: z.array(InterpretationCaseSnapshotSchema),
  interpretationRawObservations: z.array(InterpretationRawObservationSchema),
  interpretationRecoveryOriginBindings: z.array(InterpretationRecoveryOriginBindingSchema),
  interpretationRecoveryOriginSettlements: z.array(InterpretationRecoveryOriginSettlementSchema),
  interpretationAttempts: z.array(InterpretationAttemptSchema),
  rawInterpretationOutcomes: z.array(RawInterpretationOutcomeSchema),
  findingManagerProviderBudgetScopes: z.array(FindingManagerProviderBudgetScopeSchema),
  findingManagerProviderCalls: z.array(FindingManagerProviderCallSchema),
  findingScopeBindings: z.array(FindingScopeBindingSchema),
  terminalAdjudicationRounds: z.array(TerminalAdjudicationRoundSchema),
  terminalAdjudicationEpisodes: z.array(TerminalAdjudicationEpisodeSchema),
  terminalAdjudicationAttempts: z.array(TerminalAdjudicationAttemptSchema),
  terminalAdjudicationSettlements: z.array(TerminalAdjudicationSettlementSchema),
  fixpoint: FindingLedgerFixpointStateSchema.optional(),
  stopBudget: FindingLedgerStopBudgetStateSchema.optional(),
  // 二系統台帳（review-integrity protocol）の review-integrity 側。
  reviewerAnomalies: z.array(ReviewerAnomalyEntrySchema).optional(),
  // review-integrity 予算（review-integrity requirement）。optional。
  reviewIntegrity: FindingLedgerReviewIntegrityStateSchema.optional(),
  pendingManagerCommit: FindingManagerPendingCommitSchema.optional(),
}).strict().superRefine((ledger, ctx) => {
  const addProjectionIssues = (
    projection: z.infer<typeof FindingManagerCommitProjectionSchema>,
    pathPrefix: Array<string | number>,
  ): void => {
    for (const violation of collectFindingLedgerProjectionInvariantViolations(projection)) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, ...violation.path],
        message: violation.message,
      });
    }
  };
  addProjectionIssues(ledger, []);
  if (ledger.pendingManagerCommit !== undefined) {
    const pending = ledger.pendingManagerCommit;
    if (ledger.stopBudget?.roundMarkers.includes(pending.roundMarker) === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['pendingManagerCommit', 'roundMarker'],
        message: 'Pending manager round marker must not also be completed',
      });
    }
    if (pending.completed.stopBudget?.roundMarkers.includes(pending.roundMarker) !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['pendingManagerCommit', 'completed', 'stopBudget', 'roundMarkers'],
        message: 'Pending manager completed stop budget must include its round marker',
      });
    }
    addProjectionIssues(pending.completed, ['pendingManagerCommit', 'completed']);
  }
});

const InterpretationCaseDecisionsOutputIntakeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['caseId', 'decision'],
        properties: {
          caseId: { type: 'string', minLength: 64, maxLength: 64 },
          decision: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { const: 'create_independent' } },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'targetFindingId'],
                properties: {
                  kind: { const: 'open_conflict' },
                  targetFindingId: { type: 'string', minLength: 1, maxLength: 128 },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'reason'],
                properties: {
                  kind: { const: 'provisional' },
                  reason: { type: 'string', minLength: 1, maxLength: 2048 },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;

export function parseInterpretationCaseDecisions(
  value: unknown,
): ParsedInterpretationCaseDecisionOutput[] {
  return z.object({
    decisions: z.array(InterpretationCaseDecisionOutputSchema),
  }).strict().parse(value).decisions;
}

export const FindingManagerOutputSchema = z.object({
  anchorAdjudications: z.array(z.object({
    rawFindingId: rawFindingIdString,
    rawDecision: z.enum(RAW_DECISION_KINDS),
    findingId: nonEmptyString.nullable(),
    decision: z.enum(['relevant', 'not_relevant', 'not_applicable']),
    rationale: z.string(),
    managerOutputBinding: Sha256Schema,
  }).strict()),
  matches: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(rawFindingIdString),
    evidence: nonEmptyString.nullable().optional().transform((value) => value ?? undefined),
  }).strict()),
  newFindings: z.array(z.object({
    rawFindingIds: z.array(rawFindingIdString),
    title: nonEmptyString,
    severity: FindingSeveritySchema,
  }).strict()),
  resolvedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(rawFindingIdString),
    evidence: nonEmptyString,
  }).strict()),
  reopenedFindings: z.array(z.object({
    findingId: nonEmptyString,
    rawFindingIds: z.array(rawFindingIdString),
    evidence: nonEmptyString,
  }).strict()),
  conflicts: z.array(z.object({
    findingIds: z.array(nonEmptyString),
    rawFindingIds: z.array(rawFindingIdString),
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
  }).strict()),
  disputeNotes: z.array(z.object({
    findingId: nonEmptyString,
    reason: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()),
  invalidatedFindings: z.array(z.object({
    findingId: nonEmptyString,
    evidence: nonEmptyString,
  }).strict()),
  duplicateFindings: z.array(z.object({
    canonicalFindingId: nonEmptyString,
    // 決定スキーマ側（FindingManagerDuplicateDecisionSchema）と対称に空配列を
    // 拒否する。duplicate を1件も持たないエントリは「何も統合しない統合」で、
    // canonical だけが transitionedFindingIds に載る等の副作用だけが残る。
    duplicateFindingIds: z.array(nonEmptyString).min(1),
    evidence: nonEmptyString,
  }).strict()),
  dismissedFindings: z.array(z.object({
    findingId: nonEmptyString,
    basis: z.enum(FINDING_DISMISSAL_BASES),
    reason: nonEmptyString,
    evidence: nonEmptyString.optional(),
    taskQuote: nonEmptyString.optional(),
    workflowTaskDigest: Sha256Schema.optional(),
    adjudicationTaskId: Sha256Schema.optional(),
    authority: z.enum(FINDING_MANAGER_AUTHORITIES),
  }).strict().superRefine(validateFindingDismissalAuthority)),
}).strict();

// LLM に返させるのは判断だけ。アクション配列への組み立てと不変条件の強制は
// decision-assembly.ts（コード側）が行う。findingId は same/resolved/reopened/
// conflict でのみ必須なため、strict 様式の制約上は required に含めつつ、
// 該当なし（new/unsupported）は空文字で埋めさせて未指定として扱う。
export const FindingManagerRawDecisionSchema = z.object({
  rawFindingId: rawFindingIdString,
  decision: z.enum(RAW_DECISION_KINDS),
  anchorRelevance: z.enum(['relevant', 'not_relevant']).optional(),
  findingId: z.string().optional(),
  evidence: nonEmptyString,
}).strict().transform(({ findingId, ...decision }) => (
  findingId ? { ...decision, findingId } : decision
));

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

/** Candidate eligibility（open な provisional かつ DISMISSABLE_PROVISIONAL_KINDS）は decision-assembly.ts が強制する。 */
export const FindingManagerDismissDecisionSchema = z.object({
  findingId: nonEmptyString,
  basis: z.enum(FINDING_DISMISSAL_BASES),
  reason: nonEmptyString,
  evidence: nonEmptyString.optional(),
  taskQuote: nonEmptyString.optional(),
  workflowTaskDigest: Sha256Schema.optional(),
  adjudicationTaskId: Sha256Schema.optional(),
}).strict().superRefine((decision, ctx) => {
  if (decision.basis === 'outside_task_scope') {
    if (
      decision.taskQuote === undefined
      || decision.workflowTaskDigest === undefined
      || decision.adjudicationTaskId === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskQuote'],
        message: 'outside_task_scope decision requires verified task binding',
      });
    }
    if (decision.evidence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'outside_task_scope decision uses taskQuote instead of evidence',
      });
    }
  } else if (decision.evidence === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: `dismissal basis "${decision.basis}" requires evidence`,
    });
  }
});

export const FindingManagerDuplicateDecisionSchema = z.object({
  canonicalFindingId: nonEmptyString,
  duplicateFindingIds: z.array(nonEmptyString).min(1),
  evidence: nonEmptyString,
}).strict();

export const FindingManagerDecisionsSchema = z.object({
  rawDecisions: z.array(FindingManagerRawDecisionSchema),
  disputeDecisions: z.array(FindingManagerDisputeDecisionSchema),
  conflictDecisions: z.array(FindingManagerConflictDecisionSchema),
  invalidateDecisions: z.array(FindingManagerInvalidateDecisionSchema),
  duplicateDecisions: z.array(FindingManagerDuplicateDecisionSchema),
  dismissDecisions: z.array(FindingManagerDismissDecisionSchema),
}).strict();

export const FindingManagerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['anchorAdjudications', 'matches', 'newFindings', 'resolvedFindings', 'reopenedFindings', 'conflicts', 'resolvedConflicts', 'waivedFindings', 'disputeNotes', 'invalidatedFindings', 'duplicateFindings', 'dismissedFindings'],
  properties: {
    anchorAdjudications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'rawDecision', 'findingId', 'decision', 'rationale', 'managerOutputBinding'],
        properties: {
          rawFindingId: {
            type: 'string',
            minLength: 1,
            maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
          },
          rawDecision: { enum: RAW_DECISION_KINDS },
          findingId: { type: ['string', 'null'], minLength: 1 },
          decision: { enum: ['relevant', 'not_relevant', 'not_applicable'] },
          rationale: { type: 'string' },
          managerOutputBinding: { type: 'string', pattern: SHA256_HEX_PATTERN.source },
        },
      },
    },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'rawFindingIds', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          rawFindingIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
            },
          },
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
          rawFindingIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
            },
          },
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
          rawFindingIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
            },
          },
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
          rawFindingIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
            },
          },
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
          rawFindingIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
            },
          },
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
          duplicateFindingIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    dismissedFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'basis', 'reason', 'authority'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          basis: { enum: FINDING_DISMISSAL_BASES },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
          taskQuote: { type: 'string', minLength: 1 },
          workflowTaskDigest: { type: 'string', pattern: SHA256_HEX_PATTERN.source },
          adjudicationTaskId: { type: 'string', pattern: SHA256_HEX_PATTERN.source },
          authority: { enum: ['standard', 'terminal_adjudication'] },
        },
      },
    },
  },
} as const;

/**
 * findings-manager が実際に返す structured output。
 * raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを問う。
 * 組み立てと不変条件の強制は decision-assembly.ts が行うため、弱いモデルでも
 * 出力すべき形が単純になる。
 */
const managerRawDecisionJsonProperties = {
  rawFindingId: {
    type: 'string',
    minLength: 1,
    maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    description: 'Engine-namespaced raw finding id from the manager prompt.',
  },
  decision: {
    type: 'string',
    enum: RAW_DECISION_KINDS,
    description: 'same = matches an existing open finding (familyTag and line-number differences alone are not disqualifying; judge by failure mode, trigger, impact, and required fix). new = no related finding exists yet. resolved = confirms an existing open finding is fixed. reopened = a previously resolved/waived/dismissed finding reappeared. conflict = contradicts an existing finding. unsupported = the raw finding explicitly referenced an existing finding (targetFindingId) as persists/reopened but the reference does not hold up; do not fall back to new.',
  },
  findingId: {
    type: 'string',
    description: 'Ledger finding id. Required for same/resolved/reopened/conflict. Empty string for new/unsupported.',
  },
  evidence: { type: 'string', minLength: 1 },
} as const;

export const FindingManagerDecisionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions', 'invalidateDecisions', 'duplicateDecisions', 'dismissDecisions'],
  properties: {
    rawDecisions: {
      type: 'array',
      description: 'Exactly one decision per residual raw finding listed in the prompt.',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(managerRawDecisionJsonProperties),
            properties: managerRawDecisionJsonProperties,
          },
          {
            type: 'object',
            additionalProperties: false,
            required: [
              ...Object.keys(managerRawDecisionJsonProperties),
              'anchorRelevance',
            ],
            properties: {
              ...managerRawDecisionJsonProperties,
              anchorRelevance: {
                type: 'string',
                enum: ['relevant', 'not_relevant'],
                description: 'Required only for an absence target. Decide whether its verified task/public authoritative quote establishes the claimed missing obligation.',
              },
            },
          },
        ],
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
          duplicateFindingIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
    dismissDecisions: {
      type: 'array',
      description: 'One optional adjudication per finding id listed as a dismissal candidate in the prompt. The allowed bases depend on the typed manager authority supplied by the engine. Leave empty when there are no candidates or every candidate deserves to stay open.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'basis', 'reason'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          basis: {
            enum: FINDING_DISMISSAL_BASES,
            description: 'All dismissal bases require verified terminal_adjudication authority. Unverifiable claims remain open and lead to a safe ABORT.',
          },
          reason: { type: 'string', minLength: 1 },
          evidence: {
            type: 'string',
            minLength: 1,
            description: 'Concrete current-code evidence supporting the classification. Silence or lack of a repeated report is not evidence.',
          },
          taskQuote: {
            type: 'string',
            minLength: 1,
            description: 'Required only for outside_task_scope: a byte-exact non-empty substring of the original workflow task.',
          },
          workflowTaskDigest: { type: 'string', pattern: SHA256_HEX_PATTERN.source },
          adjudicationTaskId: { type: 'string', pattern: SHA256_HEX_PATTERN.source },
        },
      },
    },
  },
} as const;

const ProductFindingProjectionOutputSchema = z.object({
  target: FindingTargetSchema,
  targetIdentityHash: Sha256Schema,
  familyTag: nonEmptyString,
  severity: FindingSeveritySchema,
  title: nonEmptyString,
  description: nonEmptyString,
  suggestion: nonEmptyString.nullable(),
  claimIdentityHash: Sha256Schema,
  semanticClaimIdentityHash: Sha256Schema,
  evidenceRecordIds: BinarySortedUniqueStringSetSchema,
}).strict();

export const ConflictAdjudicationProviderProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge_holding'),
    holdingSubjectId: nonEmptyString,
    targetProductSubjectId: nonEmptyString,
    authorityRefIds: BinarySortedUniqueStringSetSchema.min(1),
    actionableFix: OptionalAdjudicationTextSchema,
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('promote_holding'),
    holdingSubjectId: nonEmptyString,
    proposedProduct: ProductFindingProjectionOutputSchema,
    authorityRefIds: BinarySortedUniqueStringSetSchema.min(1),
    actionableFix: OptionalAdjudicationTextSchema,
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('terminate_subject'),
    subjectId: nonEmptyString,
    basis: z.enum(['finding_no_issue_after_verification', 'finding_claim_refuted']),
    authorityRefIds: BinarySortedUniqueStringSetSchema.min(1),
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('undetermined'),
    subjectIds: BinarySortedUniqueStringSetSchema.min(1),
    rationale: OptionalAdjudicationTextSchema,
  }).strict(),
]);

const adjudicationTextJsonSchema = { type: ['string', 'null'], minLength: 1 } as const;
const authorityRefsJsonSchema = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
} as const;

export const ConflictAdjudicationProviderProposalJsonSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'holdingSubjectId', 'targetProductSubjectId', 'authorityRefIds', 'actionableFix', 'rationale'],
      properties: {
        kind: { const: 'merge_holding' }, holdingSubjectId: { type: 'string', minLength: 1 },
        targetProductSubjectId: { type: 'string', minLength: 1 },
        authorityRefIds: authorityRefsJsonSchema, actionableFix: adjudicationTextJsonSchema,
        rationale: adjudicationTextJsonSchema,
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'holdingSubjectId', 'proposedProduct', 'authorityRefIds', 'actionableFix', 'rationale'],
      properties: {
        kind: { const: 'promote_holding' }, holdingSubjectId: { type: 'string', minLength: 1 },
        proposedProduct: productFindingProjectionJsonSchema,
        authorityRefIds: authorityRefsJsonSchema,
        actionableFix: adjudicationTextJsonSchema, rationale: adjudicationTextJsonSchema,
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subjectId', 'basis', 'authorityRefIds', 'rationale'],
      properties: {
        kind: { const: 'terminate_subject' }, subjectId: { type: 'string', minLength: 1 },
        basis: { enum: ['finding_no_issue_after_verification', 'finding_claim_refuted'] },
        authorityRefIds: authorityRefsJsonSchema, rationale: adjudicationTextJsonSchema,
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subjectIds', 'rationale'],
      properties: {
        kind: { const: 'undetermined' },
        subjectIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        rationale: adjudicationTextJsonSchema,
      },
    },
  ],
} as const;

export function parseConflictAdjudicationProposal(value: unknown): ConflictAdjudicationProposal {
  return ConflictAdjudicationProviderProposalSchema.parse(value);
}

const RawFindingsOutputIntakeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawFindings'],
  properties: {
    rawFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawExcerpt', 'candidate'],
        properties: {
          rawExcerpt: {
            type: 'string',
            minLength: 1,
            maxLength: RAW_FINDING_FIELD_LIMITS.maxDescriptionChars,
          },
          candidate: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: [
                  'rawFindingId',
                  'relation',
                  'targetFindingIds',
                  'familyTag',
                  'severity',
                  'title',
                  'description',
                  'suggestion',
                  'target',
                  'evidenceRequests',
                ],
                properties: {
                  rawFindingId: {
                    type: ['string', 'null'],
                    minLength: 1,
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars,
                  },
                  relation: {
                    enum: [...RAW_FINDING_RELATIONS, null],
                    description: 'Extract the stated ledger relation, or null when the report does not state one. Null remains an unresolved relation and is handled by canonical ambiguity admission.',
                  },
                  targetFindingIds: {
                    type: 'array',
                    maxItems: RAW_FINDING_NORMALIZER_LIMITS.maxTargetFindingIdsPerCandidate,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: RAW_FINDING_FIELD_LIMITS.maxFindingIdChars,
                    },
                    description: 'All explicitly labeled target finding IDs. Use [] for relation "new" or when the report states no target. The engine validates, deduplicates, and atomizes this list into one lifecycle raw finding per target.',
                  },
                  familyTag: {
                    type: ['string', 'null'],
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars,
                  },
                  severity: { enum: [...FINDING_SEVERITIES, null] },
                  title: {
                    type: ['string', 'null'],
                    minLength: 1,
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxTitleChars,
                  },
                  description: {
                    type: ['string', 'null'],
                    minLength: 1,
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxDescriptionChars,
                  },
                  suggestion: {
                    type: ['string', 'null'],
                    minLength: 1,
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxSuggestionChars,
                  },
                  target: {
                    anyOf: [
                      { type: 'null' },
                      {
                        type: 'object',
                        additionalProperties: false,
                        required: ['kind', 'paths'],
                        properties: {
                          kind: { const: 'code' },
                          paths: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                          },
                        },
                      },
                      {
                        type: 'object',
                        additionalProperties: false,
                        required: ['kind', 'scope', 'manifestTargets'],
                        properties: {
                          kind: { const: 'structure' },
                          scope: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['kind', 'roots'],
                            properties: {
                              kind: { const: 'review_scope' },
                              roots: {
                                type: 'array',
                                minItems: 1,
                                items: { type: 'string', minLength: 1 },
                              },
                            },
                          },
                          manifestTargets: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                          },
                        },
                      },
                      {
                        type: 'object',
                        additionalProperties: false,
                        required: ['kind', 'predicate'],
                        properties: {
                          kind: { const: 'absence' },
                          predicate: {
                            anyOf: [
                              {
                                type: 'object',
                                additionalProperties: false,
                                required: ['kind', 'path', 'expected'],
                                properties: {
                                  kind: { const: 'path_state' },
                                  path: { type: 'string', minLength: 1 },
                                  expected: { const: 'absent' },
                                },
                              },
                              {
                                type: 'object',
                                additionalProperties: false,
                                required: ['kind', 'roots', 'literal', 'textDomain'],
                                properties: {
                                  kind: { const: 'exact_literal_search' },
                                  roots: {
                                    type: 'array',
                                    minItems: 1,
                                    items: { type: 'string', minLength: 1 },
                                  },
                                  literal: { type: 'string', minLength: 1 },
                                  textDomain: { const: 'utf8' },
                                },
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                  evidenceRequests: {
                    type: 'array',
                    maxItems: 16,
                    items: {
                      anyOf: [
                        {
                          type: 'object',
                          additionalProperties: false,
                          required: ['kind', 'path', 'startLine', 'endLine'],
                          properties: {
                            kind: { const: 'file_quote' },
                            path: {
                              type: 'string',
                              minLength: 1,
                              maxLength: RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars,
                            },
                            startLine: { type: 'integer', minimum: 1 },
                            endLine: { type: 'integer', minimum: 1 },
                          },
                        },
                        {
                          type: 'object',
                          additionalProperties: false,
                          required: ['kind', 'subject'],
                          properties: {
                            kind: { const: 'engine_proof' },
                            subject: {
                              anyOf: [
                                {
                                  type: 'object',
                                  additionalProperties: false,
                                  required: ['kind'],
                                  properties: { kind: { const: 'repository_manifest' } },
                                },
                                {
                                  type: 'object',
                                  additionalProperties: false,
                                  required: ['kind'],
                                  properties: { kind: { const: 'repository_query' } },
                                },
                                {
                                  type: 'object',
                                  additionalProperties: false,
                                  required: ['kind', 'source', 'declarationId', 'verbatimExcerpt'],
                                  properties: {
                                    kind: { const: 'authoritative_quote' },
                                    source: { enum: ['task', 'public_declaration'] },
                                    declarationId: { type: 'string', minLength: 1 },
                                    verbatimExcerpt: { type: 'string', minLength: 1 },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;

const NATIVE_STRUCTURED_OUTPUT_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'anyOf',
  'items',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

function projectNativeStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectNativeStructuredOutputSchema);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const schema = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    const projectedKeyword = keyword === 'oneOf'
      ? 'anyOf'
      : keyword === 'const'
        ? 'enum'
        : keyword;
    if (!NATIVE_STRUCTURED_OUTPUT_SCHEMA_KEYWORDS.has(projectedKeyword)) {
      continue;
    }
    if (projectedKeyword === 'properties' || projectedKeyword === '$defs') {
      projected[projectedKeyword] = Object.fromEntries(
        Object.entries(keywordValue as Record<string, unknown>).map(([name, propertySchema]) => [
          name,
          projectNativeStructuredOutputSchema(propertySchema),
        ]),
      );
      continue;
    }
    projected[projectedKeyword] = keyword === 'const'
      ? [keywordValue]
      : projectNativeStructuredOutputSchema(keywordValue);
  }
  return projected;
}

export const RawFindingsOutputJsonSchema = projectNativeStructuredOutputSchema(
  RawFindingsOutputIntakeJsonSchema,
) as typeof RawFindingsOutputIntakeJsonSchema;

export const InterpretationCaseDecisionsOutputJsonSchema =
  projectNativeStructuredOutputSchema(
    InterpretationCaseDecisionsOutputIntakeJsonSchema,
  ) as typeof InterpretationCaseDecisionsOutputIntakeJsonSchema;

/** normalizer schema は snapshot/run/proof へ束縛せず、抽出だけを許可する。 */
export function createRawFindingsOutputJsonSchema() {
  return RawFindingsOutputJsonSchema;
}

/**
 * post-hoc 検証専用の raw findings schema（review-integrity requirement対応）。
 *
 * RawFindingsOutputJsonSchema（provider-facing、strict 様式）と役割を分離する:
 * - provider へ渡すのは strict 版のみ。
 * - schema が生成を拘束しない formless/劣化経路（opencode+ollama 等）の出力は
 *   こちらで検証する。
 * - provider item は StepExecutor の未信頼 intake で data descriptor だけから
 *   射影される。認識できない値は item 内の欠損へ落とし、ここでは required を
 *   課さない。欠損は canonicalization が item 単位の ambiguity として隔離する。
 *   1件の不正 item で structured output 全体を無効にすると、台帳へすら届かず
 *   安全な provisional 経路が機能しない。
 */
export const RawFindingsOutputValidationJsonSchema = {
  ...RawFindingsOutputIntakeJsonSchema,
  properties: {
    rawFindings: {
      ...RawFindingsOutputIntakeJsonSchema.properties.rawFindings,
      items: {
        ...RawFindingsOutputIntakeJsonSchema.properties.rawFindings.items,
        required: [],
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

export function parseFindingManagerDecisions(
  value: unknown,
): z.infer<typeof FindingManagerDecisionsSchema> {
  return FindingManagerDecisionsSchema.parse(value);
}

export function parseFindingManagerValidationReport(
  value: unknown,
): FindingManagerValidationReport {
  return FindingManagerValidationReportSchema.parse(value);
}
