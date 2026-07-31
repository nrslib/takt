import { z } from 'zod/v4';
import { PROVIDER_TYPES } from '../../shared/types/provider.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { normalizeRfc3339Timestamp } from './rfc3339.js';
import { collectFindingLedgerProjectionInvariantViolations } from './finding-ledger-invariants.js';
import {
  RAW_FINDING_FIELD_LIMITS,
  RAW_FINDING_NORMALIZER_LIMITS,
} from './finding-contract-limits.js';
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
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingManagerDecisions,
  FindingManagerOutput,
  FindingManagerValidationReport,
  FindingMutationPrecondition,
  RawFinding,
  RawFindingRelation,
} from './finding-types.js';
import type { AmbiguousInterpretation } from './finding-types.js';
import {
  AMBIGUOUS_INTERPRETATION_DECISIONS,
  RAW_FINDING_RELATIONS,
  CONFLICT_DECISION_KINDS,
  DISPUTE_DECISION_KINDS,
  FINDING_CONFLICT_ADJUDICATION_OUTCOMES,
  FINDING_CONFLICT_ADJUDICATION_TRANSITIONS,
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
  INTERPRETATION_APPLICATION_RESULTS,
  INTERPRETATION_RECOVERY_FAILURE_CODES,
  RAW_DECISION_KINDS,
  RAW_FINDING_DISPOSITION_OUTCOMES,
  REVIEWER_ANOMALY_KINDS,
  SEMANTIC_FINDING_DISMISSAL_BASES,
} from './finding-types.js';

const nonEmptyString = z.string().min(1);
const Sha256Schema = z.string().regex(SHA256_HEX_PATTERN);
const rawFindingIdString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxRawFindingIdChars);
const familyTagString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars);
const rawFindingTitleString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxTitleChars);

function validateFindingDismissalAuthority(
  dismissal: {
    basis: typeof FINDING_DISMISSAL_BASES[number];
    authority: typeof FINDING_MANAGER_AUTHORITIES[number];
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
}
const rawFindingDescriptionString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars);
const rawFindingSuggestionString = nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxSuggestionChars);
const BinarySortedUniqueStringSetSchema = z.array(nonEmptyString).superRefine((values, ctx) => {
  const canonical = [...new Set(values)].sort(compareBinaryStrings);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a binary-sorted unique string set',
    });
  }
});
const BinarySortedUniqueSha256SetSchema = z.array(Sha256Schema).superRefine((values, ctx) => {
  const canonical = [...new Set(values)].sort(compareBinaryStrings);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a binary-sorted unique SHA-256 set',
    });
  }
});
const UniqueSha256ListSchema = z.array(Sha256Schema).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected unique SHA-256 values',
    });
  }
});

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
  ledger_path: nonEmptyString,
  raw_findings_path: nonEmptyString,
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
  sourceRawFindingId: nonEmptyString.nullable(),
  sourceRawIntegrityDigest: Sha256Schema.nullable(),
  operation: z.enum(FINDING_LIFECYCLE_OPERATIONS),
  target: FindingLifecycleMutationTargetSchema,
}).strict();

const FindingAnchorAuthorityAdjudicationSchema = z.object({
  rawFindingId: nonEmptyString,
  decision: z.literal('relevant'),
  managerOutputBinding: Sha256Schema,
}).strict();

export const FindingLifecycleReservationContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transaction') }).strict(),
  z.object({
    kind: z.literal('conflict_adjudication'),
    conflictId: nonEmptyString,
    evidenceHash: Sha256Schema,
    originStep: nonEmptyString.nullable(),
  }).strict(),
]);

