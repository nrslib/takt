import type {
  CanonicalRawFindingProvenance,
  FindingLifecycleEntityHead,
  FindingLedgerEntry,
  FindingObservation,
  FindingProvisionalKind,
  FindingSeverity,
  FindingTarget,
  InterpretationDecision,
  InterpretationPolicyClass,
} from './finding-types.js';

export type NonEmptyArray<Value> = [Value, ...Value[]];

export interface RawCanonicalSnapshot {
  rawCanonicalSnapshotId: string;
  rawFindingId: string;
  rawPayloadDigest: string;
  reviewerStableKey: string;
  lineageKey: string;
  targetIdentityHash: string;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  canonicalProvenance: CanonicalRawFindingProvenance;
  canonicalizationContextDigest: string;
  captureAdmissionSnapshotId: string;
  captureDependencyDigests: string[];
  canonicalIntegrityDigest: string;
  capturedAt: FindingObservation;
}

export interface InterpretationCaseSnapshot {
  caseSnapshotId: string;
  caseId: string;
  cohortId: string;
  roundIdentity: string;
  lineageKey: string;
  policyClass: InterpretationPolicyClass;
  semanticProjectionDigest: string;
  memberRawFindingIds: string[];
  memberObservationDigests: string[];
  originSnapshotSetDigest: string;
  createdAt: FindingObservation;
}

export interface InterpretationRawObservation {
  observationDigest: string;
  rawFindingId: string;
  rawCanonicalSnapshotId: string;
  caseId: string;
  cohortId: string;
  caseSnapshotId: string;
  lineageKey: string;
  semanticProjectionDigest: string;
  originSnapshotDigests: string[];
  recoveryOriginBindingIds: string[];
}

export interface InterpretationRecoveryOriginBinding {
  bindingId: string;
  caseSnapshotId: string;
  caseId: string;
  cohortId: string;
  observationRawFindingId: string;
  originFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  originProvisionalKind: FindingProvisionalKind;
  originStableKey: string;
  originLineageKey: string;
  recoveryReviewerStableKey: string;
  sourceRawFindingIdsDigest: string;
  originSnapshotDigest: string;
  boundAt: FindingObservation;
}

interface InterpretationRecoveryOriginSettlementBase {
  settlementId: string;
  bindingId: string;
  caseSnapshotId: string;
  caseId: string;
  observationRawFindingId: string;
  originFindingId: string;
  originSnapshotDigest: string;
  recordedAt: FindingObservation;
}

export type InterpretationRecoveryOriginSettlement =
  | InterpretationRecoveryOriginSettlementBase & {
      outcome: 'stale';
      reason: string;
    }
  | InterpretationRecoveryOriginSettlementBase & {
      outcome: 'retained';
      reason:
        | 'case_decision_provisional'
        | 'case_decision_rejected_stale'
        | 'case_decision_rejected_raw_invalid'
        | 'origin_not_targeted';
    }
  | InterpretationRecoveryOriginSettlementBase & {
      outcome: 'settled';
      targetFindingId: string;
      lifecycleEventId: string;
    };

export type InterpretationAttemptApplication =
  | {
      classification: 'decision_applied';
      originSettlementIds: string[];
    }
  | {
      classification: 'decision_rejected_stale';
      staleCauseDigests: string[];
      originSettlementIds: string[];
    }
  | {
      classification: 'decision_rejected_raw_invalid';
      invalidRawFindingIds: string[];
      originSettlementIds: string[];
    };

interface InterpretationAttemptBase {
  attemptId: string;
  caseSnapshotId: string;
  caseId: string;
  cohortId: string;
  lineageKey: string;
  semanticProjectionDigest: string;
  attemptOrdinal: number;
  retryOrdinal: 0 | 1;
  rawFindingIds: string[];
  providerCallId: string;
}

export type InterpretationAttempt =
  | InterpretationAttemptBase & {
      stage: 'started';
      startedAt: FindingObservation;
    }
  | InterpretationAttemptBase & {
      stage: 'interrupted';
      startedAt: FindingObservation;
      interruptedAt: FindingObservation;
      reason: 'provider_result_unknown';
    }
  | InterpretationAttemptBase & {
      stage: 'completed';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      decision: InterpretationDecision;
    }
  | InterpretationAttemptBase & {
      stage: 'applied';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      appliedAt: FindingObservation;
      decision: InterpretationDecision;
      application: InterpretationAttemptApplication;
    };

