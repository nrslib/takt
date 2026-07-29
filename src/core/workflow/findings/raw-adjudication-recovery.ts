import { createHash } from 'node:crypto';
import type { AgentWorkflowStep } from '../../models/types.js';
import { captureFindingPreconditions } from './finding-preconditions.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { evaluateRawAdmission } from './manager-admission.js';
import type {
  RawAdjudicationRecoveryResult,
  RawAdjudicationFailure,
  RawAdjudicationReplayOrigin,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { classifyRawFindingsMechanically } from './mechanical-classification.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { runRawAdjudicationBatches } from './raw-adjudication-batch-runner.js';
import {
  releaseRawAdjudicationReservations,
  reserveRawAdjudicationRecovery,
  type RawAdjudicationReservation,
} from './raw-adjudication-reservation.js';
import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from './raw-canonicalization.js';
import { collectLandedRawIds } from './manager-utils.js';
import type { FindingLedger, FindingObservation } from './types.js';
import { matchesProvisionalRecoveryOrigin } from './provisional-recovery-origin.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

function emptyIntake(): ReviewerIntakeResult {
  return {
    items: [],
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
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

function buildReplayIntake(input: {
  ledger: FindingLedger;
  runId: string;
  parentStepName: string;
  reservations: readonly RawAdjudicationReservation[];
}): {
  intake: ReviewerIntakeResult;
  origins: Map<string, RawAdjudicationReplayOrigin>;
  failures: Map<string, RawAdjudicationFailure>;
  reservationByRawId: Map<string, RawAdjudicationReservation>;
} {
  const intake = emptyIntake();
  const origins = new Map<string, RawAdjudicationReplayOrigin>();
  const failures = new Map<string, RawAdjudicationFailure>();
  const reservationByRawId = new Map<string, RawAdjudicationReservation>();
  for (const reservation of input.reservations) {
    const finding = input.ledger.findings.find((entry) => entry.id === reservation.provisionalFindingId);
    if (finding?.provisional === undefined) {
      throw new Error(`Reserved raw adjudication provisional "${reservation.provisionalFindingId}" no longer exists`);
    }
    if (!matchesProvisionalRecoveryOrigin(finding, reservation.recoveryOrigin)) {
      throw new Error(
        `Reserved raw adjudication provisional "${reservation.provisionalFindingId}" changed after reservation`,
      );
    }
    const attempt = reservation.attempt;
    const replayRawId = replayRawFindingId({
      runId: input.runId,
      parentStepName: input.parentStepName,
      provisionalFindingId: finding.id,
      attempt,
    });
    const sourceResult = {
      sourceRawFindingId: reservation.sourceRawFindingId,
      source: input.ledger.rawFindings.find(
        (raw) => raw.rawFindingId === reservation.sourceRawFindingId,
      ),
    };
    origins.set(replayRawId, {
      attemptId: reservation.attemptId,
      provisionalFindingId: finding.id,
      sourceRawFindingId: sourceResult.sourceRawFindingId,
      expectedHead: reservation.expectedHead,
      expectedProvisionalRevision: reservation.expectedRevision,
      expectedTargetIdentityHash: reservation.recoveryOrigin.expectedTargetIdentityHash,
      attempt,
      recoveryOrigin: reservation.recoveryOrigin,
    });
    reservationByRawId.set(replayRawId, reservation);
    if (sourceResult.source === undefined) {
      failures.set(replayRawId, {
        kind: 'source_missing',
        outcome: 'audit_only',
        reason: finding.provisional.sourceRawFindingIds.length === 0
          ? 'Raw adjudication recovery has no source raw finding id'
          : `Raw adjudication recovery references missing raw finding "${sourceResult.sourceRawFindingId}"`,
      });
      continue;
    }
    const reviewerStableKey = finding.provisional.recoveryReviewerStableKey;
    if (reviewerStableKey === undefined) {
      failures.set(replayRawId, {
        kind: 'reviewer_provenance_missing',
        outcome: 'audit_only',
        reason: 'Raw adjudication recovery has no reviewer provenance',
      });
      continue;
    }
    const source = sourceResult.source;
    const replayRaw = { ...source, rawFindingId: replayRawId };
    const candidate = candidateFromStoredRawFinding(replayRaw, reviewerStableKey);
    const canonical = canonicalizeReviewerRawFinding(candidate, { ledger: input.ledger }).canonical;
    const wire = toLedgerRawFinding(canonical);
    intake.items.push({ canonical, wire });
    if (wire.targetFindingId !== null
      && !input.ledger.findings.some((entry) => entry.id === wire.targetFindingId)) {
      failures.set(replayRawId, {
        kind: 'target_missing',
        outcome: 'stale',
        reason: `target finding "${wire.targetFindingId}" no longer exists`,
      });
    }
  }
  return { intake, origins, failures, reservationByRawId };
}

function admissionFailureReasons(
  intake: ReviewerIntakeResult,
  admittedRawIds: ReadonlySet<string>,
): Map<string, RawAdjudicationFailure> {
  const failures = new Map<string, RawAdjudicationFailure>();
  for (const item of intake.items) {
    if (!admittedRawIds.has(item.wire.rawFindingId)) {
      failures.set(item.wire.rawFindingId, {
        kind: 'admission_rejected',
        outcome: 'audit_only',
        reason: 'replay source evidence did not pass current admission',
      });
    }
  }
  return failures;
}

function retainPreparedRecovery(input: {
  prepared: ReturnType<typeof buildReplayIntake>;
  retainedRawIds: ReadonlySet<string>;
  store: RunFindingManagerForStepInput['ledgerStore'];
  allReservationTokens: ReadonlySet<string>;
}): {
  intake: ReviewerIntakeResult;
  origins: Map<string, RawAdjudicationReplayOrigin>;
  reservationTokens: Set<string>;
} {
  const origins = new Map(
    [...input.prepared.origins].filter(([rawFindingId]) => input.retainedRawIds.has(rawFindingId)),
  );
  const reservationTokens = new Set([...input.prepared.reservationByRawId]
    .filter(([rawFindingId]) => input.retainedRawIds.has(rawFindingId))
    .map(([, reservation]) => reservation.reservationToken));
  const releasedTokens = new Set(
    [...input.allReservationTokens].filter((token) => !reservationTokens.has(token)),
  );
  releaseRawAdjudicationReservations(input.store, releasedTokens);
  return {
    intake: {
      ...input.prepared.intake,
      items: input.prepared.intake.items.filter(
        (item) => input.retainedRawIds.has(item.wire.rawFindingId),
      ),
    },
    origins,
    reservationTokens,
  };
}

export async function runRawAdjudicationRecovery(input: {
  runInput: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  managerStep: AgentWorkflowStep;
  observation: FindingObservation;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): Promise<RawAdjudicationRecoveryResult> {
  const reservation = await reserveRawAdjudicationRecovery(
    input.runInput.ledgerStore,
    input.observation,
    input.reviewScopeSnapshotId,
  );
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
  observation: FindingObservation;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
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
      failures: prepared.failures,
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
    reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    runId: input.runInput.ledgerStore.runId,
    scopeIdentity: input.runInput.ledgerStore.ledgerIdentity,
    previousLedger: input.previousLedger,
    intake: prepared.intake,
    reviewScopeSnapshot: input.reviewScopeSnapshot,
    workflowTask: input.runInput.workflowTask,
  });
  const admittedRawIds = new Set(admission.cleanWire.map((wire) => wire.rawFindingId));
  const failures = new Map([
    ...prepared.failures,
    ...admissionFailureReasons(prepared.intake, admittedRawIds),
  ]);
  const adjudicableWire = admission.cleanWire.filter((wire) => !failures.has(wire.rawFindingId));
  const mechanical = classifyRawFindingsMechanically({
    previousLedger: input.previousLedger,
    rawFindings: adjudicableWire,
    excludedFindingIdsFromExactDuplicateIndex: new Set(
      [...prepared.origins.values()].map((origin) => origin.provisionalFindingId),
    ),
  });
  const mechanicalClean = assembleCleanManagerDecision({
    previousLedger: input.previousLedger,
    admission: {
      ...admission,
      cleanWire: adjudicableWire,
      cleanAdmitted: admission.cleanAdmitted.filter(
        (item) => !failures.has(item.wire.rawFindingId),
      ),
    },
    mechanical,
    decisions: undefined,
    initialInvalidAttempts: [],
    invalidLocationCandidateFindingIds: new Set(),
    dismissCandidateFindingIds: new Set(),
    priorStepResponseText: undefined,
  });
  let batchExecution = {
    output: mechanicalClean.managerOutput,
    failures: new Map<string, RawAdjudicationFailure>(),
    invalidAttempts: mechanicalClean.invalidAttempts,
    unsupportedRawFindingReports: mechanicalClean.unsupportedRawFindingReports,
    sentRawIds: new Set<string>(),
  };
  const retainedRawIds = new Set([
    ...failures.keys(),
    ...collectLandedRawIds(mechanical.output),
  ]);
  if (mechanical.residualRawFindings.length > 0) {
    input.runInput.ledgerStore.saveRawFindings(
      input.runInput.ledgerStore.runId,
      `${input.runInput.parentStep.name}-replay`,
      prepared.intake.items.map((item) => item.wire),
    );
    batchExecution = await runRawAdjudicationBatches({
      runInput: input.runInput,
      previousLedger: input.previousLedger,
      managerStep: input.managerStep,
      admission,
      mechanical,
      mechanicallyClassifiedCount: adjudicableWire.length - mechanical.residualRawFindings.length,
    });
    for (const [rawFindingId, failure] of batchExecution.failures) {
      failures.set(rawFindingId, failure);
    }
    for (const rawFindingId of batchExecution.sentRawIds) {
      retainedRawIds.add(rawFindingId);
    }
  }
  const retained = retainPreparedRecovery({
    prepared,
    retainedRawIds,
    store: input.runInput.ledgerStore,
    allReservationTokens: input.reservationTokens,
  });
  const cleanWireById = new Map(
    [...mechanicalClean.cleanWireById].filter(([rawFindingId]) => retainedRawIds.has(rawFindingId)),
  );
  const cleanCanonicalById = new Map(
    [...mechanicalClean.cleanCanonicalById].filter(([rawFindingId]) => retainedRawIds.has(rawFindingId)),
  );
  return {
    intake: retained.intake,
    output: batchExecution.output,
    origins: retained.origins,
    failures,
    capturedPreconditions,
    invalidAttempts: batchExecution.invalidAttempts,
    unsupportedRawFindingReports: batchExecution.unsupportedRawFindingReports,
    cleanWireById,
    cleanCanonicalById,
    reservationTokens: retained.reservationTokens,
  };
}