export const FindingLifecycleAuthoritySchema = z.union([
  z.object({
    kind: z.literal('verified_evidence'),
  }).strict(),
  z.object({
    kind: z.literal('engine_policy'),
    decisionKind: z.enum([
      'waive',
      'dispute',
      'dismiss',
      'resolve_conflict',
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
    kind: z.literal('conflict_adjudication'),
    conflictId: nonEmptyString,
    findingIds: BinarySortedUniqueStringSetSchema,
    evidenceHash: Sha256Schema,
    inputBindingIds: BinarySortedUniqueSha256SetSchema,
    originStep: nonEmptyString.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('system'),
    action: z.enum([
      'record_recovery_attempt',
      'settle_action_recovery',
      'sync_interpretation_epoch',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('rejected_observation'),
    rawFindingId: nonEmptyString,
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

export const FindingLifecycleOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('projection_applied'),
  }).strict(),
  z.object({
    kind: z.literal('conflict_adjudication'),
    conflictId: nonEmptyString,
    evidenceHash: Sha256Schema,
    outcome: z.enum(FINDING_CONFLICT_ADJUDICATION_OUTCOMES),
  }).strict(),
]);

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

export const RawRecoveryAttemptSchema = z.object({
  attemptId: Sha256Schema,
  provisionalFindingId: nonEmptyString,
  expectedHead: FindingLifecycleEntityHeadSchema,
  sourceRawFindingId: nonEmptyString,
  sourceRawIntegrityDigest: Sha256Schema.nullable(),
  promptSnapshotDigest: Sha256Schema,
  attempt: z.number().int().positive(),
  startedAt: FindingObservationSchema,
}).strict();

export const RawRecoveryResultSchema = z.object({
  resultId: Sha256Schema,
  attemptId: Sha256Schema,
  replayRawFindingId: nonEmptyString.nullable(),
  mutationIds: UniqueSha256ListSchema,
  outcome: z.enum(['applied', 'stale', 'failed']),
  completedAt: FindingObservationSchema,
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
      rawFindingId: nonEmptyString,
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
    expectedProductRawFindingIds: BinarySortedUniqueStringSetSchema.min(1),
    transitionPreconditionDigest: Sha256Schema,
    expectedIntermediateHead: z.object({
      revision: z.number().int().positive(),
      projectionDigest: Sha256Schema,
    }).strict(),
    materializedProductClaimDigest: Sha256Schema,
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
  sourceRawFindingIds: z.array(nonEmptyString),
  sourceIntakeIds: z.array(nonEmptyString),
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
    kind: z.literal('target_resolved_by_verified_evidence'),
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
  z.object({
    action: z.literal('dismiss'),
    findingId: nonEmptyString,
    basis: z.enum(FINDING_DISMISSAL_BASES),
    reason: nonEmptyString,
    evidence: nonEmptyString,
    authority: z.enum(FINDING_MANAGER_AUTHORITIES),
    targetPreconditions: z.array(FindingMutationPreconditionSchema).min(1),
  }).strict(),
]).superRefine((recovery, ctx) => {
  if (recovery.action === 'dismiss') {
    validateFindingDismissalAuthority(recovery, ctx);
  }
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
  sourceRawFindingIds: z.array(nonEmptyString),
  reason: nonEmptyString,
  firstObservedAt: FindingObservationSchema,
  lastObservedAt: FindingObservationSchema,
  interpretationEpochs: z.number().int().min(0),
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
  rawFindingIds: z.array(nonEmptyString),
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
    evidence: nonEmptyString,
    authority: z.enum(FINDING_MANAGER_AUTHORITIES),
    decidedAt: FindingObservationSchema,
  }).strict().superRefine(validateFindingDismissalAuthority).optional(),
  revision: z.number().int().positive(),
  provisional: FindingProvisionalMetadataSchema.optional(),
  rejectedObservations: z.array(z.object({
    rawFindingId: nonEmptyString,
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
  // Persisted ids are engine-namespaced and may legitimately exceed the
  // provider-facing local rawFindingId limit.
  rawFindingId: nonEmptyString,
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
  FileQuoteEvidenceSchema.omit({ snapshotId: true }).strict(),
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
  rawFindingId: rawFindingIdString.nullable(),
  familyTag: familyTagString.nullable(),
  severity: FindingSeveritySchema.nullable(),
  title: rawFindingTitleString.nullable(),
  description: rawFindingDescriptionString.nullable(),
  suggestion: rawFindingSuggestionString.nullable(),
  relation: z.enum(RAW_FINDING_RELATIONS).nullable(),
  targetFindingIds: z.array(
    nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxRawFindingIdChars),
  ).max(RAW_FINDING_NORMALIZER_LIMITS.maxTargetFindingIdsPerCandidate),
  target: FindingTargetSchema.nullable(),
  evidenceRequests: z.array(FindingEvidenceRequestSchema).max(16),
}).strict();

export const ReviewerRawFindingSchema = z.object({
  rawExcerpt: nonEmptyString.max(RAW_FINDING_FIELD_LIMITS.maxDescriptionChars),
  candidate: ReviewerCandidatePayloadSchema.nullable(),
}).strict();

export const FindingConflictAdjudicationOutcomeSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_OUTCOMES);
export const FindingConflictAdjudicationTransitionSchema = z.enum(FINDING_CONFLICT_ADJUDICATION_TRANSITIONS);

export const FindingConflictAdjudicationRecordSchema = z.object({
  evidenceHash: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  actionableFix: nonEmptyString.optional(),
  rationale: nonEmptyString.optional(),
  decidedAt: FindingObservationSchema,
}).strict();

export const FindingLedgerConflictSchema = z.object({
  id: nonEmptyString,
  status: z.enum(FINDING_CONFLICT_STATUSES),
  findingIds: z.array(nonEmptyString),
  rawFindingIds: z.array(nonEmptyString),
  description: nonEmptyString,
  firstSeen: FindingObservationSchema,
  lastSeen: FindingObservationSchema,
  resolvedAt: Rfc3339TimestampSchema.optional(),
  resolvedEvidence: nonEmptyString.optional(),
  adjudications: z.array(FindingConflictAdjudicationRecordSchema).optional(),
  revision: z.number().int().positive(),
}).strict();

/** 楽観的前提条件（CAS）。 */
/**
 * manager が ambiguous raw に返す「提案」。台帳操作そのものでは
 * ない。decision ごとの必須フィールドは AmbiguousInterpretationSchema の
 * superRefine と raw-capabilities.ts の runtime 検証の両方で強制する。
 */
export const AmbiguousInterpretationSchema = z.object({
  decision: z.enum(AMBIGUOUS_INTERPRETATION_DECISIONS),
  rawFindingId: nonEmptyString,
  // strict 様式の構造化出力では全プロパティ required になるため、該当なしは
  // 空文字で埋めさせて未指定として扱う。
  proofId: z.string().optional().transform((value) => (value ? value : undefined)),
  targetFindingId: z.string().optional().transform((value) => (value ? value : undefined)),
  reason: z.string().optional().transform((value) => (value ? value : undefined)),
}).strict();

export type ParsedAmbiguousInterpretation = z.infer<typeof AmbiguousInterpretationSchema>;

/**
 * parse 済み提案を判別可能な AmbiguousInterpretation へ正規化する。decision ごとの
 * 必須フィールド欠損は undefined を返す（呼び出し元が提案不正 → provisional へ
 * 落とす。例外にしない: manager の壊れた応答で run を殺さない）。
 */
export function toAmbiguousInterpretation(parsed: {
  decision: ParsedAmbiguousInterpretation['decision'];
  rawFindingId: string;
  proofId?: string | undefined;
  targetFindingId?: string | undefined;
  reason?: string | undefined;
}): AmbiguousInterpretation | undefined {
  switch (parsed.decision) {
    case 'create_independent':
      return { decision: 'create_independent', rawFindingId: parsed.rawFindingId };
    case 'same_with_proof':
      return parsed.proofId !== undefined
        ? { decision: 'same_with_proof', rawFindingId: parsed.rawFindingId, proofId: parsed.proofId }
        : undefined;
    case 'open_conflict':
      return parsed.targetFindingId !== undefined
        ? { decision: 'open_conflict', rawFindingId: parsed.rawFindingId, targetFindingId: parsed.targetFindingId }
        : undefined;
    case 'provisional':
      return parsed.reason !== undefined
        ? { decision: 'provisional', rawFindingId: parsed.rawFindingId, reason: parsed.reason }
        : undefined;
  }
}

/** WAL に保存する検証済み提案。判別型を復元できる形で保存する。 */
const StoredAmbiguousInterpretationSchema: z.ZodType<AmbiguousInterpretation> = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('create_independent'),
    rawFindingId: nonEmptyString,
  }).strict(),
  z.object({
    decision: z.literal('same_with_proof'),
    rawFindingId: nonEmptyString,
    proofId: nonEmptyString,
  }).strict(),
  z.object({
    decision: z.literal('open_conflict'),
    rawFindingId: nonEmptyString,
    targetFindingId: nonEmptyString,
  }).strict(),
  z.object({
    decision: z.literal('provisional'),
    rawFindingId: nonEmptyString,
    reason: nonEmptyString,
  }).strict(),
]);