export type RawInterpretationOutcome =
  | {
      rawFindingId: string;
      kind: 'pending_attempt';
      attemptId: string;
    }
  | {
      rawFindingId: string;
      kind: 'finding';
      findingId: string;
      outcome: 'created' | 'matched_with_proof';
      landingEventId: string;
    }
  | {
      rawFindingId: string;
      kind: 'provisional';
      provisionalFindingId: string;
      landingEventId: string;
    }
  | {
      rawFindingId: string;
      kind: 'conflict';
      conflictId: string;
      rawClaimLandingId: string;
      provisionalFindingId: string;
      conflictLandingEventId: string;
      provisionalLandingEventId: string;
    }
  | {
      rawFindingId: string;
      kind: 'reviewer_anomaly';
      anomalyId: string;
    };

export interface ConflictRawClaimLanding {
  rawClaimLandingId: string;
  conflictId: string;
  rawFindingId: string;
  rawCanonicalSnapshotId: string;
  rawPayloadDigest: string;
  claimSnapshotDigest: string;
  holdingAllocationId: string;
  holdingFindingId: string;
  holdingHeadAfterLanding: FindingLifecycleEntityHead;
  landingEventId: string;
  landedAt: FindingObservation;
}

export interface FindingManagerProviderBudgetLimits {
  maxCallsPerRound: number;
  maxAdapterVisibleInputBytesPerCall: number;
  maxOutputTokensPerCall: number;
  maxChargedInputTokensPerRound: number;
  maxChargedOutputTokensPerRound: number;
}

export interface FindingManagerProviderBudgetScope {
  budgetScopeId: string;
  roundIdentity: string;
  scopeIdentity: string;
  workflowName: string;
  roundMarker: string;
  limits: FindingManagerProviderBudgetLimits;
  createdAt: FindingObservation;
}

export type FindingManagerAttemptKind =
  | 'interpretation'
  | 'terminal_adjudication'
  | 'conflict_adjudication';

export type FindingManagerCallFailurePhase =
  | 'provider_failed'
  | 'parse_failed'
  | 'provider_contract_rejected'
  | 'output_oversize'
  | 'provider_result_unknown';

export interface FindingManagerTokenCharge {
  callCount: 1;
  inputTokens: number;
  outputTokens: number;
  inputBasis:
    | 'provider_usage'
    | 'exact_tokenizer'
    | 'request_ceiling'
    | 'failure_ceiling';
  outputBasis:
    | 'provider_usage'
    | 'exact_tokenizer'
    | 'utf8_byte_upper_bound'
    | 'response_ceiling'
    | 'failure_ceiling';
}

interface FindingManagerProviderCallBase {
  providerCallId: string;
  budgetScopeId: string;
  purpose: FindingManagerAttemptKind;
  callOrdinal: number;
  ownerAttemptKind: FindingManagerAttemptKind;
  ownerAttemptId: string;
  attemptIds: string[];
  requestDigest: string;
  requestByteLength: number;
  measuredAdapterVisibleInputTokens: number;
  inputMeasurementBasis: 'exact_tokenizer' | 'utf8_byte_upper_bound';
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedAt: FindingObservation;
}

export type FindingManagerProviderCall =
  | FindingManagerProviderCallBase & {
      state: 'reserved';
    }
  | FindingManagerProviderCallBase & {
      state: 'dispatched';
      dispatchedAt: FindingObservation;
    }
  | FindingManagerProviderCallBase & {
      state: 'settled';
      dispatchedAt: FindingObservation;
      settledAt: FindingObservation;
      resultKind: 'accepted' | 'rejected' | 'interrupted_unknown';
      failurePhase?: FindingManagerCallFailurePhase;
      responseDigest?: string;
      charge: FindingManagerTokenCharge;
    };

