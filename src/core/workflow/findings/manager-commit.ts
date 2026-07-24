import type { RawAdmissionEvaluation, ReviewerIntakeResult } from './manager-admission.js';
import {
  buildFindingManagerCommitMutation,
  type CommitMutationResult,
  type FindingManagerCommitPlanInput,
} from './manager-commit-plan.js';
import type {
  ManagerDecisionStageResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { buildManagerCommitReport } from './manager-report.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import type { ProvisionalLandingReport, RawAdmissionRejectionReport, ReviewerAnomalyLandingReport } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type {
  InterpretationRecoveryOriginSettlement,
  RawFindingDisposition,
} from './types.js';
import type { InterpretationRecoveryFailure } from './interpretation-recovery.js';
import { releaseRawAdjudicationReservations } from './raw-adjudication-reservation.js';
import { releaseInterpretationReservations } from './interpretation-wal.js';
import {
  finalizePendingManagerCommit,
  rebindPendingManagerCommit,
  stagePendingManagerCommit,
} from './manager-pending-commit.js';

export interface CommitFindingManagerRoundResult {
  applied: boolean;
  nextLedger: FindingLedger;
  staleRejectionCount: number;
  provisionalLandingCount: number;
  reviewerAnomalyLandingCount: number;
}

interface FindingManagerCommitResult {
  applied: boolean;
  nextLedger: FindingLedger;
  staleRejections: string[];
  admissionRejections: RawAdmissionRejectionReport[];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rawFindingDispositions: RawFindingDisposition[];
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
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
  reviewScopeSnapshotId: string;
}): Promise<CommitFindingManagerRoundResult> {
  try {
    const mutation = await params.input.ledgerStore.updateLedger((freshLedger) => {
      const commitMutation = buildFindingManagerCommitMutation(params, freshLedger);
      if (!commitMutation.result.applied) {
        return commitMutation;
      }
      const report = buildCommitReport(params, commitMutation.result);
      if (report === undefined) {
        return commitMutation;
      }
      const publication = params.input.ledgerStore.planManagerValidationPublication(
        params.stopBudgetRoundMarker,
        report,
      );
      return {
        ...commitMutation,
        ledger: stagePendingManagerCommit({
          completedLedger: commitMutation.ledger,
          previousLedger: freshLedger,
          roundMarker: params.stopBudgetRoundMarker,
          publication,
        }),
      };
    });
    const committed: FindingManagerCommitResult = {
      applied: mutation.result.applied,
      nextLedger: mutation.ledger,
      staleRejections: mutation.result.staleRejections,
      admissionRejections: mutation.result.admissionRejections,
      provisionalLandings: mutation.result.provisionalLandings,
      reviewerAnomalyLandings: mutation.result.reviewerAnomalyLandings,
      rawFindingDispositions: mutation.result.rawFindingDispositions,
      interpretationRecoverySettlements: mutation.result.interpretationRecoverySettlements,
    };
    if (committed.applied && mutation.ledger.pendingManagerCommit !== undefined) {
      const resumed = await resumePendingManagerCommit(params.input, mutation.ledger);
      if (resumed === undefined) {
        throw new Error('Staged manager publication disappeared before publication');
      }
      committed.nextLedger = resumed.ledger;
    }
    return {
      applied: committed.applied,
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

function buildCommitReport(
  params: FindingManagerCommitPlanInput,
  committed: CommitMutationResult,
) {
  const { input, intake, managerDecision } = params;
  return buildManagerCommitReport({
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
    rawFindingDispositions: committed.rawFindingDispositions,
    interpretationRecoverySettlements: committed.interpretationRecoverySettlements,
  });
}

export async function resumePendingManagerCommit(
  input: RunFindingManagerForStepInput,
  ledger: FindingLedger,
): Promise<{ ledger: FindingLedger; completedRoundMarker: string } | undefined> {
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined) {
    return undefined;
  }
  const boundPublication = input.ledgerStore.bindManagerValidationPublication(
    pending.roundMarker,
    pending.publication,
  );
  let boundLedger = ledger;
  if (boundPublication.destinationRunId !== pending.publication.destinationRunId) {
    const rebound = await input.ledgerStore.updateLedger((current) => ({
      ledger: rebindPendingManagerCommit(
        current,
        pending.publication.publicationId,
        boundPublication,
      ),
      result: undefined,
    }));
    boundLedger = rebound.ledger;
  }
  const boundPending = boundLedger.pendingManagerCommit;
  if (boundPending === undefined) {
    throw new Error(
      `Pending manager publication "${pending.publication.publicationId}" disappeared during destination binding`,
    );
  }
  const receipt = input.ledgerStore.publishManagerValidationPublication(
    boundPending.publication,
  );
  const finalized = await input.ledgerStore.updateLedger(
    (current) => ({
      ledger: finalizePendingManagerCommit(
        current,
        boundPending.publication.publicationId,
      ),
      result: undefined,
    }),
    (_current, mutation) => {
      input.ledgerStore.assertManagerValidationPublication(
        boundPending.publication,
        receipt,
      );
      return {
        mutation,
        publish: true,
      };
    },
  );
  return {
    ledger: finalized.ledger,
    completedRoundMarker: pending.roundMarker,
  };
}

export async function rebindPendingManagerPublicationAtBootstrap(
  store: RunFindingManagerForStepInput['ledgerStore'],
): Promise<void> {
  const ledger = store.loadLedger();
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined) {
    return;
  }
  const boundPublication = store.bindManagerValidationPublication(
    pending.roundMarker,
    pending.publication,
  );
  if (boundPublication.destinationRunId === pending.publication.destinationRunId) {
    return;
  }
  await store.updateLedger((current) => ({
    ledger: rebindPendingManagerCommit(
      current,
      pending.publication.publicationId,
      boundPublication,
    ),
    result: undefined,
  }));
}
