import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeInterpretationCaseSnapshotId,
  computeInterpretationObservationDigest,
  computeInterpretationOriginSnapshotSetDigest,
} from '../../models/finding-contract-identity.js';
import { computeInterpretationAttemptId } from '../../models/finding-interpretation-identity.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import {
  appendRawFindingsWithCanonicalSnapshots,
} from './raw-canonical-snapshot.js';
import type {
  FindingLedger,
  FindingObservation,
  InterpretationAttempt,
  InterpretationCase,
} from './types.js';
import { planInterpretationOriginAttachments } from './interpretation-origin-attachment.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import {
  createInterpretationOriginBindings,
  originSnapshotDigestsByRawFindingId,
} from './interpretation-origin-binding.js';

export function latestInterpretationAttempt(
  ledger: FindingLedger,
  caseId: string,
  cohortId: string,
): InterpretationAttempt | undefined {
  return ledger.interpretationAttempts
    .filter((attempt) => attempt.caseId === caseId && attempt.cohortId === cohortId)
    .sort((left, right) => (
      left.attemptOrdinal - right.attemptOrdinal || left.retryOrdinal - right.retryOrdinal
    ))
    .at(-1);
}

export function nextInterpretationAttemptOrdinal(
  ledger: FindingLedger,
  lineageKey: string,
): number {
  return Math.max(
    0,
    ...ledger.interpretationAttempts
      .filter((attempt) => attempt.lineageKey === lineageKey)
      .map((attempt) => attempt.attemptOrdinal),
  ) + 1;
}

function nextAttempt(input: {
  ledger: FindingLedger;
  plannedCase: Extract<InterpretationCase, { kind: 'provider_case' }>;
  cohortId: string;
  caseSnapshotId: string;
  observation: FindingObservation;
}): InterpretationAttempt {
  const prior = latestInterpretationAttempt(
    input.ledger,
    input.plannedCase.caseId,
    input.cohortId,
  );
  const attemptOrdinal = prior?.attemptOrdinal
    ?? nextInterpretationAttemptOrdinal(input.ledger, input.plannedCase.lineageKey);
  const retryOrdinal = prior === undefined ? 0 as const : 1 as const;
  const rawFindingIds = input.plannedCase.members
    .map((member) => member.rawFindingId)
    .sort(compareBinaryStrings);
  return {
    attemptId: computeInterpretationAttemptId(
      input.caseSnapshotId,
      attemptOrdinal,
      retryOrdinal,
    ),
    caseSnapshotId: input.caseSnapshotId,
    caseId: input.plannedCase.caseId,
    cohortId: input.cohortId,
    lineageKey: input.plannedCase.lineageKey,
    semanticProjectionDigest: input.plannedCase.semanticProjectionDigest,
    attemptOrdinal,
    retryOrdinal,
    rawFindingIds,
    providerCallId: '',
    stage: 'started',
    startedAt: { ...input.observation },
  };
}