export interface FindingScopeBinding {
  bindingId: string;
  source: 'workflow_task_scope' | 'finding_contract_scope';
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  workflowTaskDigest: string;
  findingContractDigest: string;
  predicate:
    | { kind: 'target_path_roots'; allowedRoots: string[] }
    | { kind: 'target_kind_set'; allowedKinds: FindingTarget['kind'][] }
    | { kind: 'family_tag_set'; allowedFamilyTags: string[] };
  result: 'outside';
  verifierId: string;
  verifierVersion: string;
  dependencyDigests: string[];
  issuedAt: FindingObservation;
}

export interface ProductFindingProjection {
  target: FindingTarget;
  targetIdentityHash: string;
  familyTag: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  suggestion: string | null;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  evidenceRecordIds: string[];
}

export interface TerminalSourceClaimRef {
  sourceClaimRefId: string;
  rawFindingId: string;
  rawCanonicalSnapshotId: string;
  rawPayloadDigest: string;
  provenanceEventId: string;
}

export interface TerminalTargetCandidateRef {
  targetRefId: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  claimSnapshotDigest: string;
}

export interface TerminalAdjudicationCandidateSnapshot {
  candidateSnapshotDigest: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  provisionalKind: FindingProvisionalKind;
  provisionalStableKey: string;
  lineageKey: string;
  sourceClaims: TerminalSourceClaimRef[];
  targetCandidates: TerminalTargetCandidateRef[];
}

export interface TerminalAdjudicationSelectionMember {
  findingId: string;
  episodeId: string;
  candidateSnapshotDigest: string;
}

export interface TerminalAdjudicationRound {
  roundIdentity: string;
  selectionId: string;
  members: TerminalAdjudicationSelectionMember[];
  selectedAt: FindingObservation;
}

export interface TerminalAdjudicationEpisode {
  episodeId: string;
  selectionId: string;
  roundIdentity: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  candidateSnapshotDigest: string;
  maxAttempts: 2;
  createdAt: FindingObservation;
}

export type TerminalAdjudicationProposal =
  | {
      kind: 'promote_independent';
      proposedProduct: ProductFindingProjection;
      authorityRefIds: string[];
      rationale?: string;
    }
  | {
      kind: 'merge_existing';
      targetRefId: string;
      authorityRefIds: string[];
      rationale?: string;
    }
  | {
      kind: 'dismiss';
      basis:
        | 'outside_contract_jurisdiction'
        | 'outside_task_scope'
        | 'false_positive'
        | 'overreach'
        | 'no_issue_after_verification';
      authorityRefIds: string[];
      rationale?: string;
    }
  | { kind: 'undetermined'; rationale?: string };

interface TerminalAttemptBase {
  attemptId: string;
  episodeId: string;
  selectionId: string;
  roundIdentity: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  candidateSnapshotDigest: string;
  attemptOrdinal: 1 | 2;
  retryOrdinal: 0 | 1;
  providerCallId: string;
  requestDigest: string;
  sourceClaimRefIds: string[];
}

export type TerminalAdjudicationAttempt =
  | TerminalAttemptBase & { stage: 'started'; startedAt: FindingObservation }
  | TerminalAttemptBase & {
      stage: 'interrupted';
      startedAt: FindingObservation;
      interruptedAt: FindingObservation;
      reason: 'provider_result_unknown';
    }
  | TerminalAttemptBase & {
      stage: 'proposed';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      proposal: TerminalAdjudicationProposal;
      proposalDigest: string;
    }
  | TerminalAttemptBase & {
      stage: 'completed';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      result:
        | {
            kind: 'diagnostic_undetermined';
            code:
              | 'provider_contract_rejected'
              | 'parse_failed'
              | 'provider_failed'
              | 'output_oversize';
            responseDigest: string | null;
            diagnosticDigest: string;
          }
        | {
            kind: 'verification_undetermined';
            proposal: TerminalAdjudicationProposal;
            proposalDigest: string;
            reasonCodes: string[];
          }
        | {
            kind: 'stale_precondition';
            proposal: TerminalAdjudicationProposal | null;
            proposalDigest: string | null;
            actualHead: FindingLifecycleEntityHead | null;
          };
    }
  | TerminalAttemptBase & {
      stage: 'applied';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      appliedAt: FindingObservation;
      proposal: Exclude<TerminalAdjudicationProposal, { kind: 'undetermined' }>;
      proposalDigest: string;
      verificationDigest: string;
      settlementId: string;
      lifecycleEventIds: string[];
    };

