import { reconcileFindingLedger, type ProvisionalFindingSpec } from './reconciler.js';
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
  linkPromotedReviewerAnomalies,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import { attachFixpointState } from './fixpoint.js';
import { attachStopBudgetState, resolveStopBudgetLimits } from './stop-budget.js';
import { attachReviewIntegrityState, resolveReviewIntegrityLimits } from './review-integrity.js';
import { markInterpretationsApplied } from './interpretation-wal.js';
import type { ReviewerAnomalyLandingReport } from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  InterpretationApplicationResult,
  RawFinding,
} from './types.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import {
  applyProvisionalSettlement,
  applyRejectedObservationAttachments,
  settleProvisionalsWithCleanEvidence,
} from './manager-provisional-settlement.js';

interface RejectedObservationPlan {
  attachments: Array<{ targetFindingId: string; rawFindingId: string; reason: string }>;
  anomalySpecs: ReviewerAnomalySpec[];
}

function classifyRejectedObservations(
  pendingObservations: RawAdmissionEvaluation['pendingRejectedObservations'],
  ledger: FindingLedger,
): RejectedObservationPlan {
  return pendingObservations.reduce<RejectedObservationPlan>((plan, pending) => {
    const target = ledger.findings.find((finding) => finding.id === pending.targetFindingId);
    if (target !== undefined && target.status === 'open') {
      return {
        ...plan,
        attachments: [...plan.attachments, {
          targetFindingId: pending.targetFindingId,
          rawFindingId: pending.item.wire.rawFindingId,
          reason: pending.reason,
        }],
      };
    }
    return {
      ...plan,
      anomalySpecs: [...plan.anomalySpecs, createReviewerAnomalySpec({
        wire: pending.item.wire,
        canonical: pending.item.canonical,
        anomalyKind: 'quote-mismatch',
        reason: `${pending.reason}; the target is no longer open after this round, so the observation is isolated as a reviewer anomaly instead`,
      })],
    };
  }, { attachments: [], anomalySpecs: [] });
}

export function reconcileCommitPlan(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  anomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  rawProvenanceByRawFindingId: Map<string, { reviewerStableKey: string; lineageKey: string }>;
  cleanWire: RawFinding[];
}): FindingLedger {
  const settlement = settleProvisionalsWithCleanEvidence({
    output: input.managerOutput,
    cleanRawIds: new Set(input.cleanWire.map((wire) => wire.rawFindingId)),
    wireById: new Map(input.rawFindings.map((wire) => [wire.rawFindingId, wire])),
    freshLedger: input.freshLedger,
  });
  const reconciled = reconcileFindingLedger({
    priorStepResponseText: input.runInput.priorStepResponseText,
    previousLedger: input.freshLedger,
    rawFindings: input.rawFindings,
    managerOutput: settlement.output,
    provisionalFindings: input.provisionalSpecs,
    rawProvenanceByRawFindingId: input.rawProvenanceByRawFindingId,
    excludedFromUnmentionedFallbackRawFindingIds: new Set([
      ...input.pendingRejectedObservations.map((pending) => pending.item.wire.rawFindingId),
      ...input.anomalySpecs.flatMap((spec) => spec.sourceRawFindingIds),
    ]),
    context: {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  });
  return applyProvisionalSettlement(reconciled, settlement, input.runInput.timestamp);
}

export function applyCommitLedgerStates(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  settledLedger: FindingLedger;
  baseAnomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  interpretationResults: Map<string, InterpretationApplicationResult>;
  observation: FindingObservation;
  verifiedEvidenceCandidates: RawAdmissionEvaluation['verifiedEvidenceCandidates'];
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
}): { ledger: FindingLedger; reviewerAnomalyLandings: ReviewerAnomalyLandingReport[] } {
  const rejectedObservations = classifyRejectedObservations(
    input.pendingRejectedObservations,
    input.settledLedger,
  );
  const anomalySpecs = [...input.baseAnomalySpecs, ...rejectedObservations.anomalySpecs];
  const withAnomalies = applyReviewerAnomalySpecsToLedger(
    input.settledLedger,
    anomalySpecs,
    {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  );
  const withRejectedObservations = applyRejectedObservationAttachments(
    withAnomalies,
    rejectedObservations.attachments,
    input.observation,
  );
  const applied = markInterpretationsApplied(
    withRejectedObservations,
    input.interpretationResults,
    input.observation,
  );
  const withPromotions = linkPromotedReviewerAnomalies(applied, input.verifiedEvidenceCandidates);
  const withFixpoint = attachFixpointState(input.freshLedger, withPromotions, input.runInput.cwd);
  const withStopBudget = attachStopBudgetState(
    input.freshLedger,
    withFixpoint,
    input.stopBudgetLimits,
    input.stopBudgetRoundMarker,
    input.runInput.timestamp,
  );
  return {
    ledger: attachReviewIntegrityState(
      input.freshLedger,
      withStopBudget,
      input.reviewIntegrityLimits,
      input.stopBudgetRoundMarker,
      input.runInput.timestamp,
    ),
    reviewerAnomalyLandings: anomalySpecs.map((spec) => ({
      kind: spec.kind,
      stableKey: spec.stableKey,
      reason: spec.mismatchReason,
      sourceRawFindingIds: spec.sourceRawFindingIds,
    })),
  };
}
