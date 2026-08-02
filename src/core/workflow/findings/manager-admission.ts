import type { RawNormalizationAuditRecord, RawAdmissionRejectionReport, ReviewerOutputOverflowReport } from './store.js';
import type {
  CanonicalRawFinding,
  FindingLedger,
  FindingEvidenceRecord,
  RawFinding,
  RawFindingEvidence,
  ReviewerAnomalyKind,
} from './types.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import {
  createReviewerAnomalySpec,
  type ReviewerAnomalyPromotionCandidate,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import {
  createEngineProofVerifierRegistry,
  createLedgerEngineProofRegistry,
} from './evidence-domain.js';
import { formatFileQuoteLocation } from './evidence-location.js';
import { verifyFindingEvidenceSet } from './evidence-verification.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import {
  createSnapshotEngineProofVerifiers,
} from './evidence-request-issuer.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import { hasLifecycleTransitionIntent } from './raw-relation-capabilities.js';
import type {
  PreAdmissionEntityBinding,
  PreAdmissionEntityProvisionalMutation,
} from './pre-admission-entity-binding-types.js';
import { resolvePreAdmissionEntityBindings } from './pre-admission-entity-binding-commit.js';
import { resolveCurrentLifecycleObservationTarget } from './reviewer-anomaly-policy.js';

export type { PreAdmissionEntityBinding } from './pre-admission-entity-binding-types.js';

interface CanonicalIntakeItemBase {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
}

export type CanonicalIntakeItem = CanonicalIntakeItemBase;

export function assertCanonicalIntakeRecoveryState(
  item: CanonicalIntakeItem,
  _ledger?: FindingLedger,
): void {
  if (item.canonical.rawFindingId !== item.wire.rawFindingId) {
    throw new Error(
      `Canonical and wire raw finding identity mismatch: "${item.canonical.rawFindingId}" !== "${item.wire.rawFindingId}"`,
    );
  }
  if (
    Reflect.has(item, 'recoveryOrigins')
    || Reflect.has(item, 'interpretationRecoveryAttempt')
  ) {
    throw new Error(
      `Raw finding "${item.wire.rawFindingId}" contains transient interpretation recovery metadata`,
    );
  }
}

export function assertCanonicalIntakeRecoveryStates(
  items: readonly CanonicalIntakeItem[],
  ledger?: FindingLedger,
): void {
  for (const item of items) {
    assertCanonicalIntakeRecoveryState(item, ledger);
  }
}

export interface ReviewerIntakeResult {
  items: CanonicalIntakeItem[];
  entityBindings: ReadonlyMap<string, PreAdmissionEntityBinding>;
  overflowRawFindingIds: Set<string>;
  intakeProvisionalSpecs: ProvisionalFindingSpec[];
  intakeAnomalySpecs: ReviewerAnomalySpec[];
  overflowReports: ReviewerOutputOverflowReport[];
  clarifications: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
  rawNormalizations: RawNormalizationAuditRecord[];
  healthyReviewerStableKeys: Set<string>;
}

interface PendingRejectedObservation {
  item: CanonicalIntakeItem;
  targetFindingId: string;
  reason: string;
  destination: 'target_audit' | 'reviewer_anomaly';
  anomalyKind: ReviewerAnomalyKind;
  failedEvidence?: RawFindingEvidence;
}

export interface RawAdmissionEvaluation {
  admissionRejections: RawAdmissionRejectionReport[];
  admissionAnomalySpecs: ReviewerAnomalySpec[];
  admissionProvisionalSpecs: ProvisionalFindingSpec[];
  preAdmissionEntityMutations: PreAdmissionEntityProvisionalMutation[];
  admissionRejectedItems: CanonicalIntakeItem[];
  pendingRejectedObservations: PendingRejectedObservation[];
  cleanAdmitted: CanonicalIntakeItem[];
  tainted: CanonicalIntakeItem[];
  taintedAdmitted: CanonicalIntakeItem[];
  ladderAnomalySpecs: ReviewerAnomalySpec[];
  verifiedEvidenceCandidates: ReviewerAnomalyPromotionCandidate[];
  provisionalOnlyLadderRawIds: Set<string>;
  cleanWire: RawFinding[];
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
}

