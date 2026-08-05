import { createLogger } from '../../../shared/utils/index.js';
import { evaluateRawAdmission } from './manager-admission.js';
import {
  commitFindingManagerRound,
  resumePendingManagerCommit,
} from './manager-commit.js';
import type {
  FindingManagerRunResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { runManagerDecisionStage } from './manager-decision.js';
import { prepareFindingManagerRound } from './manager-preparation.js';
import { captureReviewScopeProofSnapshot } from './snapshot.js';
import { computeRoundMarker } from './round-marker.js';
import { runManagerRoundExclusive } from './manager-round-lock.js';
import { bindPreAdmissionEntities } from './pre-admission-entity-binding.js';
import { collectRestatementRequests } from './review-publication.js';
import { migrateLegacyIntakeProvisionalFindings } from './legacy-intake-reclassification.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';

const log = createLogger('finding-manager-runner');

export type { FindingManagerSubStepResult } from './manager-intake.js';
export type {
  FindingManagerRunResult,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
export {
  FINDING_MANAGER_SCHEMA_REF,
  RAW_FINDINGS_SCHEMA_REF,
  createRawFindingsStructuredOutput,
} from './manager-decision.js';

export async function runFindingManagerForStep(
  input: RunFindingManagerForStepInput,
): Promise<FindingManagerRunResult> {
  const publicationIds = input.subResults.map(({ subStep, publication }) => {
    if (
      publication.scopeIdentity !== input.ledgerStore.ledgerIdentity
      || publication.callNamespace !== input.callNamespace
      || publication.parentStepName !== input.parentStep.name
      || publication.stepIteration !== input.stepIteration
      || publication.reviewerStepName !== subStep.name
    ) {
      throw new Error(
        `Finding review publication "${publication.publicationId}" does not match its manager round`,
      );
    }
    return publication.publicationId;
  });
  if (new Set(publicationIds).size !== publicationIds.length) {
    throw new Error('Finding manager round contains duplicate review publications');
  }
  const stopBudgetRoundMarker = computeRoundMarker({
    runId: input.runId,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStep.name,
    stepIteration: input.stepIteration,
    publicationIds,
  });

  return runManagerRoundExclusive(input.ledgerStore, async () => {
    const migrationInput = {
      observation: {
        runId: input.runId,
        stepName: input.parentStep.name,
        timestamp: input.timestamp,
      },
      presentationLimit: resolveReviewIntegrityLimits(input.contract.reviewBudget).maxReviewRounds,
    };
    const loadedBeforeMigration = input.ledgerStore.loadLedger();
    const migration = migrateLegacyIntakeProvisionalFindings({
      ledger: loadedBeforeMigration,
      ...migrationInput,
    });
    const loadedLedger = migration.migratedFindingIds.length === 0
      ? loadedBeforeMigration
      : (await input.ledgerStore.updateLedger((ledger) => {
          const result = migrateLegacyIntakeProvisionalFindings({
            ledger,
            ...migrationInput,
          });
          return { ledger: result.ledger, result: result.migratedFindingIds };
        })).ledger;
    log.info('Legacy intake migration checked', {
      step: input.parentStep.name,
      migratedFindingIds: migration.migratedFindingIds,
      migratedCount: migration.migratedFindingIds.length,
    });
    const resumed = await resumePendingManagerCommit(input, loadedLedger);
    const currentLedger = resumed?.ledger ?? loadedLedger;
    if (resumed?.completedRoundMarker === stopBudgetRoundMarker) {
      return {
        status: 'unchanged',
        ledger: currentLedger,
      };
    }
    if (currentLedger.stopBudget?.roundMarkers.includes(stopBudgetRoundMarker) === true) {
      return {
        status: 'unchanged',
        ledger: currentLedger,
      };
    }

    const reviewScopeSnapshot = captureReviewScopeProofSnapshot(input.cwd);
    const reviewScopeSnapshotId = reviewScopeSnapshot.reviewScopeSnapshotId;
    const prepared = prepareFindingManagerRound(
      input,
      stopBudgetRoundMarker,
      reviewScopeSnapshot,
    );
    const entityBinding = await bindPreAdmissionEntities({
      contract: input.contract,
      previousLedger: prepared.previousLedger,
      intake: prepared.intake,
      managerStep: prepared.managerStep,
      roundMarker: stopBudgetRoundMarker,
      runInput: input,
    });
    const intake = entityBinding.intake;
    const admission = evaluateRawAdmission({
      cwd: input.cwd,
      reviewScopeSnapshotId,
      runId: input.ledgerStore.runId,
      scopeIdentity: input.ledgerStore.ledgerIdentity,
      previousLedger: prepared.previousLedger,
      intake,
      reviewScopeSnapshot,
      workflowTask: input.workflowTask,
      presentationLimit: prepared.reviewIntegrityLimits.maxReviewRounds,
      restatementRequests: collectRestatementRequests(input.subResults.map(({ publication }) => publication)),
    });
    const managerDecision = await runManagerDecisionStage({
      input,
      previousLedger: prepared.previousLedger,
      admission,
      managerStep: prepared.managerStep,
      observation: prepared.observation,
      reviewScopeSnapshotId,
      reviewScopeSnapshot,
      stopBudgetRoundMarker,
      preAdmissionTaskAudits: entityBinding.taskAudits,
    });
    const committed = await commitFindingManagerRound({
      input,
      previousLedger: prepared.previousLedger,
      intake,
      admission,
      managerDecision,
      observation: prepared.observation,
      stopBudgetLimits: prepared.stopBudgetLimits,
      stopBudgetRoundMarker,
      reviewIntegrityLimits: prepared.reviewIntegrityLimits,
      reviewScopeSnapshotId,
      reviewScopeSnapshot,
    });

    if (!committed.applied) {
      return {
        status: 'unchanged',
        providerInfo: prepared.providerInfo,
        ledger: committed.nextLedger,
      };
    }

    log.info('Finding contract intake completed', {
      step: input.parentStep.name,
      rawFindings: prepared.intake.items.length,
      ambiguous: managerDecision.interpretation.stats.ambiguousRawCount,
      managerCalls: managerDecision.interpretation.stats.managerCalls,
      provisionalLandings: committed.provisionalLandingCount,
      reviewerAnomalyLandings: committed.reviewerAnomalyLandingCount,
      overflowReviewers: prepared.intake.overflowReports.length,
      staleConfirmations: committed.staleRejectionCount,
    });
    return {
      status: 'updated',
      providerInfo: prepared.providerInfo,
      ledger: committed.nextLedger,
    };
  });
}
