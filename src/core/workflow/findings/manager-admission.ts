import type { RawNormalizationAuditRecord, RawAdmissionRejectionReport, ReviewerOutputOverflowReport } from './store.js';
import type {
  CanonicalRawFinding,
  FindingLedger,
  RawFinding,
  ReviewerAnomalyKind,
} from './types.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import {
  createReviewerAnomalySpec,
  type ReviewerAnomalyPromotionCandidate,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import { computeReviewScopeSnapshotId } from './snapshot.js';
import { isLocationClaimAbsent, verifySourceQuoteEvidence } from './admission-validation.js';

export interface CanonicalIntakeItem {
  canonical: CanonicalRawFinding;
  wire: RawFinding;
  recoveryOrigin?: {
    provisionalFindingId: string;
    expectedProvisionalRevision: number;
  };
  interpretationRecoveryAttempt?: true;
}

export interface ReviewerIntakeResult {
  items: CanonicalIntakeItem[];
  overflowRawFindingIds: Set<string>;
  overflowSpecs: ProvisionalFindingSpec[];
  overflowReports: ReviewerOutputOverflowReport[];
  clarifications: Array<{ reviewer: string; flaggedRawFindingIds: string[] }>;
  rawNormalizations: RawNormalizationAuditRecord[];
  healthyReviewerStableKeys: Set<string>;
}

export interface RawAdmissionEvaluation {
  admissionRejections: RawAdmissionRejectionReport[];
  admissionAnomalySpecs: ReviewerAnomalySpec[];
  admissionRejectedItems: CanonicalIntakeItem[];
  locationlessProvisionalItems: Array<{ item: CanonicalIntakeItem; reason: string }>;
  pendingRejectedObservations: Array<{ item: CanonicalIntakeItem; targetFindingId: string; reason: string }>;
  cleanAdmitted: CanonicalIntakeItem[];
  tainted: CanonicalIntakeItem[];
  taintedAdmitted: CanonicalIntakeItem[];
  ladderAnomalySpecs: ReviewerAnomalySpec[];
  verifiedEvidenceCandidates: ReviewerAnomalyPromotionCandidate[];
  provisionalOnlyLadderRawIds: Set<string>;
  cleanWire: RawFinding[];
}

type AdmissionPool = 'clean' | 'tainted';

type LocationEvidenceClassification =
  | { admit: true }
  | { admit: false; provisionalKind: 'unverified-locationless'; reason: string }
  | { admit: false; anomalyKind: ReviewerAnomalyKind; reason: string };

interface AdmissionItemEvaluation {
  pool: AdmissionPool;
  admitted?: CanonicalIntakeItem;
  rejection?: RawAdmissionRejectionReport;
  anomalySpec?: ReviewerAnomalySpec;
  rejectedItem?: CanonicalIntakeItem;
  locationlessProvisional?: { item: CanonicalIntakeItem; reason: string };
  pendingRejectedObservation?: { item: CanonicalIntakeItem; targetFindingId: string; reason: string };
  verifiedEvidenceCandidate?: ReviewerAnomalyPromotionCandidate;
  provisionalOnlyLadderRawId?: string;
}

function classifyLocationEvidence(input: {
  cwd: string;
  reviewScopeSnapshotId: string;
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
}): LocationEvidenceClassification {
  const { cwd, reviewScopeSnapshotId, item, pool } = input;
  const evidence = item.canonical.evidence;
  const relation = item.canonical.relation;

  if (evidence?.kind === 'source_quote') {
    const verification = verifySourceQuoteEvidence(cwd, evidence, reviewScopeSnapshotId);
    if (verification.outcome === 'match') {
      return { admit: true };
    }
    if (verification.outcome === 'unverifiable') {
      if ('error' in verification) {
        throw verification.error;
      }
      throw new Error(
        `Source quote evidence for raw finding "${item.wire.rawFindingId}" could not be verified: ${verification.reason}`,
      );
    }
    return { admit: false, anomalyKind: verification.outcome, reason: verification.reason };
  }

  if (relation === 'new') {
    if (evidence?.kind === 'locationless') {
      return {
        admit: false,
        provisionalKind: 'unverified-locationless',
        reason: 'a new locationless claim has no mechanically verifiable source_quote evidence, so it is retained as a gate-blocking provisional observation rather than admitted as a confirmed product finding',
      };
    }
    const reason = isLocationClaimAbsent(item.wire.location)
      ? 'no verifiable evidence was supplied (an explicit locationless evidence declaration or a matching source_quote is required); a bare empty/N-A claim cannot become a product finding'
      : `location "${item.wire.location ?? ''}" was cited but no verifiable source_quote evidence (verbatimExcerpt) was supplied`;
    return { admit: false, anomalyKind: 'quote-mismatch', reason };
  }

  if (relation === 'persists' || relation === 'reopened') {
    if (pool === 'tainted' && isLocationClaimAbsent(item.wire.location)) {
      return { admit: true };
    }
    const detail = evidence?.kind === 'locationless'
      ? 'locationless evidence is retained only as a provisional new observation and cannot mutate an existing finding'
      : 'no verified source_quote evidence was supplied';
    return {
      admit: false,
      anomalyKind: 'quote-mismatch',
      reason: `a "${relation}" claim cannot mutate the referenced existing finding without a matching source_quote (verbatimExcerpt): ${detail}, so the claim is not applied to the finding's state`,
    };
  }

  return {
    admit: false,
    anomalyKind: 'quote-mismatch',
    reason: 'a resolution confirmation cannot close a finding without a source_quote whose verbatimExcerpt mechanically matches the current file (locationless or unverified evidence cannot serve as resolution evidence)',
  };
}

