import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  FindingLedger,
  FindingObservation,
  ReviewerAnomalyAcknowledgement,
  ReviewerAnomalyApprovalReference,
  ReviewerAnomalyEntry,
} from './types.js';
import { REVIEWER_ANOMALY_ACKNOWLEDGEMENT_DOMAIN } from './types.js';
import {
  assertReviewerAnomalyAcknowledgementLedgerInvariant,
  computeReviewerAnomalyAcknowledgementId,
  validateReviewerAnomalyGateExecution,
} from './reviewer-anomaly-acknowledgement-invariant.js';

export {
  assertReviewerAnomalyAcknowledgementLedgerInvariant,
  computeReviewerAnomalyAcknowledgementId,
} from './reviewer-anomaly-acknowledgement-invariant.js';

export interface ReviewerAnomalyEvidenceReference {
  stableKey: string;
  evidenceHash: string;
}

export interface ReviewerAnomalyAcknowledgementGate {
  invocationId: string;
  issuerWorkflowRef: string;
  workflowName: string;
  callStepName: string;
  startedAt: FindingObservation;
}

export interface AppendReviewerAnomalyAcknowledgementsInput {
  evidenceReferences: readonly ReviewerAnomalyEvidenceReference[];
  reviewScopeSnapshotId: string;
  currentReviewScopeSnapshotId: string;
  gate: ReviewerAnomalyAcknowledgementGate;
  completedAt: FindingObservation;
  approvals: [ReviewerAnomalyApprovalReference, ReviewerAnomalyApprovalReference];
}

export interface AppendReviewerAnomalyAcknowledgementsResult {
  ledger: FindingLedger;
  appended: number;
  eligible: boolean;
  reason?: string;
}

export function computeReviewerAnomalyEvidenceHash(anomaly: ReviewerAnomalyEntry): string {
  // promotedFindingId は証拠ではなく昇格結果であり、outstanding 選択時に除外される。
  return createHash('sha256').update(JSON.stringify({
    id: anomaly.id,
    kind: anomaly.kind,
    stableKey: anomaly.stableKey,
    lineageKey: anomaly.lineageKey,
    sourceRawFindingIds: [...anomaly.sourceRawFindingIds].sort(),
    reviewers: [...anomaly.reviewers].sort(),
    title: anomaly.title,
    claimedLocation: anomaly.claimedLocation,
    claimedExcerpt: anomaly.claimedExcerpt,
    mismatchReason: anomaly.mismatchReason,
    firstObserved: anomaly.firstObserved,
    occurrences: anomaly.occurrences,
    lastObserved: anomaly.lastObserved,
  })).digest('hex');
}

export function hasValidReviewerAnomalyAcknowledgement(
  ledger: FindingLedger,
  anomaly: ReviewerAnomalyEntry,
  reviewScopeSnapshotId: string,
): boolean {
  assertReviewerAnomalyAcknowledgementLedgerInvariant(ledger);
  return hasMatchingAcknowledgement(ledger, anomaly, reviewScopeSnapshotId);
}

function hasMatchingAcknowledgement(
  ledger: FindingLedger,
  anomaly: ReviewerAnomalyEntry,
  reviewScopeSnapshotId: string,
): boolean {
  const evidenceHash = computeReviewerAnomalyEvidenceHash(anomaly);
  return (ledger.reviewerAnomalyAcknowledgements ?? []).some((acknowledgement) => (
    acknowledgement.anomalyStableKey === anomaly.stableKey
    && acknowledgement.anomalyEvidenceHash === evidenceHash
    && acknowledgement.reviewScopeSnapshotId === reviewScopeSnapshotId
  ));
}

export function selectOutstandingReviewerAnomalies(
  ledger: FindingLedger,
  reviewScopeSnapshotId: string,
): ReviewerAnomalyEntry[] {
  assertReviewerAnomalyAcknowledgementLedgerInvariant(ledger);
  return (ledger.reviewerAnomalies ?? []).filter((anomaly) => (
    anomaly.promotedFindingId === undefined
    && !hasMatchingAcknowledgement(ledger, anomaly, reviewScopeSnapshotId)
  ));
}

