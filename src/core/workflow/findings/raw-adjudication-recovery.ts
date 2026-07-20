import { createHash } from 'node:crypto';
import { createLogger } from '../../../shared/utils/index.js';
import type { AgentWorkflowStep } from '../../models/types.js';
import { captureFindingPreconditions } from './finding-preconditions.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import { buildManagerInstruction, parseManagerDecisions, runManagerAttempt } from './manager-agent.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { evaluateRawAdmission } from './manager-admission.js';
import type {
  RawAdjudicationRecoveryResult,
  RawAdjudicationReplayOrigin,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import { createEmptyManagerOutput } from './manager-output.js';
import {
  releaseRawAdjudicationReservations,
  reserveRawAdjudicationRecovery,
  type RawAdjudicationReservation,
} from './raw-adjudication-reservation.js';
import {
  candidateFromLegacyRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from './raw-canonicalization.js';
import type { FindingLedger, FindingManagerDecisions, FindingObservation, RawFinding } from './types.js';

const log = createLogger('raw-adjudication-recovery');

function emptyIntake(): ReviewerIntakeResult {
  return {
    items: [],
    overflowRawFindingIds: new Set(),
    overflowSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
}

function replayRawFindingId(input: {
  runId: string;
  parentStepName: string;
  provisionalFindingId: string;
  attempt: number;
}): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `replay-${digest}`;
}

function sourceRawForAttempt(
  ledger: FindingLedger,
  sourceRawFindingIds: readonly string[],
  attempt: number,
): { sourceRawFindingId: string; source?: RawFinding } {
  if (sourceRawFindingIds.length === 0) {
    return { sourceRawFindingId: `raw-adjudication:${attempt}:missing-source` };
  }
  const sourceRawFindingId = sourceRawFindingIds[(attempt - 1) % sourceRawFindingIds.length]!;
  const source = ledger.rawFindings.find((raw) => raw.rawFindingId === sourceRawFindingId);
  return { sourceRawFindingId, ...(source === undefined ? {} : { source }) };
}

function buildReplayIntake(input: {
  ledger: FindingLedger;
  runId: string;
  parentStepName: string;
  reservations: readonly RawAdjudicationReservation[];
}): { intake: ReviewerIntakeResult; origins: Map<string, RawAdjudicationReplayOrigin>; failures: Map<string, string> } {
  const intake = emptyIntake();
  const origins = new Map<string, RawAdjudicationReplayOrigin>();
  const failures = new Map<string, string>();
  for (const reservation of input.reservations) {
    const finding = input.ledger.findings.find((entry) => entry.id === reservation.provisionalFindingId);
    if (finding?.provisional === undefined) {
      throw new Error(`Reserved raw adjudication provisional "${reservation.provisionalFindingId}" no longer exists`);
    }
    // 既存台帳には reviewer provenance が無いため、stableKey を replay の canonical 名前空間として使う。
    const reviewerStableKey = finding.provisional.recoveryReviewerStableKey
      ?? finding.provisional.stableKey;
    const attempt = reservation.attempt;
    const replayRawId = replayRawFindingId({
      runId: input.runId,
      parentStepName: input.parentStepName,
      provisionalFindingId: finding.id,
      attempt,
    });
    const sourceResult = sourceRawForAttempt(
      input.ledger,
      finding.provisional.sourceRawFindingIds,
      attempt,
    );
    origins.set(replayRawId, {
      provisionalFindingId: finding.id,
      sourceRawFindingId: sourceResult.sourceRawFindingId,
      expectedProvisionalRevision: reservation.expectedRevision,
      attempt,
    });
    if (sourceResult.source === undefined) {
      failures.set(replayRawId, finding.provisional.sourceRawFindingIds.length === 0
        ? 'Raw adjudication recovery has no source raw finding id'
        : `Raw adjudication recovery references missing raw finding "${sourceResult.sourceRawFindingId}"`);
      continue;
    }
    const source = sourceResult.source;
    const replayRaw = { ...source, rawFindingId: replayRawId };
    const candidate = candidateFromLegacyRawFinding(replayRaw, reviewerStableKey);
    const canonical = canonicalizeReviewerRawFinding(candidate, { ledger: input.ledger }).canonical;
    const wire = toLedgerRawFinding(canonical);
    intake.items.push({ canonical, wire });
    if (wire.targetFindingId !== undefined
      && !input.ledger.findings.some((entry) => entry.id === wire.targetFindingId)) {
      failures.set(replayRawId, `target finding "${wire.targetFindingId}" no longer exists`);
    }
  }
  return { intake, origins, failures };
}

function rawOnlyDecisions(decisions: FindingManagerDecisions): FindingManagerDecisions {
  return {
    rawDecisions: decisions.rawDecisions,
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  };
}

function admissionFailureReasons(
  intake: ReviewerIntakeResult,
  admittedRawIds: ReadonlySet<string>,
): Map<string, string> {
  return new Map(intake.items.flatMap((item) => (
    admittedRawIds.has(item.wire.rawFindingId)
      ? []
      : [[item.wire.rawFindingId, 'replay source evidence did not pass current admission'] as const]
  )));
}

export async function runRawAdjudicationRecovery(input: {
  runInput: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  managerStep: AgentWorkflowStep;
  ledgerCopyPath: string;
  observation: FindingObservation;
}): Promise<RawAdjudicationRecoveryResult> {
  const reservation = await reserveRawAdjudicationRecovery(input.runInput.ledgerStore);
  const reservationTokens = new Set(reservation.result.map((item) => item.reservationToken));
  try {
    return await runReservedRawAdjudicationRecovery({
      ...input,
      previousLedger: reservation.ledger,
      reservations: reservation.result,
      reservationTokens,
    });
  } catch (error) {
    releaseRawAdjudicationReservations(input.runInput.ledgerStore, reservationTokens);
    throw error;
  }
}

async function runReservedRawAdjudicationRecovery(input: {
  runInput: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  managerStep: AgentWorkflowStep;
  ledgerCopyPath: string;
  observation: FindingObservation;
  reservations: readonly RawAdjudicationReservation[];
  reservationTokens: Set<string>;
}): Promise<RawAdjudicationRecoveryResult> {
  const prepared = buildReplayIntake({
    ledger: input.previousLedger,
    runId: input.runInput.runId,
    parentStepName: input.runInput.parentStep.name,
    reservations: input.reservations,
  });
  const capturedPreconditions = captureFindingPreconditions(input.previousLedger);
  if (prepared.intake.items.length === 0) {
    return {
      intake: prepared.intake,
      output: createEmptyManagerOutput(),
      origins: prepared.origins,
      failureReasons: prepared.failures,
      capturedPreconditions,
      invalidAttempts: [],
      unsupportedRawFindingReports: [],
      cleanWireById: new Map(),
      cleanCanonicalById: new Map(),
      reservationTokens: input.reservationTokens,
    };
  }
  const admission = evaluateRawAdmission({
    cwd: input.runInput.cwd,
    previousLedger: input.previousLedger,
    intake: prepared.intake,
  });
  const admittedRawIds = new Set(admission.cleanWire.map((wire) => wire.rawFindingId));
  const failureReasons = new Map([
    ...prepared.failures,
    ...admissionFailureReasons(prepared.intake, admittedRawIds),
  ]);
  const adjudicableWire = admission.cleanWire.filter((wire) => !failureReasons.has(wire.rawFindingId));
  const mechanical = classifyRawFindingsMechanically({
    previousLedger: input.previousLedger,
    rawFindings: adjudicableWire,
    excludedFindingIdsFromExactDuplicateIndex: new Set(
      [...prepared.origins.values()].map((origin) => origin.provisionalFindingId),
    ),
  });
  let initialInvalidAttempts: RawAdjudicationRecoveryResult['invalidAttempts'] = [];
  let decisions: FindingManagerDecisions | undefined;
  if (mechanical.residualRawFindings.length > 0) {
    const rawFindingsPath = input.runInput.ledgerStore.saveRawFindings(
      input.runInput.runId,
      `${input.runInput.parentStep.name}-replay`,
      prepared.intake.items.map((item) => item.wire),
    );
    const instruction = buildManagerInstruction({
      contract: input.runInput.contract,
      previousLedger: input.previousLedger,
      ledgerCopyPath: input.ledgerCopyPath,
      rawFindingsPath,
      residualRawFindings: mechanical.residualRawFindings,
      mechanicallyClassifiedCount: adjudicableWire.length - mechanical.residualRawFindings.length,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map(),
    });
    try {
      const response = await runManagerAttempt({
        managerStep: input.managerStep,
        instruction,
        optionsBuilder: input.runInput.optionsBuilder,
        stepExecutor: input.runInput.stepExecutor,
      });
      decisions = rawOnlyDecisions(parseManagerDecisions(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Raw adjudication replay call failed', { error: message });
      decisions = rawOnlyDecisions({
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      });
      initialInvalidAttempts = [{
        attempt: 1,
        managerOutput: { error: message },
        validationErrors: [message],
      }];
    }
  }
  const clean = assembleCleanManagerDecision({
    previousLedger: input.previousLedger,
    admission: {
      ...admission,
      cleanWire: adjudicableWire,
      cleanAdmitted: admission.cleanAdmitted.filter(
        (item) => !failureReasons.has(item.wire.rawFindingId),
      ),
    },
    mechanical,
    decisions,
    initialInvalidAttempts,
    invalidLocationCandidateFindingIds: new Set(),
    dismissCandidateFindingIds: new Set(),
    priorStepResponseText: undefined,
  });
  for (const spec of clean.cleanProvisionalSpecs) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      failureReasons.set(rawFindingId, spec.reason);
    }
  }
  return {
    intake: prepared.intake,
    output: clean.managerOutput,
    origins: prepared.origins,
    failureReasons,
    capturedPreconditions,
    invalidAttempts: clean.invalidAttempts,
    unsupportedRawFindingReports: clean.unsupportedRawFindingReports,
    cleanWireById: clean.cleanWireById,
    cleanCanonicalById: clean.cleanCanonicalById,
    reservationTokens: input.reservationTokens,
  };
}