type AdmissionPool = 'clean' | 'tainted';

type EvidenceClassification =
  | { admit: true; evidenceRecords: FindingEvidenceRecord[] }
  | {
      admit: false;
      disposition: 'anomaly';
      anomalyKind: ReviewerAnomalyKind;
      reason: string;
      failedEvidence?: RawFindingEvidence;
    }
  | {
      admit: false;
      disposition: 'provisional';
      reason: string;
      failedEvidence?: RawFindingEvidence;
    };

interface AdmissionItemEvaluation {
  pool: AdmissionPool;
  admitted?: CanonicalIntakeItem;
  rejection?: RawAdmissionRejectionReport;
  anomalySpec?: ReviewerAnomalySpec;
  provisionalSpec?: ProvisionalFindingSpec;
  rejectedItem?: CanonicalIntakeItem;
  pendingRejectedObservation?: PendingRejectedObservation;
  verifiedEvidenceCandidate?: ReviewerAnomalyPromotionCandidate;
  verifiedEvidenceRecords?: FindingEvidenceRecord[];
  provisionalOnlyLadderRawId?: string;
}

function classifyEvidence(input: {
  cwd: string;
  reviewScopeSnapshotId: string;
  runId: string;
  scopeIdentity: string;
  previousLedger: FindingLedger;
  item: CanonicalIntakeItem;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  workflowTask: string;
}): EvidenceClassification {
  const { cwd, reviewScopeSnapshotId, item } = input;
  if (item.canonical.provenance.ambiguityCodes.includes('invalid-evidence-shape')) {
    return {
      admit: false,
      disposition: 'anomaly',
      anomalyKind: 'protocol-anomaly',
      reason: 'Reviewer evidence does not match the typed evidence protocol',
    };
  }
  if ((item.canonical.evidenceQuoteFailureReasons?.length ?? 0) > 0) {
    return {
      admit: false,
      disposition: 'anomaly',
      anomalyKind: 'quote-mismatch',
      reason: item.canonical.evidenceQuoteFailureReasons!.join('; '),
    };
  }
  if (item.canonical.evidenceCoverageGaps.length > 0) {
    return {
      admit: false,
      disposition: 'provisional',
      reason: item.canonical.evidenceCoverageGaps.join('; '),
    };
  }
  const evidence = item.canonical.evidence;
  const proofLedger = {
    ...input.previousLedger,
    evidenceRecords: [
      ...input.previousLedger.evidenceRecords,
      ...item.canonical.issuedEngineProofRecords,
    ],
  };
  const verification = verifyFindingEvidenceSet({
    cwd,
    evidence,
    expectedSnapshotId: reviewScopeSnapshotId,
    claimIdentityHash: item.canonical.claimIdentityHash,
    targetFindingId: item.wire.targetFindingId,
    proofRegistry: createLedgerEngineProofRegistry(proofLedger),
    proofVerifiers: createEngineProofVerifierRegistry(
      createSnapshotEngineProofVerifiers({
        snapshot: input.reviewScopeSnapshot,
        workflowTask: input.workflowTask,
      }),
    ),
    proofContext: {
      cwd,
      workflowName: input.previousLedger.workflowName,
      runId: input.runId,
      scopeIdentity: input.scopeIdentity,
    },
  });
  if (verification.outcome === 'match') {
    const records = verification.records;
    const matrixSatisfied = (() => {
      if (item.canonical.target.kind === 'code') {
        return records.some((record) => (
          record.kind === 'file_quote'
          && item.canonical.target.kind === 'code'
          && item.canonical.target.paths.includes(record.path)
        ));
      }
      if (item.canonical.target.kind === 'structure') {
        return records.some((record) => (
          record.kind === 'engine_proof'
          && record.purpose === 'claim_evidence'
          && record.subject.kind === 'repository_manifest'
        ));
      }
      const hasCompleteQuery = records.some((record) => (
        record.kind === 'engine_proof'
        && record.purpose === 'claim_evidence'
        && record.subject.kind === 'repository_query'
        && record.subject.coverage === 'complete'
      ));
      const hasOriginalAnchor = records.some((record) => (
        record.kind === 'engine_proof'
        && record.purpose === 'claim_evidence'
        && record.subject.kind === 'authoritative_quote'
      ));
      return hasCompleteQuery && hasOriginalAnchor;
    })();
    if (!matrixSatisfied) {
      return {
        admit: false,
        disposition: 'provisional',
        reason: `Evidence matrix is incomplete for target kind "${item.canonical.target.kind}"`,
      };
    }
    return { admit: true, evidenceRecords: verification.records };
  }
  if (verification.outcome === 'unverifiable') {
    if ('error' in verification) {
      throw verification.error;
    }
    throw new Error(
      `Evidence for raw finding "${item.wire.rawFindingId}" could not be verified: ${verification.reason}`,
    );
  }
  const failedEvidence = verification.failureLevel === 'item'
    ? verification.failedEvidence
    : undefined;
  if (verification.outcome === 'protocol-anomaly') {
    return {
      admit: false,
      disposition: 'anomaly',
      anomalyKind: 'protocol-anomaly',
      reason: verification.reason,
      failedEvidence,
    };
  }
  if (
    verification.outcome === 'quote-mismatch'
    || verification.outcome === 'stale-snapshot'
  ) {
    return {
      admit: false,
      disposition: 'anomaly',
      anomalyKind: verification.outcome,
      reason: verification.reason,
      failedEvidence,
    };
  }
  if (verification.outcome === 'resource_exhausted') {
    return {
      admit: false,
      disposition: 'provisional',
      reason: verification.reason,
      failedEvidence,
    };
  }
  return {
    admit: false,
    disposition: 'provisional',
    reason: verification.reason,
    failedEvidence,
  };
}