const FindingInterpretationRecordBaseSchema = z.object({
  interpretationKey: nonEmptyString,
  baseInterpretationKey: nonEmptyString,
  attemptOrdinal: z.number().int().positive(),
  reviewerStableKey: nonEmptyString,
  lineageKey: nonEmptyString,
  candidateEvidenceHash: nonEmptyString,
  canonicalIntegrityDigest: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: FindingObservationSchema,
  promptPreconditions: z.array(FindingMutationPreconditionSchema),
});

export const FindingInterpretationRecordSchema = z.discriminatedUnion('stage', [
  FindingInterpretationRecordBaseSchema.extend({
    stage: z.literal('interpretation_started'),
    reservationToken: nonEmptyString,
  }).strict(),
  FindingInterpretationRecordBaseSchema.extend({
    stage: z.literal('interpretation_interrupted'),
    reservationToken: nonEmptyString,
    interruptedAt: FindingObservationSchema,
  }).strict(),
  FindingInterpretationRecordBaseSchema.extend({
    stage: z.enum(['interpretation_retryable_failure', 'interpretation_terminal_failure']),
    failedAt: FindingObservationSchema,
    failureCode: z.enum(INTERPRETATION_RECOVERY_FAILURE_CODES),
    failureReason: nonEmptyString,
    sourceRawFindingId: nonEmptyString,
    provisionalFindingId: nonEmptyString,
  }).strict(),
  FindingInterpretationRecordBaseSchema.extend({
    stage: z.literal('interpretation_completed'),
    reservationToken: nonEmptyString,
    completedAt: FindingObservationSchema,
    validatedDecision: StoredAmbiguousInterpretationSchema,
  }).strict(),
  FindingInterpretationRecordBaseSchema.extend({
    stage: z.literal('ledger_applied'),
    reservationToken: nonEmptyString,
    completedAt: FindingObservationSchema,
    validatedDecision: StoredAmbiguousInterpretationSchema,
    appliedAt: FindingObservationSchema,
    applicationResult: z.enum(INTERPRETATION_APPLICATION_RESULTS),
  }).strict(),
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
  rawFindingId: nonEmptyString,
  location: z.string(),
  reason: nonEmptyString,
}).strict();

