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
import {
  releaseInterpretationReservations,
  syncProvisionalInterpretationEpochs,
} from './interpretation-wal.js';
import { issueManagerLifecycleAuthority } from './manager-lifecycle-authority.js';
import { assembleAndApplyManagerLifecycleTransactions } from './manager-lifecycle-assembly.js';
import { completeRawRecoveryAttempts } from './raw-recovery-result.js';
import { applyRejectedObservationAttachments } from './manager-provisional-settlement.js';
import { attachFixpointState } from './fixpoint.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

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
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): Promise<CommitFindingManagerRoundResult> {
  try {
    const mutation = await params.input.ledgerStore.commitManagerLedger((freshLedger) => {
      const commitMutation = buildFindingManagerCommitMutation(params, freshLedger);
      const recoveryOrigins = new Map([...params.managerDecision.rawRecovery.origins].map(
        ([replayRawFindingId, origin]) => [origin.attemptId, replayRawFindingId],
      ));
      if (!commitMutation.result.applied) {
        return {
          ...commitMutation,
          ledger: completeRawRecoveryAttempts(
            freshLedger,
            freshLedger,
            params.managerDecision.rawRecovery.reservationTokens,
            recoveryOrigins,
            params.observation,
          ),
        };
      }
      const proofed = issueManagerLifecycleAuthority({
        current: commitMutation.result.rawRecoveryLedger,
        rawRecoveryCurrent: freshLedger,
        rawRecoveryManagerDecisionProposed:
          commitMutation.result.rawRecoveryManagerDecisionLedger,
        rawRecoveryManagerDecisionCommands:
          commitMutation.result.rawRecoveryManagerDecisionCommands,
        rawRecoverySettlementCommands:
          commitMutation.result.rawRecoverySettlementCommands,
        managerDecisionProposed: commitMutation.result.managerDecisionLedger,
        managerDecisionCommands: commitMutation.result.managerDecisionCommands,
        settlementCommands: commitMutation.result.settlementCommands,
        proposed: commitMutation.ledger,
        managerOutput: {
          ...commitMutation.result.lifecycleManagerOutput,
          invalidatedFindings: [
            ...commitMutation.result.lifecycleManagerOutput.invalidatedFindings,
            ...(commitMutation.result.actionRecoveryPlan?.output.invalidatedFindings ?? []),
          ],
        },
        cwd: params.input.cwd,
        workflowName: params.input.workflowName,
        runId: params.input.runId,
        scopeIdentity: params.input.ledgerStore.ledgerIdentity,
        reviewScopeSnapshotId: params.reviewScopeSnapshotId,
        observation: params.observation,
      });
      const lifecycleLedger = assembleAndApplyManagerLifecycleTransactions({
        current: freshLedger,
        rawRecoveryManagerDecisionCommands:
          commitMutation.result.rawRecoveryManagerDecisionCommands,
        rawRecoveryManagerDecisionProposed:
          commitMutation.result.rawRecoveryManagerDecisionLedger,
        rawRecoverySettlementCommands:
          commitMutation.result.rawRecoverySettlementCommands,
        rawRecoveryProposed: commitMutation.result.rawRecoveryLedger,
        managerDecisionCommands: commitMutation.result.managerDecisionCommands,
        managerDecisionProposed: commitMutation.result.managerDecisionLedger,
        proposed: proofed.ledger,
        occurredAt: params.observation,
        managerOutput: commitMutation.result.lifecycleManagerOutput,
        resolutionRenotifications: commitMutation.result.resolutionRenotifications,
        settlementCommands: commitMutation.result.settlementCommands,
        actionRecoveryPlan: commitMutation.result.actionRecoveryPlan,
        provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
        rawRecoveryProvisionalProofIdsByFinding:
          proofed.rawRecoveryProvisionalProofIdsByFinding,
        invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
        duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
        managerDecisionProvisionalTransitionProofIdsByCommandKey:
          proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
        provisionalTransitionProofIdsByCommandKey:
          proofed.provisionalTransitionProofIdsByCommandKey,
        rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey:
          proofed.rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
        rawRecoveryProvisionalTransitionProofIdsByCommandKey:
          proofed.rawRecoveryProvisionalTransitionProofIdsByCommandKey,
        invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      });
      const withRejectedObservations = applyRejectedObservationAttachments(
        lifecycleLedger,
        commitMutation.result.rejectedObservationAttachments,
        params.observation,
      );
      const epochSynchronized = syncProvisionalInterpretationEpochs(
        withRejectedObservations,
        params.observation,
      );
      const completedRecovery = completeRawRecoveryAttempts(
        freshLedger,
        epochSynchronized,
        params.managerDecision.rawRecovery.reservationTokens,
        recoveryOrigins,
        params.observation,
      );
      const lifecycleMutation = {
        ...commitMutation,
        ledger: attachFixpointState(
          freshLedger,
          completedRecovery,
          params.input.cwd,
        ),
      };
      const report = buildCommitReport(params, commitMutation.result);
      if (report === undefined) {
        return lifecycleMutation;
      }
      return {
        ...lifecycleMutation,
        publication: {
          roundMarker: params.stopBudgetRoundMarker,
          report,
        },
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
    await releaseInterpretationReservations(
      params.input.ledgerStore,
      params.managerDecision.ladder.interpretationReservations,
      params.observation,
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
      ...committed.unsupportedRawFindingReports,
    ],
    overflowReports: intake.overflowReports,
    provisionalLandings: committed.provisionalLandings,
    reviewerAnomalyLandings: committed.reviewerAnomalyLandings,
    rawNormalizations: intake.rawNormalizations,
    clarifications: intake.clarifications,
    interpretationStats: managerDecision.ladder.stats,
    rawFindingDispositions: committed.rawFindingDispositions,
    interpretationRecoverySettlements: committed.interpretationRecoverySettlements,
    managerTaskAudits: managerDecision.taskAudits,
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
    boundLedger = await input.ledgerStore.rebindPendingManagerValidationPublication(
      boundPublication,
    );
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
  const finalized = await input.ledgerStore.finalizeManagerValidationPublication(
    boundPending.publication,
    receipt,
  );
  return {
    ledger: finalized.ledger,
    completedRoundMarker: finalized.completedRoundMarker,
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
  await store.rebindPendingManagerValidationPublication(boundPublication);
}