interface TerminalAdjudicationSettlementBase {
  settlementId: string;
  episodeId: string;
  attemptId: string;
  provisionalFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  sourceClaimRefIds: string[];
  lifecycleEventIds: string[];
  verificationDigest: string;
  recordedAt: FindingObservation;
}

export type TerminalAdjudicationSettlement =
  | TerminalAdjudicationSettlementBase & {
      outcome: 'promoted';
      targetFindingId: string;
    }
  | TerminalAdjudicationSettlementBase & {
      outcome: 'merged';
      targetFindingId: string;
    }
  | TerminalAdjudicationSettlementBase & { outcome: 'dismissed' }
  | {
      settlementId: string;
      episodeId: string;
      attemptId: string;
      provisionalFindingId: string;
      expectedHead: FindingLifecycleEntityHead;
      candidateSnapshotDigest: string;
      outcome: 'exhausted';
      reason: 'stale_precondition' | 'attempts_exhausted_interrupted';
      supersedingEpisodeId: string | null;
      supersedingCandidateSnapshotDigest: string | null;
      recordedAt: FindingObservation;
    }
  | {
      settlementId: string;
      episodeId: string;
      provisionalFindingId: string;
      expectedHead: FindingLifecycleEntityHead;
      candidateSnapshotDigest: string;
      outcome: 'superseded';
      reason: 'candidate_snapshot_changed' | 'subject_no_longer_candidate';
      supersedingEpisodeId: string | null;
      supersedingCandidateSnapshotDigest: string | null;
      recordedAt: FindingObservation;
    }
  | {
      settlementId: string;
      episodeId: string;
      provisionalFindingId: string;
      candidateSnapshotDigest: string;
      outcome: 'reclassified_to_reviewer_anomaly';
      reason: 'product_claim_not_adjudicated';
      migrationId: string;
      attemptIds: string[];
      scopeBindingIds: string[];
      recordedAt: FindingObservation;
    };

export type ConflictClaimRole = 'product_finding' | 'holding_provisional';

interface ConflictClaimSubjectBase {
  subjectId: string;
  conflictId: string;
  role: ConflictClaimRole;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  targetIdentityHash: string | null;
  claimIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
  claimSnapshotDigest: string;
  sourceRawFindingIds: string[];
  sourceRawPayloadDigests: string[];
  evidenceBindingIds: string[];
  evidenceSetDigest: string;
}

export type ConflictClaimSubject =
  | ConflictClaimSubjectBase & {
      role: 'product_finding';
      rawClaimLandingIds: [];
    }
  | ConflictClaimSubjectBase & {
      role: 'holding_provisional';
      rawClaimLandingIds: string[];
    };

export interface ConflictAdjudicationSnapshot {
  conflictSnapshotId: string;
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  claimUniverseDigest: string;
  coverageSnapshotDigest: string;
  evidenceSnapshotDigest: string;
  rawClaimLandingIds: string[];
  priorSettlementIds: string[];
  subjects: ConflictClaimSubject[];
  originStep: string | null;
  createdAt: FindingObservation;
}

export interface ConflictAdjudicationEpisode {
  episodeId: string;
  conflictSnapshotId: string;
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  maxAttempts: 2;
  createdAt: FindingObservation;
}

export type ConflictAdjudicationProposal =
  | {
      kind: 'merge_holding';
      holdingSubjectId: string;
      targetProductSubjectId: string;
      authorityRefIds: string[];
      actionableFix?: string;
      rationale?: string;
    }
  | {
      kind: 'promote_holding';
      holdingSubjectId: string;
      proposedProduct: ProductFindingProjection;
      authorityRefIds: string[];
      actionableFix?: string;
      rationale?: string;
    }
  | {
      kind: 'terminate_subject';
      subjectId: string;
      basis: 'finding_no_issue_after_verification' | 'finding_claim_refuted';
      authorityRefIds: string[];
      rationale?: string;
    }
  | { kind: 'undetermined'; subjectIds: string[]; rationale?: string };