const UnsupportedRawFindingReportSchema = z.object({
  rawFindingId: nonEmptyString,
  targetFindingId: nonEmptyString,
  evidence: nonEmptyString,
}).strict();

const ReviewerOutputOverflowReportSchema = z.object({
  reviewer: nonEmptyString,
  reason: nonEmptyString,
}).strict();

const RawNormalizationAuditRecordSchema = z.object({
  rawFindingId: nonEmptyString,
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
  sourceRawFindingIds: z.array(nonEmptyString),
}).strict();

const ReviewerAnomalyLandingReportSchema = z.object({
  kind: nonEmptyString,
  stableKey: nonEmptyString,
  reason: nonEmptyString,
  sourceRawFindingIds: z.array(nonEmptyString),
  sourceIntakeIds: z.array(nonEmptyString),
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

const RawFindingDispositionSchema = z.object({
  rawFindingId: nonEmptyString,
  outcome: z.enum(RAW_FINDING_DISPOSITION_OUTCOMES),
  reason: nonEmptyString,
}).strict();

const InterpretationRecoveryOriginSettlementSchema = z.discriminatedUnion('outcome', [
  z.object({
    provisionalFindingId: nonEmptyString,
    sourceRawFindingId: nonEmptyString,
    outcome: z.literal('audit_only'),
    failureKind: z.enum([
      'source_missing',
      'reviewer_provenance_missing',
      'recovery_contract_mismatch',
    ]),
    reason: nonEmptyString,
  }).strict(),
  z.object({
    provisionalFindingId: nonEmptyString,
    sourceRawFindingId: nonEmptyString,
    outcome: z.literal('stale'),
    reason: nonEmptyString,
  }).strict(),
  z.object({
    provisionalFindingId: nonEmptyString,
    sourceRawFindingId: nonEmptyString,
    outcome: z.literal('settled'),
    targetFindingId: nonEmptyString,
  }).strict(),
  z.object({
    provisionalFindingId: nonEmptyString,
    sourceRawFindingId: nonEmptyString,
    outcome: z.literal('retained'),
  }).strict(),
]);

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
    flaggedRawFindingIds: z.array(nonEmptyString),
  }).strict()).optional(),
  rawFindingDispositions: z.array(RawFindingDispositionSchema).optional(),
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
      ownedIds: z.array(nonEmptyString),
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
      ownedIds: z.array(nonEmptyString),
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
  rawRecoveryAttempts: z.array(RawRecoveryAttemptSchema),
  rawRecoveryResults: z.array(RawRecoveryResultSchema),
  rawFindings: z.array(RawFindingSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
  interpretations: z.array(FindingInterpretationRecordSchema),
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
  rawRecoveryAttempts: z.array(RawRecoveryAttemptSchema),
  rawRecoveryResults: z.array(RawRecoveryResultSchema),
  rawFindings: z.array(RawFindingSchema),
  conflicts: z.array(FindingLedgerConflictSchema),
  interpretations: z.array(FindingInterpretationRecordSchema),
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

/**
 * findings-manager の ambiguous 解釈フェーズが返す structured output の JSON
 * schema。提案（proposal）だけを返させる — 台帳操作の配列は返させない。
 */
export const AmbiguousInterpretationsOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretations'],
  properties: {
    interpretations: {
      type: 'array',
      description: 'Exactly one interpretation per ambiguous raw finding listed in the prompt. These are PROPOSALS: the engine holds all authority and rejects anything outside your granted capabilities.',
      // 構造的なハード上限（synthetic-step requirement）: 出力サイズは schema レベルで有界化する。
      // batch は最大16件（MANAGER_INTERPRETATION_LIMITS.maxAmbiguousCandidatesPerBatch）、
      // 各フィールドは固定長。chars/4 のトークン概算は計測・ログ用であって
      // ハード上限ではない（native structured output provider は生成自体が
      // この schema で拘束される）。
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'rawFindingId', 'proofId', 'targetFindingId', 'reason'],
        properties: {
          decision: {
            enum: AMBIGUOUS_INTERPRETATION_DECISIONS,
            description: 'create_independent = the observation is a real, independent problem; a NEW open finding is created (existing findings are never touched). same_with_proof = you assert it is identical to an existing open finding AND the prompt gave you an engine-issued proofId for that pair; echo that proofId. open_conflict = it relates to an existing finding but you cannot determine identity; an active conflict is recorded against that finding (the finding is not closed). provisional = you cannot determine the meaning; the observation is kept as a gate-blocking provisional finding.',
          },
          rawFindingId: { type: 'string', minLength: 1, maxLength: 512 },
          proofId: {
            type: 'string',
            maxLength: 128,
            description: 'Required for same_with_proof: an engine-issued proof id from the prompt. Empty string otherwise. You cannot mint proof ids yourself.',
          },
          targetFindingId: {
            type: 'string',
            maxLength: 128,
            description: 'Required for open_conflict: the existing finding id the observation conflicts with. Empty string otherwise.',
          },
          reason: {
            type: 'string',
            maxLength: 2048,
            description: 'Required for provisional: why the meaning cannot be determined. Empty string otherwise.',
          },
        },
      },
    },
  },
} as const;