function evaluateRejectedItem(input: {
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
  classification: Extract<LocationEvidenceClassification, { admit: false; anomalyKind: ReviewerAnomalyKind }>;
  previousFindingsById: ReadonlyMap<string, FindingLedger['findings'][number]>;
}): AdmissionItemEvaluation {
  const { item, pool, classification, previousFindingsById } = input;
  const rejection = {
    rawFindingId: item.wire.rawFindingId,
    location: item.wire.location ?? '',
    reason: classification.reason,
  };
  if (item.wire.relation === 'resolution_confirmation') {
    return { pool, rejection };
  }

  const targetFindingId = item.wire.targetFindingId;
  const target = targetFindingId !== undefined ? previousFindingsById.get(targetFindingId) : undefined;
  if (item.canonical.relation === 'persists' && targetFindingId !== undefined && target?.status === 'open') {
    return {
      pool,
      rejection,
      ...(pool === 'clean' ? { rejectedItem: item } : {}),
      pendingRejectedObservation: {
        item,
        targetFindingId,
        reason: `Location evidence "${item.wire.location ?? ''}" failed deterministic admission (${classification.reason}); recorded as a rejected re-observation of the open target`,
      },
    };
  }

  return {
    pool,
    rejection,
    ...(pool === 'clean' ? { rejectedItem: item } : {}),
    anomalySpec: createReviewerAnomalySpec({
      wire: item.wire,
      canonical: item.canonical,
      anomalyKind: classification.anomalyKind,
      reason: `Location evidence "${item.wire.location ?? ''}" failed deterministic admission (${classification.reason}); the observation is isolated as a reviewer anomaly because the evidence's failure does not prove the finding itself is false`,
    }),
  };
}

function evaluateAdmissionItem(input: {
  cwd: string;
  reviewScopeSnapshotId: string;
  item: CanonicalIntakeItem;
  pool: AdmissionPool;
  previousFindingsById: ReadonlyMap<string, FindingLedger['findings'][number]>;
}): AdmissionItemEvaluation {
  const classification = classifyLocationEvidence(input);
  const { item, pool } = input;
  if (!classification.admit && 'provisionalKind' in classification) {
    return { pool, locationlessProvisional: { item, reason: classification.reason } };
  }
  if (!classification.admit) {
    return evaluateRejectedItem({ ...input, classification });
  }

  const verifiedEvidenceCandidate = item.canonical.evidence?.kind === 'source_quote'
    ? { lineageKey: item.canonical.lineageKey, rawFindingId: item.wire.rawFindingId }
    : undefined;
  const provisionalOnlyLadderRawId = pool === 'tainted'
    && verifiedEvidenceCandidate === undefined
    && (item.canonical.relation === 'persists' || item.canonical.relation === 'reopened')
    ? item.canonical.rawFindingId
    : undefined;
  return { pool, admitted: item, verifiedEvidenceCandidate, provisionalOnlyLadderRawId };
}

function definedValues<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((item): item is T => item !== undefined);
}

export function evaluateRawAdmission(input: {
  cwd: string;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
}): RawAdmissionEvaluation {
  const nonOverflow = input.intake.items.filter(
    (item) => !input.intake.overflowRawFindingIds.has(item.canonical.rawFindingId),
  );
  const clean = nonOverflow.filter(
    (item) => item.canonical.coherence === 'coherent' && !item.canonical.provenance.ambiguityOrigin,
  );
  const tainted = nonOverflow.filter((item) => item.canonical.provenance.ambiguityOrigin);
  const previousFindingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const reviewScopeSnapshotId = computeReviewScopeSnapshotId(input.cwd);
  const evaluations = [
    ...clean.map((item) => evaluateAdmissionItem({
      cwd: input.cwd,
      reviewScopeSnapshotId,
      item,
      pool: 'clean',
      previousFindingsById,
    })),
    ...tainted.map((item) => evaluateAdmissionItem({
      cwd: input.cwd,
      reviewScopeSnapshotId,
      item,
      pool: 'tainted',
      previousFindingsById,
    })),
  ];
  const cleanAdmitted = definedValues(
    evaluations.map((evaluation) => evaluation.pool === 'clean' ? evaluation.admitted : undefined),
  );

  return {
    admissionRejections: definedValues(evaluations.map((evaluation) => evaluation.rejection)),
    admissionAnomalySpecs: definedValues(
      evaluations.map((evaluation) => evaluation.pool === 'clean' ? evaluation.anomalySpec : undefined),
    ),
    admissionRejectedItems: definedValues(evaluations.map((evaluation) => evaluation.rejectedItem)),
    locationlessProvisionalItems: definedValues(
      evaluations.map((evaluation) => evaluation.locationlessProvisional),
    ),
    pendingRejectedObservations: definedValues(
      evaluations.map((evaluation) => evaluation.pendingRejectedObservation),
    ),
    cleanAdmitted,
    tainted,
    taintedAdmitted: definedValues(
      evaluations.map((evaluation) => evaluation.pool === 'tainted' ? evaluation.admitted : undefined),
    ),
    ladderAnomalySpecs: definedValues(
      evaluations.map((evaluation) => evaluation.pool === 'tainted' ? evaluation.anomalySpec : undefined),
    ),
    verifiedEvidenceCandidates: definedValues(
      evaluations.map((evaluation) => evaluation.verifiedEvidenceCandidate),
    ),
    provisionalOnlyLadderRawIds: new Set(definedValues(
      evaluations.map((evaluation) => evaluation.provisionalOnlyLadderRawId),
    )),
    cleanWire: cleanAdmitted.map((item) => item.wire),
  };
}