function evaluateRejectedItem(input: {
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
  classification: Extract<EvidenceClassification, { admit: false }>;
  previousLedger: FindingLedger;
}): AdmissionItemEvaluation {
  const { item, pool, classification } = input;
  const rejection = {
    rawFindingId: item.wire.rawFindingId,
    location: classification.failedEvidence?.kind === 'file_quote'
      ? formatFileQuoteLocation(classification.failedEvidence)
      : '',
    reason: classification.reason,
  };
  if (
    classification.disposition === 'anomaly'
    && classification.anomalyKind === 'protocol-anomaly'
  ) {
    return {
      pool,
      rejection,
      rejectedItem: item,
      anomalySpec: createReviewerAnomalySpec({
        wire: item.wire,
        canonical: item.canonical,
        anomalyKind: classification.anomalyKind,
        failedEvidence: classification.failedEvidence,
        reason: `Evidence failed deterministic admission (${classification.reason}); the malformed protocol record is isolated as a reviewer anomaly`,
      }),
    };
  }
  const lifecycleIntent = hasLifecycleTransitionIntent({
    relation: item.canonical.relation,
    targetFindingId: item.canonical.targetFindingId,
  });
  const auditTarget = resolveCurrentLifecycleObservationTarget(
    input.previousLedger,
    item.wire,
  );
  if (lifecycleIntent && auditTarget !== undefined) {
    return {
      pool,
      rejection,
      rejectedItem: item,
      pendingRejectedObservation: {
        item,
        targetFindingId: auditTarget.id,
        reason: `Evidence failed deterministic admission (${classification.reason}); recorded as a rejected lifecycle observation of the target`,
        destination: 'target_audit',
        anomalyKind: classification.disposition === 'anomaly'
          ? classification.anomalyKind
          : 'lifecycle-admission-failure',
        failedEvidence: classification.failedEvidence,
      },
    };
  }
  if (lifecycleIntent) {
    const anomalyKind = classification.disposition === 'anomaly'
      ? classification.anomalyKind
      : 'lifecycle-admission-failure';
    return {
      pool,
      rejection,
      rejectedItem: item,
      anomalySpec: createReviewerAnomalySpec({
        wire: item.wire,
        canonical: item.canonical,
        anomalyKind,
        failedEvidence: classification.failedEvidence,
        reason: `Evidence failed deterministic admission (${classification.reason}); the lifecycle target or engine-issued target precondition is not current`,
      }),
    };
  }
  if (classification.disposition === 'provisional') {
    return {
      pool,
      rejection,
      rejectedItem: item,
      provisionalSpec: provisionalSpecForRawKind({
        wire: item.wire,
        canonical: item.canonical,
        reason: `Engine proof failed deterministic admission (${classification.reason})`,
      }, 'raw-adjudication-unresolved'),
    };
  }

  return {
    pool,
    rejection,
    rejectedItem: item,
    anomalySpec: createReviewerAnomalySpec({
      wire: item.wire,
      canonical: item.canonical,
      anomalyKind: classification.anomalyKind,
      failedEvidence: classification.failedEvidence,
      reason: `Evidence failed deterministic admission (${classification.reason}); the observation is isolated as a reviewer anomaly because the evidence's failure does not prove the finding itself is false`,
    }),
  };
}

