import type { AgentWorkflowStep } from '../../models/types.js';
import type {
  FindingLedger,
  FindingManagerDecisions,
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
import { buildManagerInstruction, parseManagerDecisions, runManagerAttempt } from './manager-agent.js';
import { runAmbiguousLadder } from './manager-interpretation.js';
import { createLogger } from '../../../shared/utils/index.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import { runRawAdjudicationRecovery } from './raw-adjudication-recovery.js';
import { releaseRawAdjudicationReservations } from './raw-adjudication-reservation.js';

const log = createLogger('finding-manager-decision');

export {
  FINDING_MANAGER_SCHEMA_REF,
  RAW_FINDINGS_SCHEMA_REF,
  RawFindingsStructuredOutput,
} from './manager-agent.js';

export async function runManagerDecisionStage(params: {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  admission: RawAdmissionEvaluation;
  managerStep: AgentWorkflowStep;
  ledgerCopyPath: string;
  rawFindingsPath: string;
  observation: FindingObservation;
}): Promise<ManagerDecisionStageResult> {
  const {
    input,
    previousLedger,
    admission,
    managerStep,
    ledgerCopyPath,
    rawFindingsPath,
    observation,
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
    ledgerCopyPath,
    observation,
  });
  try {
    const invalidLocationCandidates = computeInvalidLocationCandidates(input.cwd, previousLedger.findings);
    const invalidLocationCandidateFindingIds = new Set(invalidLocationCandidates.keys());
    const dismissCandidates = computeDismissCandidates(previousLedger);
    const dismissCandidateFindingIds = new Set(dismissCandidates.keys());
    const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });
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
    let decisions: FindingManagerDecisions | undefined;
    if (needsAgent) {
      const instruction = buildManagerInstruction({
        contract: input.contract,
        previousLedger,
        ledgerCopyPath,
        rawFindingsPath,
        residualRawFindings: mechanical.residualRawFindings,
        mechanicallyClassifiedCount: cleanWire.length - mechanical.residualRawFindings.length,
        priorStepResponseText: input.priorStepResponseText,
        invalidLocationCandidates,
        dismissCandidates,
      });
      try {
        const response = await runManagerAttempt({
          managerStep,
          instruction,
          optionsBuilder: input.optionsBuilder,
          stepExecutor: input.stepExecutor,
        });
        decisions = parseManagerDecisions(response);
      } catch (error) {
        // manager の壊れた応答で run を殺さない（v2 の中核不変条件）。残余 raw は
        // 全て provisional へ着地し、機械分類の確定分だけを適用する。
        const message = error instanceof Error ? error.message : String(error);
        log.warn('Finding manager decisions call failed; landing residual raws as provisional', { error: message });
        decisions = { rawDecisions: [], disputeDecisions: [], conflictDecisions: [], invalidateDecisions: [], duplicateDecisions: [], dismissDecisions: [] };
        initialInvalidAttempts = [
          { attempt: 1, managerOutput: { error: message }, validationErrors: [message] },
        ];
      }
    }

    const cleanDecision = assembleCleanManagerDecision({
      previousLedger,
      admission,
      mechanical,
      decisions,
      initialInvalidAttempts,
      invalidLocationCandidateFindingIds,
      dismissCandidateFindingIds,
      priorStepResponseText: input.priorStepResponseText,
    });
    const {
      managerOutput,
      invalidAttempts,
      cleanProvisionalSpecs,
      cleanWireById,
      cleanCanonicalById,
    } = cleanDecision;
    let unsupportedRawFindingReports = cleanDecision.unsupportedRawFindingReports;

    // 曖昧起源の confirmation には resolve 権限がなく、blocker にも変換しない。
    const taintedConfirmations = taintedAdmitted.filter(
      (item) => item.canonical.relation === 'resolution_confirmation',
    );
    for (const item of taintedConfirmations) {
      unsupportedRawFindingReports = [...unsupportedRawFindingReports, {
        rawFindingId: item.wire.rawFindingId,
        targetFindingId: item.wire.targetFindingId ?? item.canonical.targetFindingId ?? '(none)',
        evidence: 'Ambiguity-tainted resolution confirmation cannot serve as resolution evidence (no resolve capability); recorded for audit only — no finding was created or changed',
      }];
    }
    const ladderTainted = taintedAdmitted.filter(
      (item) => item.canonical.relation !== 'resolution_confirmation',
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
    });

    return {
      managerOutput,
      invalidAttempts,
      cleanProvisionalSpecs,
      unsupportedRawFindingReports,
      cleanWireById,
      cleanCanonicalById,
      ladder,
      rawRecovery,
    };
  } catch (error) {
    releaseRawAdjudicationReservations(input.ledgerStore, rawRecovery.reservationTokens);
    throw error;
  }
}
