import type { RawAdmissionEvaluation, ReviewerIntakeResult } from './manager-admission.js';
import {
  buildFindingManagerCommitMutation,
  type FindingManagerCommitPlanInput,
} from './manager-commit-plan.js';
import type {
  ManagerDecisionStageResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { saveManagerCommitReport } from './manager-report.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import type { ProvisionalLandingReport, RawAdmissionRejectionReport, ReviewerAnomalyLandingReport } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type { InterpretationRecoveryFailure } from './interpretation-recovery.js';
import { releaseRawAdjudicationReservations } from './raw-adjudication-reservation.js';
import { releaseInterpretationReservations } from './interpretation-wal.js';

export interface CommitFindingManagerRoundResult {
  nextLedger: FindingLedger;
  staleRejectionCount: number;
  provisionalLandingCount: number;
  reviewerAnomalyLandingCount: number;
}

interface FindingManagerCommitResult {
  nextLedger: FindingLedger;
  staleRejections: string[];
  admissionRejections: RawAdmissionRejectionReport[];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
}

export async function commitFindingManagerRound(params: {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  interpretationRecoveryFailures: InterpretationRecoveryFailure[];
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
}): Promise<CommitFindingManagerRoundResult> {
  try {
    const mutation = await params.input.ledgerStore.updateLedger((freshLedger) => (
      buildFindingManagerCommitMutation(params, freshLedger)
    ));
    const committed: FindingManagerCommitResult = {
      nextLedger: mutation.ledger,
      staleRejections: mutation.result.staleRejections,
      admissionRejections: mutation.result.admissionRejections,
      provisionalLandings: mutation.result.provisionalLandings,
      reviewerAnomalyLandings: mutation.result.reviewerAnomalyLandings,
    };
    saveCommitReport(params, committed);
    return {
      nextLedger: committed.nextLedger,
      staleRejectionCount: committed.staleRejections.length,
      provisionalLandingCount: committed.provisionalLandings.length,
      reviewerAnomalyLandingCount: committed.reviewerAnomalyLandings.length,
    };
  } finally {
    releaseInterpretationReservations(
      params.input.ledgerStore,
      params.managerDecision.ladder.interpretationReservations,
    );
    releaseRawAdjudicationReservations(
      params.input.ledgerStore,
      params.managerDecision.rawRecovery.reservationTokens,
    );
  }
}

function saveCommitReport(
  params: FindingManagerCommitPlanInput,
  committed: FindingManagerCommitResult,
): void {
  const { input, intake, managerDecision } = params;
  saveManagerCommitReport({
    ledgerStore: input.ledgerStore,
    runId: input.runId,
    stepName: input.parentStep.name,
    managerOutput: managerDecision.managerOutput,
    invalidAttempts: [
      ...managerDecision.rawRecovery.invalidAttempts,
      ...managerDecision.invalidAttempts,
    ],
    staleRejections: committed.staleRejections,
    admissionRejections: committed.admissionRejections,
    unsupportedRawFindingReports: [
      ...managerDecision.rawRecovery.unsupportedRawFindingReports,
      ...managerDecision.unsupportedRawFindingReports,
    ],
    overflowReports: intake.overflowReports,
    provisionalLandings: committed.provisionalLandings,
    reviewerAnomalyLandings: committed.reviewerAnomalyLandings,
    rawNormalizations: intake.rawNormalizations,
    clarifications: intake.clarifications,
    interpretationStats: managerDecision.ladder.stats,
  });
}