export type ConflictVerificationFailureCode =
  | 'snapshot_not_fresh'
  | 'subject_not_found'
  | 'subject_role_mismatch'
  | 'target_not_found'
  | 'head_not_fresh'
  | 'raw_claim_coverage_mismatch'
  | 'authority_not_found'
  | 'authority_kind_mismatch'
  | 'authority_binding_mismatch'
  | 'actionable_fix_missing';

declare const verifiedConflictAdjudicationAuthorityBrand: unique symbol;

export type VerifiedConflictAdjudicationAuthority =
  | {
      readonly [verifiedConflictAdjudicationAuthorityBrand]: true;
      readonly kind: 'merge_holding';
      readonly conflictSnapshotId: string;
      readonly holdingSubjectId: string;
      readonly holdingFindingId: string;
      readonly holdingExpectedHead: FindingLifecycleEntityHead;
      readonly rawClaimLandingIds: string[];
      readonly targetProductSubjectId: string;
      readonly targetFindingId: string;
      readonly targetExpectedHead: FindingLifecycleEntityHead;
      readonly exactClaimIdentityDigest: string;
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    }
  | {
      readonly [verifiedConflictAdjudicationAuthorityBrand]: true;
      readonly kind: 'promote_holding';
      readonly conflictSnapshotId: string;
      readonly holdingSubjectId: string;
      readonly holdingFindingId: string;
      readonly holdingExpectedHead: FindingLifecycleEntityHead;
      readonly rawClaimLandingIds: string[];
      readonly productProjection: ProductFindingProjection;
      readonly productProjectionDigest: string;
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    }
  | {
      readonly [verifiedConflictAdjudicationAuthorityBrand]: true;
      readonly kind: 'terminate_subject';
      readonly conflictSnapshotId: string;
      readonly subjectId: string;
      readonly subjectRole: ConflictClaimRole;
      readonly findingId: string;
      readonly subjectExpectedHead: FindingLifecycleEntityHead;
      readonly rawClaimLandingIds: string[];
      readonly basis: 'finding_no_issue_after_verification' | 'finding_claim_refuted';
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    };

export type ResolvedConflictAdjudicationPlan =
  | { kind: 'undetermined'; reasonCodes: ConflictVerificationFailureCode[] }
  | {
      kind: 'merge_holding';
      authority: Extract<VerifiedConflictAdjudicationAuthority, { kind: 'merge_holding' }>;
      actionableFix: string | null;
    }
  | {
      kind: 'promote_holding';
      authority: Extract<VerifiedConflictAdjudicationAuthority, { kind: 'promote_holding' }>;
      actionableFix: string | null;
    }
  | {
      kind: 'terminate_subject';
      authority: Extract<VerifiedConflictAdjudicationAuthority, { kind: 'terminate_subject' }>;
    };

interface ConflictAttemptBase {
  attemptId: string;
  episodeId: string;
  conflictSnapshotId: string;
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  attemptOrdinal: 1 | 2;
  retryOrdinal: 0 | 1;
  providerCallId: string;
  requestDigest: string;
  subjectIds: string[];
  originStep: string | null;
}

export type ConflictAdjudicationAttempt =
  | ConflictAttemptBase & { stage: 'started'; startedAt: FindingObservation }
  | ConflictAttemptBase & {
      stage: 'interrupted';
      startedAt: FindingObservation;
      interruptedAt: FindingObservation;
      reason: 'provider_result_unknown';
    }
  | ConflictAttemptBase & {
      stage: 'proposed';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      proposal: ConflictAdjudicationProposal;
      proposalDigest: string;
    }
  | ConflictAttemptBase & {
      stage: 'completed';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      result:
        | {
            kind: 'diagnostic_undetermined';
            code:
              | 'provider_contract_rejected'
              | 'parse_failed'
              | 'provider_failed'
              | 'output_oversize';
            responseDigest: string | null;
            diagnosticDigest: string;
          }
        | {
            kind: 'verification_undetermined';
            proposal: ConflictAdjudicationProposal;
            proposalDigest: string;
            reasonCodes: string[];
          }
        | {
            kind: 'stale_precondition';
            proposal: ConflictAdjudicationProposal;
            proposalDigest: string;
          };
    }
  | ConflictAttemptBase & {
      stage: 'applied';
      startedAt: FindingObservation;
      completedAt: FindingObservation;
      appliedAt: FindingObservation;
      proposal: Exclude<ConflictAdjudicationProposal, { kind: 'undetermined' }>;
      proposalDigest: string;
      verificationDigest: string;
      claimSettlementIds: string[];
      lifecycleEventIds: string[];
    };