export function parseAmbiguousInterpretations(value: unknown): ParsedAmbiguousInterpretation[] {
  const parsed = z.object({ interpretations: z.array(AmbiguousInterpretationSchema) }).strict().parse(value);
  return parsed.interpretations;
}

export const FindingManagerOutputSchema = z.object({
  anchorAdjudications: z.array(z.object({
    rawFindingId: nonEmptyString,
    rawDecision: z.enum(RAW_DECISION_KINDS),
    findingId: nonEmptyString.nullable(),
    decision: z.enum(['relevant', 'not_relevant', 'not_applicable']),
    rationale: z.string(),
    managerOutputBinding: Sha256Schema,
  }).strict()),
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
    findingIds: z.array(nonEmptyString),
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
    evidence: nonEmptyString,
    authority: z.enum(FINDING_MANAGER_AUTHORITIES),
  }).strict().superRefine(validateFindingDismissalAuthority)),
}).strict();

// LLM に返させるのは判断だけ。アクション配列への組み立てと不変条件の強制は
// decision-assembly.ts（コード側）が行う。findingId は same/resolved/reopened/
// conflict でのみ必須なため、strict 様式の制約上は required に含めつつ、
// 該当なし（new/unsupported）は空文字で埋めさせて未指定として扱う。
export const FindingManagerRawDecisionSchema = z.object({
  rawFindingId: nonEmptyString,
  decision: z.enum(RAW_DECISION_KINDS),
  anchorRelevance: z.enum(['relevant', 'not_relevant', 'not_applicable']),
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
          rawFindingId: { type: 'string', minLength: 1 },
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
        required: ['findingId', 'basis', 'reason', 'evidence', 'authority'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          basis: { enum: FINDING_DISMISSAL_BASES },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
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
export const FindingManagerDecisionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions', 'invalidateDecisions', 'duplicateDecisions', 'dismissDecisions'],
  properties: {
    rawDecisions: {
      type: 'array',
      description: 'Exactly one decision per residual raw finding listed in the prompt.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFindingId', 'decision', 'anchorRelevance', 'findingId', 'evidence'],
        properties: {
          rawFindingId: {
            type: 'string',
            minLength: 1,
            description: 'Engine-namespaced raw finding id from the manager prompt.',
          },
          decision: {
            enum: RAW_DECISION_KINDS,
            description: 'same = matches an existing open finding (familyTag and line-number differences alone are not disqualifying; judge by failure mode, trigger, impact, and required fix). new = no related finding exists yet. resolved = confirms an existing open finding is fixed. reopened = a previously resolved/waived/dismissed finding reappeared. conflict = contradicts an existing finding. unsupported = the raw finding explicitly referenced an existing finding (targetFindingId) as persists/reopened but the reference does not hold up; do not fall back to new.',
          },
          anchorRelevance: {
            enum: ['relevant', 'not_relevant', 'not_applicable'],
            description: 'For an absence target, explicitly decide whether its verified task/public authoritative quote is relevant to the claimed missing obligation. The engine has verified quote existence only. Use relevant only when the quote actually establishes the obligation, not_relevant otherwise. Use not_applicable for code/structure targets.',
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
        required: ['findingId', 'basis', 'reason', 'evidence'],
        properties: {
          findingId: { type: 'string', minLength: 1 },
          basis: {
            enum: FINDING_DISMISSAL_BASES,
            description: 'out_of_scope and unverifiable_claim are standard jurisdiction bases. false_positive, overreach, and no_issue_after_verification require terminal_adjudication authority.',
          },
          reason: { type: 'string', minLength: 1 },
          evidence: {
            type: 'string',
            minLength: 1,
            description: 'Concrete current-code evidence supporting the classification. Silence or lack of a repeated report is not evidence.',
          },
        },
      },
    },
  },
} as const;

export const FindingConflictAdjudicationOutputSchema = z.object({
  conflictId: nonEmptyString,
  outcome: FindingConflictAdjudicationOutcomeSchema,
  actionableFix: nonEmptyString.optional(),
  rationale: nonEmptyString.optional(),
}).strict();

export const FindingConflictAdjudicationOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conflictId', 'outcome'],
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
    actionableFix: {
      type: 'string',
      minLength: 1,
      description: 'For finding_valid: the concrete code change the coder must make. Omit for every other outcome. A finding_valid without this field is treated as undetermined and blocks the run.',
    },
    rationale: {
      type: 'string',
      minLength: 1,
      description: 'Optional concise explanation of the judgment. This is an annotation only; it is never treated as lifecycle evidence.',
    },
  },
} as const;

export function parseFindingConflictAdjudicationOutput(value: unknown): FindingConflictAdjudicationOutput {
  return FindingConflictAdjudicationOutputSchema.parse(value);
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
                    maxLength: RAW_FINDING_FIELD_LIMITS.maxRawFindingIdChars,
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
                      maxLength: RAW_FINDING_FIELD_LIMITS.maxRawFindingIdChars,
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
                          required: ['kind', 'path', 'startLine', 'endLine', 'verbatimExcerpt'],
                          properties: {
                            kind: { const: 'file_quote' },
                            path: {
                              type: 'string',
                              minLength: 1,
                              maxLength: RAW_FINDING_FIELD_LIMITS.maxEvidencePathChars,
                            },
                            startLine: { type: 'integer', minimum: 1 },
                            endLine: { type: 'integer', minimum: 1 },
                            verbatimExcerpt: {
                              type: 'string',
                              minLength: 1,
                              maxLength: RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptChars,
                            },
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

export function parseFindingManagerDecisions(value: unknown): FindingManagerDecisions {
  return FindingManagerDecisionsSchema.parse(value);
}

export function parseFindingManagerValidationReport(
  value: unknown,
): FindingManagerValidationReport {
  return FindingManagerValidationReportSchema.parse(value);
}