export function buildOutstandingReviewerAnomalyEvidenceReferences(
  ledger: FindingLedger,
  reviewScopeSnapshotId: string,
): ReviewerAnomalyEvidenceReference[] {
  return selectOutstandingReviewerAnomalies(ledger, reviewScopeSnapshotId).map((anomaly) => ({
    stableKey: anomaly.stableKey,
    evidenceHash: computeReviewerAnomalyEvidenceHash(anomaly),
  }));
}

export function buildReviewerAnomalyEvidenceReferencesForInvocation(
  ledger: FindingLedger,
  reviewScopeSnapshotId: string,
  invocationId: string,
): ReviewerAnomalyEvidenceReference[] {
  assertReviewerAnomalyAcknowledgementLedgerInvariant(ledger);
  const replayAcknowledgements = (ledger.reviewerAnomalyAcknowledgements ?? []).filter(
    (acknowledgement) => acknowledgement.gate.invocationId === invocationId,
  );
  if (replayAcknowledgements.length === 0) {
    return buildOutstandingReviewerAnomalyEvidenceReferences(ledger, reviewScopeSnapshotId);
  }
  return replayAcknowledgements.map((acknowledgement) => ({
    stableKey: acknowledgement.anomalyStableKey,
    evidenceHash: acknowledgement.anomalyEvidenceHash,
  }));
}

function rejectAcknowledgement(
  ledger: FindingLedger,
  reason: string,
): AppendReviewerAnomalyAcknowledgementsResult {
  return { ledger, appended: 0, eligible: false, reason };
}

function haveSameEvidenceReferences(
  expected: readonly ReviewerAnomalyEvidenceReference[],
  current: readonly ReviewerAnomalyEvidenceReference[],
): boolean {
  if (expected.length !== current.length) {
    return false;
  }
  const sortReferences = (
    references: readonly ReviewerAnomalyEvidenceReference[],
  ): ReviewerAnomalyEvidenceReference[] => [...references].sort((left, right) => (
    left.stableKey.localeCompare(right.stableKey)
    || left.evidenceHash.localeCompare(right.evidenceHash)
  ));
  const sortedExpected = sortReferences(expected);
  const sortedCurrent = sortReferences(current);
  return sortedExpected.every((reference, index) => (
    reference.stableKey === sortedCurrent[index]?.stableKey
    && reference.evidenceHash === sortedCurrent[index]?.evidenceHash
  ));
}

function buildExpectedAcknowledgements(
  input: AppendReviewerAnomalyAcknowledgementsInput,
): ReviewerAnomalyAcknowledgement[] {
  return input.evidenceReferences.map((reference) => {
    const content: Omit<ReviewerAnomalyAcknowledgement, 'id'> = {
      domain: REVIEWER_ANOMALY_ACKNOWLEDGEMENT_DOMAIN,
      version: 1,
      anomalyStableKey: reference.stableKey,
      anomalyEvidenceHash: reference.evidenceHash,
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      gate: {
        ...input.gate,
        completedAt: input.completedAt,
      },
      approvals: input.approvals,
    };
    return {
      ...content,
      id: computeReviewerAnomalyAcknowledgementId(content),
    };
  });
}

function buildReplayEvidenceReferences(
  ledger: FindingLedger,
  input: AppendReviewerAnomalyAcknowledgementsInput,
): ReviewerAnomalyEvidenceReference[] {
  const acknowledgementsFromOtherInvocations = (
    ledger.reviewerAnomalyAcknowledgements ?? []
  ).filter((acknowledgement) => (
    acknowledgement.gate.invocationId !== input.gate.invocationId
  ));
  return buildOutstandingReviewerAnomalyEvidenceReferences(
    {
      ...ledger,
      reviewerAnomalyAcknowledgements: acknowledgementsFromOtherInvocations,
    },
    input.reviewScopeSnapshotId,
  );
}

function hasSameReplayExecutionPath(
  acknowledgement: ReviewerAnomalyAcknowledgement,
  input: AppendReviewerAnomalyAcknowledgementsInput,
): boolean {
  return (
    acknowledgement.reviewScopeSnapshotId === input.reviewScopeSnapshotId
    && acknowledgement.gate.invocationId === input.gate.invocationId
    && acknowledgement.gate.issuerWorkflowRef === input.gate.issuerWorkflowRef
    && acknowledgement.gate.workflowName === input.gate.workflowName
    && acknowledgement.gate.callStepName === input.gate.callStepName
    && acknowledgement.gate.startedAt.runId === input.gate.startedAt.runId
    && acknowledgement.gate.startedAt.stepName === input.gate.startedAt.stepName
    && acknowledgement.gate.completedAt.runId === input.completedAt.runId
    && acknowledgement.gate.completedAt.stepName === input.completedAt.stepName
    && acknowledgement.approvals.every((approval, index) => {
      const replayApproval = input.approvals[index];
      return (
        replayApproval !== undefined
        && approval.stepName === replayApproval.stepName
        && approval.matchedRuleIndex === replayApproval.matchedRuleIndex
        && approval.condition === replayApproval.condition
        && approval.observedAt.runId === replayApproval.observedAt.runId
        && approval.observedAt.stepName === replayApproval.observedAt.stepName
      );
    })
  );
}