interface ConflictClaimSettlementBase {
  settlementId: string;
  conflictId: string;
  conflictSnapshotId: string;
  subjectId: string;
  subjectRole: ConflictClaimRole;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  attemptId: string;
  rawClaimLandingIds: string[];
  lifecycleEventIds: string[];
  verificationDigest: string;
  recordedAt: FindingObservation;
}

export type ConflictClaimSettlement =
  | AdjudicatedConflictClaimSettlement
  | ProvisionalConflictNormalizationSettlement;

export type AdjudicatedConflictClaimSettlement =
  | ConflictClaimSettlementBase & { outcome: 'merged'; targetFindingId: string }
  | ConflictClaimSettlementBase & { outcome: 'promoted'; targetFindingId: string }
  | ConflictClaimSettlementBase & { outcome: 'resolved' }
  | ConflictClaimSettlementBase & { outcome: 'invalidated' };

export type ProvisionalConflictNormalizationSubject =
  | ProvisionalConflictNormalizationSubjectBase & {
      role: 'provisional_target';
      rawClaimLandingIds: [];
    }
  | ProvisionalConflictNormalizationSubjectBase & {
      role: 'holding_provisional';
      rawClaimLandingIds: string[];
      independentClaimKey: string;
      independentLineageKey: string;
      independentStableKey: string;
    };

interface ProvisionalConflictNormalizationSubjectBase {
  subjectId: string;
  conflictId: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  targetIdentityHash: string | null;
  claimIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
  claimSnapshotDigest: string;
  sourceRawFindingIds: string[];
  sourceRawPayloadDigests: string[];
  evidenceBindingIds: string[];
  evidenceSetDigest: string;
}

export interface ProvisionalConflictNormalizationConflictRef {
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  legacyConflictSnapshotId: string;
  findingIds: string[];
  rawFindingIds: string[];
  rawClaimLandingIds: string[];
  provisionalTargetSubjectIds: string[];
  holdingSubjectIds: string[];
  claimUniverseDigest: string;
}

export interface ProvisionalConflictAssociationCandidate {
  associationId: string;
  sourceHoldingSubjectId: string;
  targetSubjectId: string;
  targetSubjectRole: 'provisional_target' | 'holding_provisional';
  basis: 'conflict_target' | 'independent_key_collision';
}

export interface ProvisionalConflictProofUniverseWitness {
  trustedVerifierId: 'takt.finding-lifecycle-policy';
  trustedVerifierVersion: '1';
  candidateAssociations: ProvisionalConflictAssociationCandidate[];
  mechanicalExactAssociationIds: string[];
  trustedProofRecordIds: string[];
  provenAssociationIds: string[];
  proofUniverseDigest: string;
}

export interface ProvisionalConflictNormalizationSnapshot {
  normalizationSnapshotId: string;
  sourceProjectionDigest: string;
  workflowName: string;
  conflicts: ProvisionalConflictNormalizationConflictRef[];
  subjects: ProvisionalConflictNormalizationSubject[];
  proofUniverse: ProvisionalConflictProofUniverseWitness;
  capturedAt: FindingObservation;
}

export interface ProvisionalConflictReleaseWitness {
  releaseWitnessId: string;
  normalizationSnapshotId: string;
  holdingSubjectId: string;
  candidateAssociationIds: string[];
  proofUniverseDigest: string;
  provenAssociationIds: [];
}

export type ProvisionalConflictNormalizationFinalFindingIntent =
  | {
      kind: 'open_provisional';
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      sourceSubjectIds: string[];
      afterRevision: number;
      afterLifecycle: 'persists';
      stableKey: string;
      lineageKey: string;
      rawFindingIds: string[];
      provisionalSourceRawFindingIds: string[];
      reviewerIds: string[];
      evidenceIds: string[];
      absorbedFindingIds: string[];
      intentDigest: string;
    }
  | {
      kind: 'superseded';
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      sourceSubjectIds: string[];
      afterRevision: number;
      afterLifecycle: 'superseded';
      supersededByFindingId: string;
      provisionalAfter: null;
      intentDigest: string;
    };