function evaluateAdmissionItem(input: {
  cwd: string;
  reviewScopeSnapshotId: string;
  runId: string;
  scopeIdentity: string;
  previousLedger: FindingLedger;
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  workflowTask: string;
  entityBindings: ReviewerIntakeResult['entityBindings'];
}): AdmissionItemEvaluation {
  const binding = input.entityBindings.get(input.item.wire.rawFindingId);
  if (binding !== undefined) {
    return evaluateEntityBindingItem({
      item: input.item,
      pool: input.pool,
      binding,
    });
  }
  const classification = classifyEvidence(input);
  const { item, pool } = input;
  if (!classification.admit) {
    return evaluateRejectedItem({ ...input, classification });
  }

  const verifiedEvidenceCandidate = classification.evidenceRecords.length > 0
    ? { lineageKey: item.canonical.lineageKey, rawFindingId: item.wire.rawFindingId }
    : undefined;
  const provisionalOnlyLadderRawId = pool === 'tainted'
    && verifiedEvidenceCandidate === undefined
    && (item.canonical.relation === 'persists' || item.canonical.relation === 'reopened')
    ? item.canonical.rawFindingId
    : undefined;
  return {
    pool,
    admitted: item,
    verifiedEvidenceCandidate,
    provisionalOnlyLadderRawId,
    verifiedEvidenceRecords: classification.evidenceRecords,
  };
}

function evaluateEntityBindingItem(input: {
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
  binding: PreAdmissionEntityBinding;
}): AdmissionItemEvaluation {
  const { item, pool, binding } = input;
  const reason = binding.kind === 'bind_existing'
    ? `Evidence-less observation was semantically associated with "${binding.targetFindingId}" by the Finding Manager; association grants audit authority only`
    : `Evidence-less observation was classified as ${binding.decision} before admission`;
  return {
    pool,
    rejection: {
      rawFindingId: item.wire.rawFindingId,
      location: '',
      reason,
    },
    rejectedItem: item,
  };
}

function definedValues<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((item): item is T => item !== undefined);
}

