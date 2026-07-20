import type { AgentWorkflowStep } from '../../models/types.js';
import type { StepProviderInfo } from '../types.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { intakeReviewerOutputs } from './manager-intake.js';
import { buildFindingManagerStep } from './manager-step.js';
import { computeRoundMarker } from './round-marker.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import {
  attachInterpretationRecoveryOrigins,
  collectInterpretationRecoveryPlan,
  type InterpretationRecoveryFailure,
} from './interpretation-recovery.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';

export interface PreparedFindingManagerRound {
  previousLedger: FindingLedger;
  ledgerCopyPath: string;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  intake: ReviewerIntakeResult;
  interpretationRecoveryFailures: InterpretationRecoveryFailure[];
  rawFindingsPath: string;
  managerStep: AgentWorkflowStep;
  providerInfo: StepProviderInfo;
}

export function prepareFindingManagerRound(
  input: RunFindingManagerForStepInput,
): PreparedFindingManagerRound {
  const previousLedger = input.ledgerStore.loadLedger();
  const ledgerCopyPath = input.ledgerCopyPath ?? input.ledgerStore.createRunCopy();
  const observation: FindingObservation = {
    runId: input.runId,
    stepName: input.parentStep.name,
    timestamp: input.timestamp,
  };
  const stopBudgetLimits = resolveStopBudgetLimits(input.contract.stopBudget);
  const stopBudgetRoundMarker = computeRoundMarker({
    runId: input.runId,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
    stepIteration: input.stepIteration,
  });
  const reviewIntegrityLimits = resolveReviewIntegrityLimits(input.contract.reviewBudget);
  const reviewerIntake = intakeReviewerOutputs({
    subResults: input.subResults,
    previousLedger,
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
    stepIteration: input.stepIteration,
    runId: input.runId,
  });
  const roundsCompleted = stopBudgetRoundsCompleted(previousLedger);
  const currentItems = attachInterpretationRecoveryOrigins({
    ledger: previousLedger,
    currentItems: reviewerIntake.items,
    roundsCompleted,
  });
  const interpretationRecovery = collectInterpretationRecoveryPlan({
    ledger: previousLedger,
    currentItems,
    roundsCompleted,
  });
  const intake: ReviewerIntakeResult = {
    ...reviewerIntake,
    items: [...interpretationRecovery.items, ...currentItems],
  };
  const rawFindingsPath = input.ledgerStore.saveRawFindings(
    input.runId,
    input.parentStep.name,
    intake.items.map((item) => item.wire),
  );

  // 後続の manager/WAL が失敗しても、正規化前の reviewer 主張を監査可能にする。
  if (intake.rawNormalizations.length > 0
    || intake.overflowReports.length > 0
    || intake.clarifications.length > 0) {
    input.ledgerStore.saveManagerValidationReport({
      version: 1,
      runId: input.runId,
      stepName: input.parentStep.name,
      retryCount: 0,
      ledgerUpdated: false,
      finalErrors: [],
      attempts: [],
      ...(intake.overflowReports.length > 0 ? { reviewerOutputOverflows: intake.overflowReports } : {}),
      ...(intake.rawNormalizations.length > 0 ? { rawNormalizations: intake.rawNormalizations } : {}),
      ...(intake.clarifications.length > 0 ? { relationClarifications: intake.clarifications } : {}),
    });
  }

  const managerStep = buildFindingManagerStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
  });
  return {
    previousLedger,
    ledgerCopyPath,
    observation,
    stopBudgetLimits,
    stopBudgetRoundMarker,
    reviewIntegrityLimits,
    intake,
    interpretationRecoveryFailures: interpretationRecovery.failures,
    rawFindingsPath,
    managerStep,
    providerInfo: input.optionsBuilder.resolveStepProviderModel(managerStep),
  };
}
