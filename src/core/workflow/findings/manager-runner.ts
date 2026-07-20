import { createLogger } from '../../../shared/utils/index.js';
import { evaluateRawAdmission } from './manager-admission.js';
import { commitFindingManagerRound } from './manager-commit.js';
import type {
  FindingManagerRunResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { runManagerDecisionStage } from './manager-decision.js';
import { prepareFindingManagerRound } from './manager-preparation.js';
import { retainInterpretationRecoveryForLadder } from './interpretation-recovery.js';

const log = createLogger('finding-manager-runner');

export type { FindingManagerSubStepResult } from './manager-intake.js';
export type {
  FindingManagerRunResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
export {
  FINDING_MANAGER_SCHEMA_REF,
  RAW_FINDINGS_SCHEMA_REF,
  RawFindingsStructuredOutput,
} from './manager-decision.js';

export async function runFindingManagerForStep(
  input: RunFindingManagerForStepInput,
): Promise<FindingManagerRunResult> {
  const prepared = prepareFindingManagerRound(input);
  const admission = retainInterpretationRecoveryForLadder(evaluateRawAdmission({
    cwd: input.cwd,
    previousLedger: prepared.previousLedger,
    intake: prepared.intake,
  }), prepared.intake);
  const managerDecision = await runManagerDecisionStage({
    input,
    previousLedger: prepared.previousLedger,
    admission,
    managerStep: prepared.managerStep,
    ledgerCopyPath: prepared.ledgerCopyPath,
    rawFindingsPath: prepared.rawFindingsPath,
    observation: prepared.observation,
  });
  const committed = await commitFindingManagerRound({
    input,
    previousLedger: prepared.previousLedger,
    intake: prepared.intake,
    interpretationRecoveryFailures: prepared.interpretationRecoveryFailures,
    admission,
    managerDecision,
    observation: prepared.observation,
    stopBudgetLimits: prepared.stopBudgetLimits,
    stopBudgetRoundMarker: prepared.stopBudgetRoundMarker,
    reviewIntegrityLimits: prepared.reviewIntegrityLimits,
  });

  log.info('Finding contract intake completed', {
    step: input.parentStep.name,
    rawFindings: prepared.intake.items.length,
    ambiguous: managerDecision.ladder.stats.ambiguousRawCount,
    managerCalls: managerDecision.ladder.stats.managerCalls,
    provisionalLandings: committed.provisionalLandingCount,
    reviewerAnomalyLandings: committed.reviewerAnomalyLandingCount,
    overflowReviewers: prepared.intake.overflowReports.length,
    staleConfirmations: committed.staleRejectionCount,
  });
  return {
    status: 'updated',
    ledgerPath: prepared.ledgerCopyPath,
    providerInfo: prepared.providerInfo,
    ledger: committed.nextLedger,
  };
}
