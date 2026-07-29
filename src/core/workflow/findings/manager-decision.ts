import type { AgentWorkflowStep } from '../../models/types.js';
import type {
  FindingLedger,
  FindingObservation,
} from './types.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import {
  computeDismissCandidates,
  computeInvalidLocationCandidates,
} from './manager-utils.js';
import { hasDisputeClaimsHeading } from './manager-output-validation.js';
import type {
  FindingManagerValidationAttemptReport,
} from './store.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';
import { runAmbiguousLadder } from './manager-interpretation.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import { runRawAdjudicationRecovery } from './raw-adjudication-recovery.js';
import { releaseRawAdjudicationReservations } from './raw-adjudication-reservation.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import { runMainManagerTasks } from './manager-task-runner.js';
import {
  hasLifecycleProductTransitionCapability,
  hasLifecycleTransitionIntent,
} from './raw-relation-capabilities.js';

export {
  FINDING_MANAGER_SCHEMA_REF,
  RAW_FINDINGS_SCHEMA_REF,
  createRawFindingsStructuredOutput,
} from './manager-agent.js';

export async function runManagerDecisionStage(params: {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  admission: RawAdmissionEvaluation;
  managerStep: AgentWorkflowStep;
  observation: FindingObservation;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
  stopBudgetRoundMarker: string;
}): Promise<ManagerDecisionStageResult> {
  const {
    input,
    previousLedger,
    admission,
    managerStep,
    observation,
    reviewScopeSnapshotId,
    reviewScopeSnapshot,
    stopBudgetRoundMarker,
  } = params;
  const {
    cleanWire,
    taintedAdmitted,
    provisionalOnlyLadderRawIds,
  } = admission;
  const rawRecovery = await runRawAdjudicationRecovery({
    runInput: input,
    previousLedger,
    managerStep,
    observation,
    reviewScopeSnapshotId,
    reviewScopeSnapshot,
  });
  try {
    const findingsById = new Map(previousLedger.findings.map((finding) => [finding.id, finding]));
    const cleanAuditOnlyLifecycleRawIds = new Set(
      admission.cleanAdmitted
        .filter((item) => (
          item.canonical.relation !== null
          && item.canonical.relation !== 'new'
          && !hasLifecycleProductTransitionCapability({
            relation: item.canonical.relation,
            target: item.canonical.targetFindingId === undefined
              ? undefined
              : findingsById.get(item.canonical.targetFindingId),
          })
        ))
        .map((item) => item.wire.rawFindingId),
    );
    const decisionAdmission: RawAdmissionEvaluation = cleanAuditOnlyLifecycleRawIds.size === 0
      ? admission
      : {
          ...admission,
          cleanAdmitted: admission.cleanAdmitted.filter(
            (item) => !cleanAuditOnlyLifecycleRawIds.has(item.wire.rawFindingId),
          ),
          cleanWire: cleanWire.filter(
            (wire) => !cleanAuditOnlyLifecycleRawIds.has(wire.rawFindingId),
          ),
        };
    const invalidLocationCandidates = computeInvalidLocationCandidates(input.cwd, previousLedger);
    const invalidLocationCandidateFindingIds = new Set(invalidLocationCandidates.keys());
    const dismissCandidates = computeDismissCandidates(previousLedger);
    const dismissCandidateFindingIds = new Set(dismissCandidates.keys());
    const mechanical = classifyRawFindingsMechanically({
      previousLedger,
      rawFindings: decisionAdmission.cleanWire,
    });
    const hasDisputeClaims = hasDisputeClaimsHeading(input.priorStepResponseText);
    const hasActiveConflict = previousLedger.conflicts.some((conflict) => conflict.status === 'active');
    // dismiss 候補（滞留する provisional）が1件でもあれば、残余 raw がゼロでも
    // manager を起動する — 起動しないと候補が裁定されないまま完了ゲートを
    // 塞ぎ続ける（1ラウンド税の成立条件）。
    const needsAgent = mechanical.residualRawFindings.length > 0
      || hasDisputeClaims
      || hasActiveConflict
      || invalidLocationCandidateFindingIds.size > 0
      || dismissCandidateFindingIds.size > 0;

    let initialInvalidAttempts: FindingManagerValidationAttemptReport[] = [];
    let taskExecution: Awaited<ReturnType<typeof runMainManagerTasks>> | undefined;
    if (needsAgent) {
      taskExecution = await runMainManagerTasks({
        contract: input.contract,
        previousLedger,
        reviewScopeSnapshotId,
        residualRawFindings: mechanical.residualRawFindings,
        mechanicallyClassifiedCount: decisionAdmission.cleanWire.length
          - mechanical.residualRawFindings.length,
        priorStepResponseText: input.priorStepResponseText,
        invalidLocationCandidates,
        dismissCandidates,
        evidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
        managerStep,
        runInput: input,
      });
      initialInvalidAttempts = taskExecution.invalidAttemptMessages.map((message, index) => ({
        attempt: index + 1,
        managerOutput: { error: message },
        validationErrors: [message],
      }));
    }

    const cleanDecision = assembleCleanManagerDecision({
      previousLedger,
      admission: decisionAdmission,
      mechanical,
      decisions: taskExecution?.decisions,
      initialInvalidAttempts,
      invalidLocationCandidateFindingIds,
      dismissCandidateFindingIds,
      priorStepResponseText: input.priorStepResponseText,
      rawFailureById: taskExecution?.rawFailures,
    });
    const {
      managerOutput,
      invalidAttempts,
      cleanProvisionalSpecs,
      cleanWireById,
      cleanCanonicalById,
    } = cleanDecision;
    let unsupportedRawFindingReports = cleanDecision.unsupportedRawFindingReports;

    for (const item of admission.cleanAdmitted) {
      if (!cleanAuditOnlyLifecycleRawIds.has(item.wire.rawFindingId)) {
        continue;
      }
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, {
        rawFindingId: item.wire.rawFindingId,
        targetFindingId: item.wire.targetFindingId
          ?? item.canonical.targetFindingId
          ?? '(none)',
        evidence: 'Lifecycle claim has no transition capability for the target state; recorded for audit only — no finding was created or changed',
      }];
    }

    // 曖昧起源の lifecycle claim には product finding の作成・変更権限がない。
    const taintedLifecycle = taintedAdmitted.filter(
      (item) => hasLifecycleTransitionIntent({
        relation: item.canonical.relation,
        targetFindingId: item.canonical.targetFindingId,
      }),
    );
    for (const item of taintedLifecycle) {
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, {
        rawFindingId: item.wire.rawFindingId,
        targetFindingId: item.wire.targetFindingId ?? item.canonical.targetFindingId ?? '(none)',
        evidence: 'Ambiguity-tainted lifecycle claim has no product transition capability; recorded for audit only — no finding was created or changed',
      }];
    }
    const ladderTainted = taintedAdmitted.filter(
      (item) => !taintedLifecycle.includes(item),
    );
    const ladder = await runAmbiguousLadder({
      tainted: ladderTainted,
      provisionalOnlyRawFindingIds: provisionalOnlyLadderRawIds,
      previousLedger,
      ledgerStore: input.ledgerStore,
      contract: input.contract,
      workflowProvider: input.workflowProvider,
      workflowModel: input.workflowModel,
      optionsBuilder: input.optionsBuilder,
      stepExecutor: input.stepExecutor,
      observation,
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStep.name,
      stopBudgetRoundMarker,
    });

    return {
      managerOutput,
      conflictTargetHeads: taskExecution?.conflictTargetHeads ?? new Map(),
      invalidAttempts,
      cleanProvisionalSpecs,
      unsupportedRawFindingReports,
      cleanWireById,
      cleanCanonicalById,
      ladder,
      rawRecovery,
      taskAudits: taskExecution?.taskAudits ?? [],
    };
  } catch (error) {
    releaseRawAdjudicationReservations(input.ledgerStore, rawRecovery.reservationTokens);
    throw error;
  }
}