export function appendStartedInterpretationAttempt(input: {
  ledger: FindingLedger;
  plannedCase: Extract<InterpretationCase, { kind: 'provider_case' }>;
  items: readonly CanonicalIntakeItem[];
  observation: FindingObservation;
  roundIdentity: string;
  cohortId: string;
}): { ledger: FindingLedger; attempt: InterpretationAttempt } {
  const prior = latestInterpretationAttempt(
    input.ledger,
    input.plannedCase.caseId,
    input.cohortId,
  );
  if (prior !== undefined) {
    if (prior.stage !== 'interrupted') {
      throw new Error(`Interpretation attempt "${prior.attemptId}" is not retryable`);
    }
    if (prior.retryOrdinal >= 1) {
      throw new Error(`Interpretation attempt "${prior.attemptId}" exhausted its retry limit`);
    }
    const attempt = nextAttempt({
      ledger: input.ledger,
      plannedCase: input.plannedCase,
      cohortId: input.cohortId,
      caseSnapshotId: prior.caseSnapshotId,
      observation: input.observation,
    });
    return {
      ledger: {
        ...input.ledger,
        updatedAt: input.observation.timestamp,
        interpretationAttempts: [...input.ledger.interpretationAttempts, attempt],
        rawInterpretationOutcomes: input.ledger.rawInterpretationOutcomes.map((outcome) => (
          outcome.kind === 'pending_attempt' && outcome.attemptId === prior.attemptId
            ? {
                rawFindingId: outcome.rawFindingId,
                kind: 'pending_attempt' as const,
                attemptId: attempt.attemptId,
              }
            : outcome
        )),
      },
      attempt,
    };
  }
  const originPlans = planInterpretationOriginAttachments({
    ledger: input.ledger,
    freshItems: input.items,
    // 刻印側と同じ定義（予算計上外のラウンドは数えない）。直読みすると
    // 同一ラウンド保護が効かなくなる。
    currentRound: stopBudgetRoundsCompleted(input.ledger) + 1,
  });
  const originDigestsByRawFindingId = originSnapshotDigestsByRawFindingId(originPlans);
  const withRawSnapshots = appendRawFindingsWithCanonicalSnapshots({
    ledger: input.ledger,
    items: input.items,
    capturedAt: input.observation,
  });
  const observations = [...input.ledger.interpretationRawObservations];
  const newObservations = input.items.map((item) => {
    const snapshot = withRawSnapshots.rawCanonicalSnapshots.find(
      (snapshot) => snapshot.rawFindingId === item.canonical.rawFindingId,
    );
    if (snapshot === undefined) {
      throw new Error(`Interpretation raw finding "${item.canonical.rawFindingId}" has no canonical snapshot`);
    }
    const observationWithoutDigest = {
      rawFindingId: item.canonical.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      caseId: input.plannedCase.caseId,
      cohortId: input.cohortId,
      caseSnapshotId: '',
      lineageKey: input.plannedCase.lineageKey,
      semanticProjectionDigest: input.plannedCase.semanticProjectionDigest,
      originSnapshotDigests: (() => {
        const digests = originDigestsByRawFindingId.get(item.canonical.rawFindingId);
        if (digests === undefined) {
          throw new Error(
            `Interpretation origin plan is missing raw finding "${item.canonical.rawFindingId}"`,
          );
        }
        return digests;
      })(),
      recoveryOriginBindingIds: [],
    };
    return {
      ...observationWithoutDigest,
      observationDigest: computeInterpretationObservationDigest(observationWithoutDigest),
    };
  });
  const orderedObservations = [...newObservations].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
  ));
  const caseSnapshotWithoutId = {
    caseId: input.plannedCase.caseId,
    cohortId: input.cohortId,
    roundIdentity: input.roundIdentity,
    lineageKey: input.plannedCase.lineageKey,
    policyClass: input.plannedCase.policyClass,
    semanticProjectionDigest: input.plannedCase.semanticProjectionDigest,
    memberRawFindingIds: orderedObservations.map((observation) => observation.rawFindingId),
    memberObservationDigests: orderedObservations.map(
      (observation) => observation.observationDigest,
    ),
    originSnapshotSetDigest: computeInterpretationOriginSnapshotSetDigest(newObservations),
  };
  const caseSnapshotId = computeInterpretationCaseSnapshotId(caseSnapshotWithoutId);
  const caseSnapshot = {
    caseSnapshotId,
    ...caseSnapshotWithoutId,
    createdAt: structuredClone(input.observation),
  };
  const originBindings = createInterpretationOriginBindings({
    caseSnapshot,
    plans: originPlans,
    boundAt: input.observation,
  });
  const bindingIdsByRawFindingId = new Map<string, string[]>();
  for (const binding of originBindings) {
    bindingIdsByRawFindingId.set(binding.observationRawFindingId, [
      ...(bindingIdsByRawFindingId.get(binding.observationRawFindingId) ?? []),
      binding.bindingId,
    ].sort(compareBinaryStrings));
  }
  const attempt = nextAttempt({
    ledger: input.ledger,
    plannedCase: input.plannedCase,
    cohortId: input.cohortId,
    caseSnapshotId,
    observation: input.observation,
  });
  const completedObservations = newObservations.map((observation) => ({
    ...observation,
    caseSnapshotId,
    recoveryOriginBindingIds:
      bindingIdsByRawFindingId.get(observation.rawFindingId) ?? [],
  }));
  const outcomes = [...input.ledger.rawInterpretationOutcomes];
  for (const observation of completedObservations) {
    if (observations.some((candidate) => candidate.rawFindingId === observation.rawFindingId)) {
      throw new Error(`Interpretation observation for "${observation.rawFindingId}" already exists`);
    }
    observations.push(observation);
    outcomes.push({
      rawFindingId: observation.rawFindingId,
      kind: 'pending_attempt',
      attemptId: attempt.attemptId,
    });
  }
  return {
    ledger: {
      ...withRawSnapshots,
      updatedAt: input.observation.timestamp,
      interpretationCaseSnapshots: [
        ...input.ledger.interpretationCaseSnapshots,
        caseSnapshot,
      ],
      interpretationRawObservations: observations,
      interpretationRecoveryOriginBindings: [
        ...input.ledger.interpretationRecoveryOriginBindings,
        ...originBindings,
      ],
      interpretationAttempts: [...input.ledger.interpretationAttempts, attempt],
      rawInterpretationOutcomes: outcomes,
    },
    attempt,
  };
}
