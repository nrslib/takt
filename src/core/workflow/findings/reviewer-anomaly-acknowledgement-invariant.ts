import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  formatWorkflowRuleCondition,
  parseWorkflowRuleCondition,
  semanticLabelsOf,
} from '../../models/workflow-rule-condition.js';
import type {
  FindingLedger,
  FindingObservation,
  ReviewerAnomalyAcknowledgement,
  ReviewerAnomalyApprovalReference,
} from './types.js';

function canonicalAcknowledgementContent(
  acknowledgement: Omit<ReviewerAnomalyAcknowledgement, 'id'>,
): object {
  return {
    domain: acknowledgement.domain,
    version: acknowledgement.version,
    anomalyStableKey: acknowledgement.anomalyStableKey,
    anomalyEvidenceHash: acknowledgement.anomalyEvidenceHash,
    reviewScopeSnapshotId: acknowledgement.reviewScopeSnapshotId,
    gate: {
      invocationId: acknowledgement.gate.invocationId,
      issuerWorkflowRef: acknowledgement.gate.issuerWorkflowRef,
      workflowName: acknowledgement.gate.workflowName,
      callStepName: acknowledgement.gate.callStepName,
      startedAt: {
        runId: acknowledgement.gate.startedAt.runId,
        stepName: acknowledgement.gate.startedAt.stepName,
        timestamp: acknowledgement.gate.startedAt.timestamp,
      },
      completedAt: {
        runId: acknowledgement.gate.completedAt.runId,
        stepName: acknowledgement.gate.completedAt.stepName,
        timestamp: acknowledgement.gate.completedAt.timestamp,
      },
    },
    approvals: acknowledgement.approvals.map((approval) => ({
      stepName: approval.stepName,
      matchedRuleIndex: approval.matchedRuleIndex,
      condition: approval.condition,
      observedAt: {
        runId: approval.observedAt.runId,
        stepName: approval.observedAt.stepName,
        timestamp: approval.observedAt.timestamp,
      },
    })),
  };
}

export function computeReviewerAnomalyAcknowledgementId(
  acknowledgement: Omit<ReviewerAnomalyAcknowledgement, 'id'>,
): string {
  // この digest は同一 UID の書き手に対する真正性証明ではなく、固定 shape の
  // 破損・部分改ざん検出である。全内容と digest を再計算できる攻撃者は非目標。
  return createHash('sha256')
    .update(JSON.stringify(canonicalAcknowledgementContent(acknowledgement)))
    .digest('hex');
}

function acknowledgementContentWithoutId(
  acknowledgement: ReviewerAnomalyAcknowledgement,
): Omit<ReviewerAnomalyAcknowledgement, 'id'> {
  return {
    domain: acknowledgement.domain,
    version: acknowledgement.version,
    anomalyStableKey: acknowledgement.anomalyStableKey,
    anomalyEvidenceHash: acknowledgement.anomalyEvidenceHash,
    reviewScopeSnapshotId: acknowledgement.reviewScopeSnapshotId,
    gate: acknowledgement.gate,
    approvals: acknowledgement.approvals,
  };
}

export function validateReviewerAnomalyGateExecution(input: {
  gate: {
    callStepName: string;
    startedAt: FindingObservation;
  };
  completedAt: FindingObservation;
  approvals: readonly [ReviewerAnomalyApprovalReference, ReviewerAnomalyApprovalReference];
}): string | undefined {
  const [firstApproval, secondApproval] = input.approvals;
  if (
    input.gate.startedAt.stepName !== input.gate.callStepName
    || firstApproval.observedAt.stepName !== firstApproval.stepName
    || secondApproval.observedAt.stepName !== secondApproval.stepName
    || input.completedAt.stepName !== secondApproval.stepName
  ) {
    return 'attested gate observations do not match the authenticated step path';
  }
  const runId = input.gate.startedAt.runId;
  if (
    input.completedAt.runId !== runId
    || input.approvals.some((approval) => approval.observedAt.runId !== runId)
  ) {
    return 'attested gate observations do not belong to the same run';
  }
  if (firstApproval.stepName === secondApproval.stepName) {
    return 'attested gate requires two distinct approval steps';
  }
  const timestamps = [
    input.gate.startedAt.timestamp,
    firstApproval.observedAt.timestamp,
    secondApproval.observedAt.timestamp,
    input.completedAt.timestamp,
  ].map((timestamp) => Date.parse(timestamp));
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
    return 'attested gate contains an invalid observation timestamp';
  }
  if (
    timestamps[0]! > timestamps[1]!
    || timestamps[1]! > timestamps[2]!
    || timestamps[2]! > timestamps[3]!
  ) {
    return 'attested gate approvals were not observed in execution order';
  }
  return undefined;
}

