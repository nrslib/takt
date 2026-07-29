import type { AgentWorkflowStep } from '../../models/types.js';
import type { StepProviderInfo } from '../types.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { intakeReviewerOutputs } from './manager-intake.js';
import { buildFindingManagerStep } from './manager-step.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import {
  attachInterpretationRecoveryOrigins,
  collectInterpretationRecoveryPlan,
  type InterpretationRecoveryFailure,
} from './interpretation-recovery.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

export interface PreparedFindingManagerRound {
  previousLedger: FindingLedger;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  intake: ReviewerIntakeResult;
  interpretationRecoveryFailures: InterpretationRecoveryFailure[];
  managerStep: AgentWorkflowStep;
  providerInfo: StepProviderInfo;
}

export function prepareFindingManagerRound(
  input: RunFindingManagerForStepInput,
  stopBudgetRoundMarker: string,
  reviewScopeSnapshot: ReviewScopeProofSnapshot,
): PreparedFindingManagerRound {
  const previousLedger = input.ledgerStore.loadLedger();
  input.ledgerStore.saveLedgerSnapshot();
  const observation: FindingObservation = {
    runId: input.runId,
    stepName: input.parentStep.name,
    timestamp: input.timestamp,
  };
  const stopBudgetLimits = resolveStopBudgetLimits(input.contract.stopBudget);
  const reviewIntegrityLimits = resolveReviewIntegrityLimits(input.contract.reviewBudget);
  const reviewerIntake = intakeReviewerOutputs({
    subResults: input.subResults,
    previousLedger,
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
    stepIteration: input.stepIteration,
    runId: input.runId,
    workflowTask: input.workflowTask,
    cwd: input.cwd,
    scopeIdentity: input.ledgerStore.ledgerIdentity,
    issuedAt: input.timestamp,
    reviewScopeSnapshot,
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
  input.ledgerStore.saveRawFindings(
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
    observation,
    stopBudgetLimits,
    stopBudgetRoundMarker,
    reviewIntegrityLimits,
    intake,
    interpretationRecoveryFailures: interpretationRecovery.failures,
    managerStep,
    providerInfo: input.optionsBuilder.resolveStepProviderModel(managerStep),
  };
}