export function appendReviewerAnomalyAcknowledgements(
  ledger: FindingLedger,
  input: AppendReviewerAnomalyAcknowledgementsInput,
): AppendReviewerAnomalyAcknowledgementsResult {
  assertReviewerAnomalyAcknowledgementLedgerInvariant(ledger);
  if (input.reviewScopeSnapshotId !== input.currentReviewScopeSnapshotId) {
    return rejectAcknowledgement(ledger, 'review scope snapshot changed during the attested gate');
  }
  if (ledger.findings.some((finding) => finding.status === 'open')) {
    return rejectAcknowledgement(ledger, 'open findings take priority over reviewer anomaly acknowledgement');
  }
  if (ledger.conflicts.some((conflict) => conflict.status === 'active')) {
    return rejectAcknowledgement(ledger, 'active conflicts take priority over reviewer anomaly acknowledgement');
  }
  const executionError = validateReviewerAnomalyGateExecution(input);
  if (executionError !== undefined) {
    return rejectAcknowledgement(ledger, executionError);
  }
  const currentEvidenceReferences = buildReplayEvidenceReferences(
    ledger,
    input,
  );
  if (!haveSameEvidenceReferences(input.evidenceReferences, currentEvidenceReferences)) {
    return rejectAcknowledgement(
      ledger,
      'outstanding reviewer anomalies changed during the attested gate',
    );
  }

  const existingAcknowledgements = ledger.reviewerAnomalyAcknowledgements ?? [];
  const invocationAcknowledgements = existingAcknowledgements.filter(
    (acknowledgement) => acknowledgement.gate.invocationId === input.gate.invocationId,
  );
  if (invocationAcknowledgements.length > 0) {
    const replayEvidenceReferences = invocationAcknowledgements.map((acknowledgement) => ({
      stableKey: acknowledgement.anomalyStableKey,
      evidenceHash: acknowledgement.anomalyEvidenceHash,
    }));
    if (
      !haveSameEvidenceReferences(input.evidenceReferences, replayEvidenceReferences)
      || invocationAcknowledgements.some(
        (acknowledgement) => !hasSameReplayExecutionPath(acknowledgement, input),
      )
    ) {
      return rejectAcknowledgement(
        ledger,
        'attestation invocation replay does not match the persisted acknowledgement',
      );
    }
    return { ledger, appended: 0, eligible: true };
  }

  const expectedAcknowledgements = buildExpectedAcknowledgements(input);
  for (const expected of expectedAcknowledgements) {
    const existing = existingAcknowledgements.filter(
      (acknowledgement) => acknowledgement.id === expected.id,
    );
    if (existing.length > 1) {
      return rejectAcknowledgement(ledger, 'duplicate reviewer anomaly acknowledgement id');
    }
    if (existing[0] !== undefined && !isDeepStrictEqual(existing[0], expected)) {
      return rejectAcknowledgement(
        ledger,
        'existing reviewer anomaly acknowledgement does not match the attested gate',
      );
    }
  }
  const existingIds = new Set(existingAcknowledgements.map((acknowledgement) => acknowledgement.id));
  const acknowledgements = expectedAcknowledgements.filter(
    (acknowledgement) => !existingIds.has(acknowledgement.id),
  );

  if (acknowledgements.length === 0) {
    return { ledger, appended: 0, eligible: true };
  }
  return {
    ledger: {
      ...ledger,
      updatedAt: input.completedAt.timestamp,
      reviewerAnomalyAcknowledgements: [
        ...(ledger.reviewerAnomalyAcknowledgements ?? []),
        ...acknowledgements,
      ],
    },
    appended: acknowledgements.length,
    eligible: true,
  };
}