function assertCanonicalApprovedCondition(approval: ReviewerAnomalyApprovalReference): void {
  let parsed;
  try {
    parsed = parseWorkflowRuleCondition(approval.condition);
  } catch (error) {
    throw new Error(
      `Reviewer anomaly acknowledgement approval condition is invalid: ${approval.condition}`,
      { cause: error },
    );
  }
  if (
    formatWorkflowRuleCondition(parsed) !== approval.condition
    || !semanticLabelsOf(parsed).includes('approved')
  ) {
    throw new Error(
      `Reviewer anomaly acknowledgement approval condition is not canonical approved semantics: ${approval.condition}`,
    );
  }
}

function acknowledgementInvocationContract(acknowledgement: ReviewerAnomalyAcknowledgement): object {
  return {
    domain: acknowledgement.domain,
    version: acknowledgement.version,
    reviewScopeSnapshotId: acknowledgement.reviewScopeSnapshotId,
    gate: acknowledgement.gate,
    approvals: acknowledgement.approvals,
  };
}

export function assertReviewerAnomalyAcknowledgementLedgerInvariant(ledger: FindingLedger): void {
  const anomalyStableKeys = new Set<string>();
  for (const anomaly of ledger.reviewerAnomalies ?? []) {
    if (anomalyStableKeys.has(anomaly.stableKey)) {
      throw new Error(`Duplicate reviewer anomaly stableKey: ${anomaly.stableKey}`);
    }
    anomalyStableKeys.add(anomaly.stableKey);
  }

  const ids = new Set<string>();
  const eligibilityTuples = new Set<string>();
  const invocationContracts = new Map<string, object>();
  for (const acknowledgement of ledger.reviewerAnomalyAcknowledgements ?? []) {
    if (ids.has(acknowledgement.id)) {
      throw new Error(`Duplicate reviewer anomaly acknowledgement id: ${acknowledgement.id}`);
    }
    ids.add(acknowledgement.id);
    const content = acknowledgementContentWithoutId(acknowledgement);
    if (computeReviewerAnomalyAcknowledgementId(content) !== acknowledgement.id) {
      throw new Error(`Reviewer anomaly acknowledgement id does not match canonical content: ${acknowledgement.id}`);
    }
    if (!anomalyStableKeys.has(acknowledgement.anomalyStableKey)) {
      throw new Error(
        `Reviewer anomaly acknowledgement references missing anomaly stableKey: ${acknowledgement.anomalyStableKey}`,
      );
    }
    const eligibilityTuple = JSON.stringify([
      acknowledgement.anomalyStableKey,
      acknowledgement.anomalyEvidenceHash,
      acknowledgement.reviewScopeSnapshotId,
    ]);
    if (eligibilityTuples.has(eligibilityTuple)) {
      throw new Error('Duplicate reviewer anomaly acknowledgement eligibility tuple');
    }
    eligibilityTuples.add(eligibilityTuple);

    const invocationContract = acknowledgementInvocationContract(acknowledgement);
    const existingInvocationContract = invocationContracts.get(acknowledgement.gate.invocationId);
    if (
      existingInvocationContract !== undefined
      && !isDeepStrictEqual(existingInvocationContract, invocationContract)
    ) {
      throw new Error(
        `Reviewer anomaly acknowledgement invocation is inconsistent: ${acknowledgement.gate.invocationId}`,
      );
    }
    invocationContracts.set(acknowledgement.gate.invocationId, invocationContract);

    const executionError = validateReviewerAnomalyGateExecution({
      gate: acknowledgement.gate,
      completedAt: acknowledgement.gate.completedAt,
      approvals: acknowledgement.approvals,
    });
    if (executionError !== undefined) {
      throw new Error(`Invalid reviewer anomaly acknowledgement execution: ${executionError}`);
    }
    for (const approval of acknowledgement.approvals) {
      assertCanonicalApprovedCondition(approval);
    }
  }
}