export interface ProvisionalConflictNormalizationFinalFindingProjection {
  findingId: string;
  intentDigest: string;
  expectedHead: FindingLifecycleEntityHead;
  after: FindingLedgerEntry;
  projectionDigest: string;
}

export type ProvisionalConflictNormalizationDecision =
  | {
      conflictId: string;
      subjectId: string;
      subjectRole: 'provisional_target';
      findingId: string;
      outcome: 'retained_provisional';
      finalIntentDigest: string;
    }
  | {
      conflictId: string;
      subjectId: string;
      subjectRole: 'holding_provisional';
      findingId: string;
      outcome: 'bundled_into_provisional';
      targetSubjectId: string;
      targetFindingId: string;
      associationId: string;
      proofRecordIds: string[];
      sourceFinalIntentDigest: string;
      targetFinalIntentDigest: string;
    }
  | {
      conflictId: string;
      subjectId: string;
      subjectRole: 'holding_provisional';
      findingId: string;
      outcome: 'released_independent';
      independentClaimKey: string;
      independentLineageKey: string;
      independentStableKey: string;
      releaseWitnessId: string;
      proofRecordIds: [];
      finalIntentDigest: string;
    };

export interface ProvisionalConflictNormalizationRecord {
  normalizationId: string;
  normalizationSnapshotId: string;
  batchFingerprintDigest: string;
  decisionDigest: string;
  decisions: ProvisionalConflictNormalizationDecision[];
  releaseWitnesses: ProvisionalConflictReleaseWitness[];
  finalFindingProjections: ProvisionalConflictNormalizationFinalFindingProjection[];
  recordedAt: FindingObservation;
}

interface ProvisionalConflictNormalizationSettlementBase {
  settlementId: string;
  normalizationId: string;
  normalizationSnapshotId: string;
  conflictId: string;
  subjectId: string;
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  rawClaimLandingIds: string[];
  lifecycleEventIds: [string];
  recordedAt: FindingObservation;
}

export type ProvisionalConflictNormalizationSettlement =
  | ProvisionalConflictNormalizationSettlementBase & {
      subjectRole: 'provisional_target';
      outcome: 'retained_provisional';
      rawClaimLandingIds: [];
    }
  | ProvisionalConflictNormalizationSettlementBase & {
      subjectRole: 'holding_provisional';
      outcome: 'bundled_into_provisional';
      targetFindingId: string;
      proofRecordIds: string[];
    }
  | ProvisionalConflictNormalizationSettlementBase & {
      subjectRole: 'holding_provisional';
      outcome: 'released_independent';
      releaseWitnessId: string;
      independentStableKey: string;
      proofRecordIds: [];
    };

export interface VerifiedLegacyProvisionalIdentity {
  findingId: string;
  role: 'provisional_target' | 'holding_provisional';
  targetIdentityHash: string;
  claimIdentityHash: string;
  semanticClaimIdentityHash: string;
  claimSnapshotDigest: string;
  rawFindingIds: string[];
  rawCanonicalSnapshotIds: string[];
}

export interface LegacyHoldingConflictOwner {
  holdingFindingId: string;
  conflictId: string;
  rawClaimLandingIds: string[];
}

export interface LegacyProvisionalConflictBatchFingerprint {
  conflictIds: string[];
  provisionalTargetFindingIds: string[];
  holdingFindingIds: string[];
  holdingOwners: LegacyHoldingConflictOwner[];
  verifiedIdentities: VerifiedLegacyProvisionalIdentity[];
  finalFindingIntents: ProvisionalConflictNormalizationFinalFindingIntent[];
  fingerprintDigest: string;
}

export type TerminalVerificationFailureCode =
  | 'episode_not_found'
  | 'candidate_not_found'
  | 'head_not_fresh'
  | 'source_claim_coverage_mismatch'
  | 'target_not_found'
  | 'authority_not_found'
  | 'authority_kind_mismatch'
  | 'authority_binding_mismatch'
  | 'positive_evidence_not_current'
  | 'scope_binding_not_found';

declare const verifiedTerminalAdjudicationAuthorityBrand: unique symbol;