export function evaluateRawAdmission(input: {
  cwd: string;
  reviewScopeSnapshotId: string;
  runId: string;
  scopeIdentity: string;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  workflowTask: string;
}): RawAdmissionEvaluation {
  assertCanonicalIntakeRecoveryStates(input.intake.items, input.previousLedger);
  const resolvedEntityBindings = resolvePreAdmissionEntityBindings({
    ledger: input.previousLedger,
    intake: input.intake,
  });
  const itemByRawFindingId = new Map(
    input.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const nonOverflow = input.intake.items.filter(
    (item) => !input.intake.overflowRawFindingIds.has(item.canonical.rawFindingId),
  );
  const clean = nonOverflow.filter(
    (item) => item.canonical.coherence === 'coherent' && !item.canonical.provenance.ambiguityOrigin,
  );
  const tainted = nonOverflow.filter((item) => item.canonical.provenance.ambiguityOrigin);
  const evaluations = [
    ...clean.map((item) => evaluateAdmissionItem({
      cwd: input.cwd,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      runId: input.runId,
      scopeIdentity: input.scopeIdentity,
      previousLedger: input.previousLedger,
      item,
      pool: 'clean',
      reviewScopeSnapshot: input.reviewScopeSnapshot,
      workflowTask: input.workflowTask,
      entityBindings: input.intake.entityBindings,
    })),
    ...tainted.map((item) => evaluateAdmissionItem({
      cwd: input.cwd,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      runId: input.runId,
      scopeIdentity: input.scopeIdentity,
      previousLedger: input.previousLedger,
      item,
      pool: 'tainted',
      reviewScopeSnapshot: input.reviewScopeSnapshot,
      workflowTask: input.workflowTask,
      entityBindings: input.intake.entityBindings,
    })),
  ];
  const cleanAdmitted = definedValues(
    evaluations.map((evaluation) => evaluation.pool === 'clean' ? evaluation.admitted : undefined),
  );

  return {
    admissionRejections: definedValues(evaluations.map((evaluation) => evaluation.rejection)),
    admissionAnomalySpecs: definedValues(
      evaluations.map((evaluation) => (
        evaluation.pool === 'clean' || evaluation.anomalySpec?.kind === 'protocol-anomaly'
          ? evaluation.anomalySpec
          : undefined
      )),
    ),
    admissionProvisionalSpecs: definedValues(
      evaluations.map((evaluation) => evaluation.provisionalSpec),
    ),
    preAdmissionEntityMutations: resolvedEntityBindings.mutations,
    admissionRejectedItems: definedValues(evaluations.map((evaluation) => evaluation.rejectedItem)),
    pendingRejectedObservations: definedValues(
      evaluations.map((evaluation) => evaluation.pendingRejectedObservation),
    ).concat(resolvedEntityBindings.auditAttachments.map((attachment) => {
      const item = itemByRawFindingId.get(attachment.rawFindingId);
      if (item === undefined) {
        throw new Error(
          `Entity binding audit references missing raw finding "${attachment.rawFindingId}"`,
        );
      }
      return {
        item,
        targetFindingId: attachment.targetFindingId,
        reason: attachment.reason,
        destination: 'target_audit',
        anomalyKind: 'lifecycle-admission-failure',
      };
    })),
    cleanAdmitted,
    tainted,
    taintedAdmitted: definedValues(
      evaluations.map((evaluation) => evaluation.pool === 'tainted' ? evaluation.admitted : undefined),
    ),
    ladderAnomalySpecs: definedValues(
      evaluations.map((evaluation) => (
        evaluation.pool === 'tainted' && evaluation.anomalySpec?.kind !== 'protocol-anomaly'
          ? evaluation.anomalySpec
          : undefined
      )),
    ),
    verifiedEvidenceCandidates: definedValues(
      evaluations.map((evaluation) => evaluation.verifiedEvidenceCandidate),
    ),
    provisionalOnlyLadderRawIds: new Set(definedValues(
      evaluations.map((evaluation) => evaluation.provisionalOnlyLadderRawId),
    )),
    cleanWire: cleanAdmitted.map((item) => item.wire),
    verifiedEvidenceRecordsByRawFindingId: new Map(
      evaluations.flatMap((evaluation) => (
        evaluation.admitted === undefined || evaluation.verifiedEvidenceRecords === undefined
          ? []
          : [[
              evaluation.admitted.wire.rawFindingId,
              evaluation.verifiedEvidenceRecords,
            ] as const]
      )),
    ),
  };
}
