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
import {
  attachReviewIntegrityState,
  carryReviewIntegrityState,
  resolveReviewIntegrityLimits,
} from './review-integrity.js';
import { attachStopBudgetState, resolveStopBudgetLimits } from './stop-budget.js';
import type { ProvisionalLandingReport, RawAdmissionRejectionReport, ReviewerAnomalyLandingReport } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type {
  InterpretationRecoveryOriginSettlement,
} from './types.js';
import { issueManagerLifecycleAuthority } from './manager-lifecycle-authority.js';
import { assembleAndApplyManagerLifecycleTransactions } from './manager-lifecycle-assembly.js';
import { applyRejectedObservationAttachments } from './manager-provisional-settlement.js';
import { attachFixpointState } from './fixpoint.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import {
  settleReviewerAnomaliesFromAuthorizedTerminalEvents,
} from './reviewer-anomaly-settlement.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';
import { finalizeInterpretationCaseProjection } from './interpretation-case-finalizer.js';
import { refreshActiveConflictAdjudicationSnapshots } from './conflict-adjudication-model.js';
import {
  landUnownedConflictRawClaims,
} from './conflict-claim-landing.js';

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
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
}

export async function commitFindingManagerRound(params: {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): Promise<CommitFindingManagerRoundResult> {
  const mutation = await params.input.ledgerStore.commitManagerLedger((freshLedger) => {
      const commitMutation = buildFindingManagerCommitMutation(params, freshLedger);
      if (!commitMutation.result.applied) {
        return commitMutation;
      }
      const proofed = issueManagerLifecycleAuthority({
        current: freshLedger,
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
        managerDecisionCommands: commitMutation.result.managerDecisionCommands,
        managerDecisionProposed: commitMutation.result.managerDecisionLedger,
        proposed: proofed.ledger,
        occurredAt: params.observation,
        managerOutput: commitMutation.result.lifecycleManagerOutput,
        resolutionRenotifications: commitMutation.result.resolutionRenotifications,
        settlementCommands: commitMutation.result.settlementCommands,
        actionRecoveryPlan: commitMutation.result.actionRecoveryPlan,
        provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
        invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
        duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
        managerDecisionProvisionalTransitionProofIdsByCommandKey:
          proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
        provisionalTransitionProofIdsByCommandKey:
          proofed.provisionalTransitionProofIdsByCommandKey,
        invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      });
      const withRejectedObservations = applyRejectedObservationAttachments(
        lifecycleLedger,
        commitMutation.result.rejectedObservationAttachments,
        params.observation,
      );
      const settledAnomalies = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
        freshLedger,
        proofed.ledger,
        withRejectedObservations,
        computeWorkflowTaskDigest(params.input.workflowTask),
      );
      const interpretationFinalized = finalizeInterpretationCaseProjection({
        ledger: settledAnomalies,
        prepared: commitMutation.result.interpretationPrepared,
        observation: params.observation,
      });
      const withConflictLandings = landUnownedConflictRawClaims({
        ledger: interpretationFinalized,
        observation: params.observation,
      });
      const withConflictSnapshots = refreshActiveConflictAdjudicationSnapshots({
        ledger: withConflictLandings,
        originStep: params.input.parentStep.name,
        createdAt: params.observation,
      });
      // 言い直し slot の各パスは「レビューラウンドの内側の差し戻し」であって
      // 新しいレビューラウンドではない。marker は適用済み集合へ必ず入れる
      // （二相コミットの staging 不変条件と crash/replay の冪等性がこの集合に依存
      // する）が、予算カウンタは印付き marker を数えない。review-integrity 側は
      // 集合そのものが予算なので、追加せず据え置く。
      const countsAsRound = params.input.budgetAccounting !== 'excluded';
      const withStopBudget = attachStopBudgetState(
        freshLedger,
        withConflictSnapshots,
        params.stopBudgetLimits,
        params.stopBudgetRoundMarker,
        params.input.timestamp,
      );
      const withReviewIntegrity = countsAsRound
        ? attachReviewIntegrityState(
          freshLedger,
          withStopBudget,
          params.reviewIntegrityLimits,
          params.stopBudgetRoundMarker,
          params.input.timestamp,
        )
        : carryReviewIntegrityState(freshLedger, withStopBudget);
      const lifecycleMutation = {
        ...commitMutation,
        ledger: attachFixpointState(
          freshLedger,
          withReviewIntegrity,
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
      ...managerDecision.invalidAttempts,
    ],
    staleRejections: committed.staleRejections,
    admissionRejections: committed.admissionRejections,
    unsupportedRawFindingReports: [
      ...managerDecision.unsupportedRawFindingReports,
      ...committed.unsupportedRawFindingReports,
    ],
    overflowReports: intake.overflowReports,
    provisionalLandings: committed.provisionalLandings,
    reviewerAnomalyLandings: committed.reviewerAnomalyLandings,
    rawNormalizations: intake.rawNormalizations,
    clarifications: intake.clarifications,
    interpretationStats: managerDecision.interpretation.stats,
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