export type VerifiedTerminalAdjudicationAuthority =
  | {
      readonly [verifiedTerminalAdjudicationAuthorityBrand]: true;
      readonly kind: 'promote_independent';
      readonly episodeId: string;
      readonly findingId: string;
      readonly expectedHead: FindingLifecycleEntityHead;
      readonly sourceClaimRefIds: string[];
      readonly productProjection: ProductFindingProjection;
      readonly productProjectionDigest: string;
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    }
  | {
      readonly [verifiedTerminalAdjudicationAuthorityBrand]: true;
      readonly kind: 'merge_existing';
      readonly episodeId: string;
      readonly findingId: string;
      readonly expectedHead: FindingLifecycleEntityHead;
      readonly sourceClaimRefIds: string[];
      readonly targetRefId: string;
      readonly targetFindingId: string;
      readonly targetExpectedHead: FindingLifecycleEntityHead;
      readonly exactClaimIdentityDigest: string;
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    }
  | {
      readonly [verifiedTerminalAdjudicationAuthorityBrand]: true;
      readonly kind: 'dismiss';
      readonly episodeId: string;
      readonly findingId: string;
      readonly expectedHead: FindingLifecycleEntityHead;
      readonly sourceClaimRefIds: string[];
      readonly basis:
        | 'outside_contract_jurisdiction'
        | 'outside_task_scope'
        | 'false_positive'
        | 'overreach'
        | 'no_issue_after_verification';
      readonly scopeBindingIds: string[];
      readonly taskQuote?: string;
      readonly workflowTaskDigest?: string;
      readonly adjudicationTaskId?: string;
      readonly proposalDigest: string;
      readonly proofRecordIds: string[];
      readonly verificationDigest: string;
    };

export type ResolvedTerminalAdjudicationPlan =
  | { kind: 'undetermined'; reasonCodes: TerminalVerificationFailureCode[] }
  | { kind: 'promote_independent'; authority: Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'promote_independent' }> }
  | { kind: 'merge_existing'; authority: Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'merge_existing' }> }
  | { kind: 'dismiss'; authority: Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'dismiss' }> };

export interface InterpretationUnreservedLandingAuthority {
  kind: 'interpretation_unreserved_landing';
  roundIdentity: string;
  budgetScopeId: string;
  reason:
    | 'manager-budget-exhausted'
    | 'manager-input-overflow'
    | 'manager-output-discarded'
    | 'interpretation-interrupted';
  rawFindingIds: string[];
  rawCanonicalSnapshotIds: string[];
}

export interface FindingContractLedgerRegistries {
  rawCanonicalSnapshots: RawCanonicalSnapshot[];
  conflictRawClaimLandings: ConflictRawClaimLanding[];
  conflictAdjudicationSnapshots: ConflictAdjudicationSnapshot[];
  conflictAdjudicationEpisodes: ConflictAdjudicationEpisode[];
  conflictAdjudicationAttempts: ConflictAdjudicationAttempt[];
  conflictClaimSettlements: ConflictClaimSettlement[];
  provisionalConflictNormalizationSnapshots: ProvisionalConflictNormalizationSnapshot[];
  provisionalConflictNormalizations: ProvisionalConflictNormalizationRecord[];
  interpretationCaseSnapshots: InterpretationCaseSnapshot[];
  interpretationRawObservations: InterpretationRawObservation[];
  interpretationRecoveryOriginBindings: InterpretationRecoveryOriginBinding[];
  interpretationRecoveryOriginSettlements: InterpretationRecoveryOriginSettlement[];
  interpretationAttempts: InterpretationAttempt[];
  rawInterpretationOutcomes: RawInterpretationOutcome[];
  findingManagerProviderBudgetScopes: FindingManagerProviderBudgetScope[];
  findingManagerProviderCalls: FindingManagerProviderCall[];
  findingScopeBindings: FindingScopeBinding[];
  terminalAdjudicationRounds: TerminalAdjudicationRound[];
  terminalAdjudicationEpisodes: TerminalAdjudicationEpisode[];
  terminalAdjudicationAttempts: TerminalAdjudicationAttempt[];
  terminalAdjudicationSettlements: TerminalAdjudicationSettlement[];
}
