import type { ProvisionalFindingSpec } from './reconciler.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { captureFindingPreconditions } from './finding-preconditions.js';
import type {
  FindingLedgerMutation,
  ProvisionalLandingReport,
  ReviewerAnomalyLandingReport,
} from './store.js';
import type {
  FindingLedger,
  FindingObservation,
} from './types.js';
import { evaluateRawAdmission, type RawAdmissionEvaluation, type ReviewerIntakeResult } from './manager-admission.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';

import { mergeOutputs, revalidateManagerPlan } from './manager-commit-revalidation.js';
import { buildLadderCommitPlan } from './manager-ladder-commit-plan.js';
import { applyCommitLedgerStates, reconcileCommitPlan } from './manager-commit-finalization.js';
export interface CommitMutationResult {
  staleRejections: string[];
  admissionRejections: RawAdmissionEvaluation['admissionRejections'];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
}

export interface FindingManagerCommitPlanInput {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
}

function prepareCommitReconciliation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
) {
  const admission = evaluateRawAdmission({
    cwd: params.input.cwd,
    previousLedger: freshLedger,
    intake: params.intake,
  });
  const freshAdmittedItems = [...admission.cleanAdmitted, ...admission.taintedAdmitted];
  const freshAdmittedRawIds = new Set(freshAdmittedItems.map((item) => item.wire.rawFindingId));
  const locationlessProvisionalRawIds = new Set(
    admission.locationlessProvisionalItems.map(({ item }) => item.wire.rawFindingId),
  );
  const reconcileRawFindings = [
    ...admission.cleanWire,
    ...admission.locationlessProvisionalItems.map(({ item }) => item.wire),
    ...admission.admissionRejectedItems.map((item) => item.wire),
    ...admission.tainted
      .filter((item) => !locationlessProvisionalRawIds.has(item.wire.rawFindingId))
      .map((item) => item.wire),
    ...params.intake.items
      .filter((item) => params.intake.overflowRawFindingIds.has(item.canonical.rawFindingId))
      .map((item) => item.wire),
  ];
  const rawProvenanceByRawFindingId = new Map(
    params.intake.items.map((item) => [item.canonical.rawFindingId, {
      reviewerStableKey: item.canonical.reviewerStableKey,
      lineageKey: item.canonical.lineageKey,
    }]),
  );
  const baseSpecs: ProvisionalFindingSpec[] = [
    ...params.intake.overflowSpecs,
    ...admission.locationlessProvisionalItems.map(({ item, reason }) => provisionalSpecForRawKind(
      { wire: item.wire, canonical: item.canonical, reason },
      'unverified-locationless',
    )),
    ...params.managerDecision.cleanProvisionalSpecs.filter((spec) => (
      spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
    ...params.managerDecision.ladder.provisionalSpecs.filter((spec) => (
      spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
  ];
  return {
    admission,
    reconcileRawFindings,
    rawProvenanceByRawFindingId,
    baseSpecs,
    cleanWireById: new Map(
      admission.cleanAdmitted.map((item) => [item.wire.rawFindingId, item.wire]),
    ),
    cleanCanonicalById: new Map(
      admission.cleanAdmitted.map((item) => [item.canonical.rawFindingId, item.canonical]),
    ),
    capturedPreconditions: captureFindingPreconditions(params.previousLedger),
    anomalySpecs: [...admission.admissionAnomalySpecs, ...admission.ladderAnomalySpecs],
  };
}

export function buildFindingManagerCommitMutation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
): FindingLedgerMutation<CommitMutationResult> {
  const prepared = prepareCommitReconciliation(params, freshLedger);
  const { input, managerDecision } = params;
  const { managerOutput, ladder } = managerDecision;
  const { admission } = prepared;

  const revalidated = revalidateManagerPlan({
    managerOutput,
    freshLedger,
    cleanWire: admission.cleanWire,
    cleanWireById: prepared.cleanWireById,
    cleanCanonicalById: prepared.cleanCanonicalById,
    capturedPreconditions: prepared.capturedPreconditions,
    runInput: input,
  });
  const staleRejections = revalidated.staleRejections;
  const output = revalidated.output;

  const ladderCommit = buildLadderCommitPlan(ladder, freshLedger);
  const specs = [
    ...prepared.baseSpecs,
    ...revalidated.provisionalSpecs,
    ...ladderCommit.provisionalSpecs,
  ];
  const interpretationResults = ladderCommit.interpretationResults;
  const merged = mergeOutputs(output, ladderCommit.output);
  const reconcilePlan = reconcileCommitPlan({
    runInput: input,
    freshLedger,
    rawFindings: prepared.reconcileRawFindings,
    managerOutput: merged,
    provisionalSpecs: specs,
    anomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    rawProvenanceByRawFindingId: prepared.rawProvenanceByRawFindingId,
    cleanWire: admission.cleanWire,
  });
  const settled = reconcilePlan.ledger;
  // 監査レポートには実際に着地した spec だけを載せる（dismiss と同一ラウンドで
  // 抑止された同一 claim の spec は着地していない — reconcileCommitPlan 参照）。
  const provisionalLandings = reconcilePlan.landedSpecs.map((spec): ProvisionalLandingReport => ({
    kind: spec.kind,
    stableKey: spec.stableKey,
    reason: spec.reason,
    sourceRawFindingIds: spec.sourceRawFindingIds,
  }));

  const finalized = applyCommitLedgerStates({
    runInput: input,
    freshLedger,
    settledLedger: settled,
    baseAnomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    interpretationResults,
    observation: params.observation,
    verifiedEvidenceCandidates: admission.verifiedEvidenceCandidates,
    stopBudgetLimits: params.stopBudgetLimits,
    stopBudgetRoundMarker: params.stopBudgetRoundMarker,
    reviewIntegrityLimits: params.reviewIntegrityLimits,
  });
  return {
    ledger: finalized.ledger,
    result: {
      staleRejections,
      admissionRejections: admission.admissionRejections,
      provisionalLandings,
      reviewerAnomalyLandings: finalized.reviewerAnomalyLandings,
    },
  };
}
