import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { findingEvidenceRecordIdentityViolation } from '../../models/finding-evidence-record.js';
import { assertFindingLifecycleAuthorityInvariant } from '../../models/finding-lifecycle-invariants.js';
import {
  reviewerAnomalySettlementEligibilityViolation,
  type ReviewerAnomalySettlementProjection,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
export { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type {
  CanonicalRawFindingProvenance,
  FindingEvidenceRecord,
  FindingContractLedgerRegistries,
  FindingLedger,
  FindingManagerReportPublication,
  InterpretationAttempt,
  InterpretationRawObservation,
  RawFinding,
  RawInterpretationOutcome,
  ReviewerAnomalyEntry,
} from './types.js';
import { addRoundMarker } from './round-marker.js';
import { compareRfc3339Timestamps } from '../../models/rfc3339.js';

const CANONICAL_RAW_INTEGRITY_VERSION = 1;

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface CanonicalRawIntegrityInput {
  canonicalWire: RawFinding;
  provenance: CanonicalRawFindingProvenance;
  reviewerStableKey: string;
  lineageKey: string;
  claimIdentityHash: string;
}

export function computeCanonicalRawIntegrityDigest(
  input: CanonicalRawIntegrityInput,
): string {
  return sha256Canonical({
    version: CANONICAL_RAW_INTEGRITY_VERSION,
    canonicalWire: input.canonicalWire,
    provenance: input.provenance,
    stableIdentity: {
      rawFindingId: input.canonicalWire.rawFindingId,
      reviewerStableKey: input.reviewerStableKey,
      lineageKey: input.lineageKey,
      claimIdentityHash: input.claimIdentityHash,
    },
  });
}

export function assertEvidenceRecordsAppendOnly(
  current: readonly FindingEvidenceRecord[],
  next: readonly FindingEvidenceRecord[],
): void {
  for (const record of next) {
    const violation = findingEvidenceRecordIdentityViolation(record);
    if (violation !== undefined) {
      throw new Error(violation);
    }
  }
  const nextById = new Map(next.map((record) => [record.evidenceId, record]));
  if (nextById.size !== next.length) {
    throw new Error('Duplicate evidence record ids are not allowed');
  }
  for (const existing of current) {
    const candidate = nextById.get(existing.evidenceId);
    if (candidate === undefined) {
      throw new Error(`Evidence record "${existing.evidenceId}" cannot be removed`);
    }
    if (sha256Canonical(existing) !== sha256Canonical(candidate)) {
      throw new Error(`Evidence record "${existing.evidenceId}" cannot be replaced`);
    }
  }
}

export function assertRawFindingsAppendOnly(
  current: readonly RawFinding[],
  next: readonly RawFinding[],
): void {
  const currentById = uniqueRawFindingsById(current, 'current');
  const nextById = uniqueRawFindingsById(next, 'next');
  for (const [rawFindingId, existing] of currentById) {
    const candidate = nextById.get(rawFindingId);
    if (candidate === undefined) {
      throw new Error(`Raw finding "${rawFindingId}" cannot be removed from the append-only ledger`);
    }
    if (
      computeRawFindingIntegrityDigest(existing)
      !== computeRawFindingIntegrityDigest(candidate)
    ) {
      throw new Error(`Raw finding "${rawFindingId}" cannot be replaced with different content`);
    }
  }
}

/** File/SQLite/resume reconstruction が共有する ledger append-only 境界。 */
export function assertFindingLedgerAppendOnlyProjection(
  ledger: FindingLedger,
): void {
  assertFindingLifecycleAuthorityInvariant(ledger);
  assertRawFindingsAppendOnly([], ledger.rawFindings);
  assertEvidenceRecordsAppendOnly([], ledger.evidenceRecords);
  assertCanonicalBindingSetAppendOnly([], ledger.evidenceBindings);
  assertInterpretationCaseTransition(
    {
      interpretationRawObservations: [],
      interpretationAttempts: [],
      rawInterpretationOutcomes: [],
      rawCanonicalSnapshots: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
    },
    ledger,
  );
  const completed = ledger.pendingManagerCommit?.completed;
  if (completed !== undefined) {
    assertRawFindingsAppendOnly(ledger.rawFindings, completed.rawFindings);
    assertEvidenceRecordsAppendOnly(
      ledger.evidenceRecords,
      completed.evidenceRecords,
    );
    assertCanonicalBindingSetAppendOnly(
      ledger.evidenceBindings,
      completed.evidenceBindings,
    );
    assertInterpretationCaseTransition(ledger, completed);
    assertContractRegistryTransitions(ledger, completed);
    assertRegistryPrefix(
      ledger.lifecycleReservations,
      completed.lifecycleReservations,
      'reservationId',
      'Lifecycle reservation',
    );
    assertRegistryPrefix(
      ledger.lifecycleEvents,
      completed.lifecycleEvents,
      'eventId',
      'Lifecycle event',
    );
    assertReviewerAnomalySettlementTransition(ledger, completed);
    assertFindingLifecycleAuthorityInvariant(completed);
  }
}

function assertReviewerAnomalySettlementTransition(
  current: ReviewerAnomalySettlementProjection & Pick<FindingLedger, 'reviewerAnomalies'>,
  next: ReviewerAnomalySettlementProjection & Pick<FindingLedger, 'reviewerAnomalies'>,
): void {
  const nextAnomalies = next.reviewerAnomalies ?? [];
  const nextById = new Map(
    nextAnomalies.map((anomaly) => [anomaly.id, anomaly]),
  );
  if (nextById.size !== nextAnomalies.length) {
    throw new Error('Duplicate reviewer anomaly ids are not allowed');
  }
  for (const existing of current.reviewerAnomalies ?? []) {
    const candidate = nextById.get(existing.id);
    if (candidate === undefined) {
      throw new Error(`Reviewer anomaly "${existing.id}" cannot be removed`);
    }
    assertReviewerAnomalyAppendOnlyUpdate(existing, candidate);
    if (
      existing.settlement !== undefined
      && (
        candidate.settlement === undefined
        || !sameCanonicalValue(existing.settlement, candidate.settlement)
      )
    ) {
      throw new Error(`Reviewer anomaly "${existing.id}" settlement cannot be removed or replaced`);
    }
  }
  for (const anomaly of nextAnomalies) {
    const previousSettlement = (current.reviewerAnomalies ?? [])
      .find((candidate) => candidate.id === anomaly.id)?.settlement;
    if (anomaly.settlement !== undefined) {
      const violation = reviewerAnomalySettlementEligibilityViolation({
        projection: next,
        anomaly,
        settlement: anomaly.settlement,
        sourceHead: previousSettlement === undefined
          ? { kind: 'ledger', ledger: current }
          : { kind: 'projection' },
        workflowTaskDigest: null,
      });
      if (violation !== undefined) {
        throw new Error(
          `Reviewer anomaly "${anomaly.id}" has an ineligible settlement: ${violation}`,
        );
      }
    }
  }
}

function assertReviewerAnomalyAppendOnlyUpdate(
  current: ReviewerAnomalyEntry,
  next: ReviewerAnomalyEntry,
): void {
  const currentIdentity = {
    id: current.id,
    kind: current.kind,
    stableKey: current.stableKey,
    lineageKey: current.lineageKey,
    title: current.title,
    firstObserved: current.firstObserved,
  };
  const nextIdentity = {
    id: next.id,
    kind: next.kind,
    stableKey: next.stableKey,
    lineageKey: next.lineageKey,
    title: next.title,
    firstObserved: next.firstObserved,
  };
  if (!sameCanonicalValue(currentIdentity, nextIdentity)) {
    throw new Error(`Reviewer anomaly "${current.id}" identity cannot be replaced`);
  }
  assertStringSetContains(
    current.sourceRawFindingIds,
    next.sourceRawFindingIds,
    `Reviewer anomaly "${current.id}" source raw findings`,
  );
  assertStringSetContains(
    current.sourceIntakeIds,
    next.sourceIntakeIds,
    `Reviewer anomaly "${current.id}" source intake ids`,
  );
  assertStringSetContains(
    current.reviewers,
    next.reviewers,
    `Reviewer anomaly "${current.id}" reviewers`,
  );
  if (next.occurrences < current.occurrences) {
    throw new Error(`Reviewer anomaly "${current.id}" occurrences cannot decrease`);
  }
  if (
    current.promotedFindingId !== undefined
    && current.promotedFindingId !== next.promotedFindingId
  ) {
    throw new Error(`Reviewer anomaly "${current.id}" promotion cannot be removed or replaced`);
  }
  if (current.settlement !== undefined) {
    const currentEpisode = { ...current, settlement: undefined };
    const nextEpisode = { ...next, settlement: undefined };
    if (!sameCanonicalValue(currentEpisode, nextEpisode)) {
      throw new Error(`Settled reviewer anomaly "${current.id}" episode cannot be changed`);
    }
  }
}

function assertStringSetContains(
  current: readonly string[],
  next: readonly string[],
  label: string,
): void {
  const nextValues = new Set(next);
  if (current.some((value) => !nextValues.has(value))) {
    throw new Error(`${label} cannot be removed`);
  }
}

function assertCanonicalBindingSetAppendOnly(
  current: readonly FindingLedger['evidenceBindings'][number][],
  next: readonly FindingLedger['evidenceBindings'][number][],
): void {
  const sorted = [...next].sort((left, right) => (
    compareBinaryStrings(left.bindingId, right.bindingId)
  ));
  if (sorted.some((binding, index) => binding.bindingId !== next[index]?.bindingId)) {
    throw new Error('Evidence binding registry must be a canonical binary-sorted set');
  }
  const nextById = new Map(next.map((binding) => [binding.bindingId, binding]));
  if (nextById.size !== next.length) {
    throw new Error('Evidence binding registry contains duplicate ids');
  }
  for (const existing of current) {
    const candidate = nextById.get(existing.bindingId);
    if (candidate === undefined) {
      throw new Error(`Evidence binding "${existing.bindingId}" cannot be removed`);
    }
    if (sha256Canonical(existing) !== sha256Canonical(candidate)) {
      throw new Error(`Evidence binding "${existing.bindingId}" cannot be replaced`);
    }
  }
}

function assertRegistryPrefix<
  IdKey extends string,
  RecordValue extends Record<IdKey, string>,
>(
  current: readonly RecordValue[],
  next: readonly RecordValue[],
  idKey: IdKey,
  label: string,
): void {
  if (next.length < current.length) {
    throw new Error(`${label} registry prefix cannot be removed`);
  }
  current.forEach((existing, index) => {
    const candidate = next[index];
    if (
      candidate === undefined
      || existing[idKey] !== candidate[idKey]
      || sha256Canonical(existing) !== sha256Canonical(candidate)
    ) {
      throw new Error(`${label} registry prefix changed at index ${index}`);
    }
  });
}

function assertStatefulRegistryTransition<Value>(input: {
  current: readonly Value[];
  next: readonly Value[];
  idOf: (value: Value) => string;
  stateOf: (value: Value) => string;
  identityOf: (value: Value) => unknown;
  canTransition: (current: string, next: string) => boolean;
  initialState: string;
  label: string;
}): void {
  if (input.next.length < input.current.length) {
    throw new Error(`${input.label} registry prefix cannot be removed`);
  }
  input.current.forEach((existing, index) => {
    const candidate = input.next[index];
    if (candidate === undefined || input.idOf(candidate) !== input.idOf(existing)) {
      throw new Error(`${input.label} registry prefix changed at index ${index}`);
    }
    const existingState = input.stateOf(existing);
    const candidateState = input.stateOf(candidate);
    if (
      !sameCanonicalValue(input.identityOf(existing), input.identityOf(candidate))
      || !input.canTransition(existingState, candidateState)
    ) {
      throw new Error(
        `${input.label} "${input.idOf(existing)}" cannot transition from ${existingState} to ${candidateState}`,
      );
    }
    if (existingState === candidateState && !sameCanonicalValue(existing, candidate)) {
      throw new Error(`${input.label} "${input.idOf(existing)}" cannot be replaced`);
    }
  });
  input.next.slice(input.current.length).forEach((value) => {
    if (input.stateOf(value) !== input.initialState) {
      throw new Error(
        `New ${input.label.toLowerCase()} "${input.idOf(value)}" must begin in ${input.initialState}`,
      );
    }
  });
}

function stateIdentity(value: object, stateFields: readonly string[]): unknown {
  const identity = { ...value } as Record<string, unknown>;
  for (const field of stateFields) {
    delete identity[field];
  }
  return identity;
}

function assertContractRegistryTransitions(
  current: FindingContractLedgerRegistries,
  next: FindingContractLedgerRegistries,
): void {
  assertRegistryPrefix(
    current.rawCanonicalSnapshots,
    next.rawCanonicalSnapshots,
    'rawCanonicalSnapshotId',
    'Raw canonical snapshot',
  );
  assertRegistryPrefix(
    current.conflictRawClaimLandings,
    next.conflictRawClaimLandings,
    'rawClaimLandingId',
    'Conflict raw claim landing',
  );
  assertRegistryPrefix(
    current.conflictAdjudicationSnapshots,
    next.conflictAdjudicationSnapshots,
    'conflictSnapshotId',
    'Conflict adjudication snapshot',
  );
  assertRegistryPrefix(
    current.conflictAdjudicationEpisodes,
    next.conflictAdjudicationEpisodes,
    'episodeId',
    'Conflict adjudication episode',
  );
  assertRegistryPrefix(
    current.conflictClaimSettlements,
    next.conflictClaimSettlements,
    'settlementId',
    'Conflict claim settlement',
  );
  assertRegistryPrefix(
    current.provisionalConflictNormalizationSnapshots,
    next.provisionalConflictNormalizationSnapshots,
    'normalizationSnapshotId',
    'Provisional conflict normalization snapshot',
  );
  assertRegistryPrefix(
    current.provisionalConflictNormalizations,
    next.provisionalConflictNormalizations,
    'normalizationId',
    'Provisional conflict normalization',
  );
  assertRegistryPrefix(
    current.interpretationCaseSnapshots,
    next.interpretationCaseSnapshots,
    'caseSnapshotId',
    'Interpretation case snapshot',
  );
  assertRegistryPrefix(
    current.interpretationRecoveryOriginBindings,
    next.interpretationRecoveryOriginBindings,
    'bindingId',
    'Interpretation origin binding',
  );
  assertRegistryPrefix(
    current.interpretationRecoveryOriginSettlements,
    next.interpretationRecoveryOriginSettlements,
    'settlementId',
    'Interpretation origin settlement',
  );
  assertRegistryPrefix(
    current.findingManagerProviderBudgetScopes,
    next.findingManagerProviderBudgetScopes,
    'budgetScopeId',
    'Finding manager provider budget scope',
  );
  assertRegistryPrefix(
    current.findingScopeBindings,
    next.findingScopeBindings,
    'bindingId',
    'Finding scope binding',
  );
  assertRegistryPrefix(
    current.terminalAdjudicationRounds,
    next.terminalAdjudicationRounds,
    'selectionId',
    'Terminal adjudication round',
  );
  assertRegistryPrefix(
    current.terminalAdjudicationEpisodes,
    next.terminalAdjudicationEpisodes,
    'episodeId',
    'Terminal adjudication episode',
  );
  assertRegistryPrefix(
    current.terminalAdjudicationSettlements,
    next.terminalAdjudicationSettlements,
    'settlementId',
    'Terminal adjudication settlement',
  );
  assertStatefulRegistryTransition({
    current: current.findingManagerProviderCalls,
    next: next.findingManagerProviderCalls,
    idOf: (call) => call.providerCallId,
    stateOf: (call) => call.state,
    identityOf: (call) => stateIdentity(call, [
      'state',
      'dispatchedAt',
      'settledAt',
      'resultKind',
      'failurePhase',
      'responseDigest',
      'charge',
    ]),
    canTransition: (from, to) => from === to
      || (from === 'reserved' && to === 'dispatched')
      || (from === 'dispatched' && to === 'settled'),
    initialState: 'reserved',
    label: 'Finding manager provider call',
  });
  const attemptStateFields = [
    'stage',
    'interruptedAt',
    'completedAt',
    'appliedAt',
    'reason',
    'proposal',
    'proposalDigest',
    'result',
    'verificationDigest',
    'settlementId',
    'claimSettlementIds',
    'lifecycleEventIds',
  ] as const;
  const canAttemptTransition = (from: string, to: string): boolean => from === to
    || (from === 'started' && ['interrupted', 'proposed', 'applied', 'completed'].includes(to))
    || (from === 'proposed' && ['applied', 'completed'].includes(to));
  assertStatefulRegistryTransition({
    current: current.terminalAdjudicationAttempts,
    next: next.terminalAdjudicationAttempts,
    idOf: (attempt) => attempt.attemptId,
    stateOf: (attempt) => attempt.stage,
    identityOf: (attempt) => stateIdentity(attempt, attemptStateFields),
    canTransition: canAttemptTransition,
    initialState: 'started',
    label: 'Terminal adjudication attempt',
  });
  assertStatefulRegistryTransition({
    current: current.conflictAdjudicationAttempts,
    next: next.conflictAdjudicationAttempts,
    idOf: (attempt) => attempt.attemptId,
    stateOf: (attempt) => attempt.stage,
    identityOf: (attempt) => stateIdentity(attempt, attemptStateFields),
    canTransition: canAttemptTransition,
    initialState: 'started',
    label: 'Conflict adjudication attempt',
  });
}

interface InterpretationCaseProjection {
  interpretationRawObservations: readonly InterpretationRawObservation[];
  interpretationAttempts: readonly InterpretationAttempt[];
  rawInterpretationOutcomes: readonly RawInterpretationOutcome[];
  rawCanonicalSnapshots: FindingLedger['rawCanonicalSnapshots'];
  lifecycleReservations: FindingLedger['lifecycleReservations'];
  lifecycleEvents: FindingLedger['lifecycleEvents'];
}

function assertInterpretationCaseTransition(
  current: InterpretationCaseProjection,
  next: InterpretationCaseProjection,
): void {
  assertRegistryPrefix(
    current.interpretationRawObservations,
    next.interpretationRawObservations,
    'observationDigest',
    'Interpretation observation',
  );

  if (next.interpretationAttempts.length < current.interpretationAttempts.length) {
    throw new Error('Interpretation attempt registry prefix cannot be removed');
  }
  current.interpretationAttempts.forEach((existing, index) => {
    const candidate = next.interpretationAttempts[index];
    if (candidate === undefined || candidate.attemptId !== existing.attemptId) {
      throw new Error(`Interpretation attempt registry prefix changed at index ${index}`);
    }
    const existingIdentity = {
      attemptId: existing.attemptId,
      caseSnapshotId: existing.caseSnapshotId,
      caseId: existing.caseId,
      cohortId: existing.cohortId,
      lineageKey: existing.lineageKey,
      semanticProjectionDigest: existing.semanticProjectionDigest,
      attemptOrdinal: existing.attemptOrdinal,
      retryOrdinal: existing.retryOrdinal,
      rawFindingIds: existing.rawFindingIds,
      providerCallId: existing.providerCallId,
      startedAt: existing.startedAt,
    };
    const candidateIdentity = {
      attemptId: candidate.attemptId,
      caseSnapshotId: candidate.caseSnapshotId,
      caseId: candidate.caseId,
      cohortId: candidate.cohortId,
      lineageKey: candidate.lineageKey,
      semanticProjectionDigest: candidate.semanticProjectionDigest,
      attemptOrdinal: candidate.attemptOrdinal,
      retryOrdinal: candidate.retryOrdinal,
      rawFindingIds: candidate.rawFindingIds,
      providerCallId: candidate.providerCallId,
      startedAt: candidate.startedAt,
    };
    if (!sameCanonicalValue(existingIdentity, candidateIdentity)) {
      throw new Error(`Interpretation attempt "${existing.attemptId}" identity cannot be replaced`);
    }
    const allowed = existing.stage === candidate.stage
      || (existing.stage === 'started'
        && (candidate.stage === 'interrupted' || candidate.stage === 'completed'))
      || (existing.stage === 'completed' && candidate.stage === 'applied');
    if (!allowed) {
      throw new Error(
        `Interpretation attempt "${existing.attemptId}" cannot transition from ${existing.stage} to ${candidate.stage}`,
      );
    }
    if (
      (existing.stage === 'completed' || existing.stage === 'applied')
      && (
        candidate.stage === 'started'
        || candidate.stage === 'interrupted'
        || !sameCanonicalValue(existing.decision, candidate.decision)
      )
    ) {
      throw new Error(`Interpretation attempt "${existing.attemptId}" decision cannot be replaced`);
    }
    if (
      existing.stage === 'interrupted'
      && (
        candidate.stage !== 'interrupted'
        || !sameCanonicalValue(existing.interruptedAt, candidate.interruptedAt)
      )
    ) {
      throw new Error(`Interpretation attempt "${existing.attemptId}" interruption cannot be replaced`);
    }
    if (
      (existing.stage === 'completed' || existing.stage === 'applied')
      && (
        (candidate.stage !== 'completed' && candidate.stage !== 'applied')
        || !sameCanonicalValue(existing.completedAt, candidate.completedAt)
      )
    ) {
      throw new Error(`Interpretation attempt "${existing.attemptId}" completion cannot be replaced`);
    }
    if (
      existing.stage === 'applied'
      && (
        candidate.stage !== 'applied'
        || !sameCanonicalValue(existing.appliedAt, candidate.appliedAt)
        || !sameCanonicalValue(existing.application, candidate.application)
      )
    ) {
      throw new Error(`Interpretation attempt "${existing.attemptId}" application cannot be replaced`);
    }
  });

  const currentAttempts = new Map(
    current.interpretationAttempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const nextAttempts = new Map(
    next.interpretationAttempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const nextOutcomes = new Map(
    next.rawInterpretationOutcomes.map((outcome) => [outcome.rawFindingId, outcome]),
  );
  const isInterruptedLanding = (
    attempt: InterpretationAttempt | undefined,
    outcome: RawInterpretationOutcome | undefined,
  ): boolean => {
    if (attempt?.stage !== 'interrupted' || outcome?.kind !== 'provisional') {
      return false;
    }
    const event = next.lifecycleEvents.find(
      (candidate) => candidate.eventId === outcome.landingEventId,
    );
    const reservation = event === undefined
      ? undefined
      : next.lifecycleReservations.find(
          (candidate) => candidate.mutationId === event.mutationId,
        );
    if (reservation?.authority.kind !== 'interpretation_unreserved_landing') {
      return false;
    }
    if (event === undefined) {
      return false;
    }
    const authority = reservation.authority;
    const expectedSnapshotIds = attempt.rawFindingIds.map((rawFindingId) => (
      next.rawCanonicalSnapshots.find(
        (snapshot) => snapshot.rawFindingId === rawFindingId,
      )?.rawCanonicalSnapshotId
    ));
    return expectedSnapshotIds.every((snapshotId): snapshotId is string => snapshotId !== undefined)
      && authority.rawFindingIds.length === attempt.rawFindingIds.length
      && authority.rawFindingIds.every((rawFindingId, index) => (
        rawFindingId === attempt.rawFindingIds[index]
      ))
      && authority.rawCanonicalSnapshotIds.length === expectedSnapshotIds.length
      && authority.rawCanonicalSnapshotIds.every((snapshotId, index) => (
        snapshotId === [...expectedSnapshotIds].sort(compareBinaryStrings)[index]
      ))
      && event.transitions.some((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === outcome.provisionalFindingId
      ));
  };
  for (const existing of current.rawInterpretationOutcomes) {
    const candidate = nextOutcomes.get(existing.rawFindingId);
    if (candidate === undefined) {
      throw new Error(`Interpretation outcome for "${existing.rawFindingId}" cannot be removed`);
    }
    const replaceable = existing.kind === 'pending_attempt';
    if (!replaceable && !sameCanonicalValue(existing, candidate)) {
      throw new Error(`Terminal interpretation outcome for "${existing.rawFindingId}" cannot be replaced`);
    }
    if (
      existing.kind === 'pending_attempt'
      && candidate.kind === 'pending_attempt'
      && candidate.attemptId !== existing.attemptId
    ) {
      const currentAttempt = currentAttempts.get(existing.attemptId);
      const interruptedAttempt = nextAttempts.get(existing.attemptId);
      const replacementAttempt = nextAttempts.get(candidate.attemptId);
      if (
        (currentAttempt?.stage !== 'started' && currentAttempt?.stage !== 'interrupted')
        || interruptedAttempt?.stage !== 'interrupted'
        || currentAttempts.has(candidate.attemptId)
        || replacementAttempt?.stage !== 'started'
        || replacementAttempt.caseId !== currentAttempt.caseId
        || replacementAttempt.cohortId !== currentAttempt.cohortId
        || replacementAttempt.attemptOrdinal !== currentAttempt.attemptOrdinal
        || replacementAttempt.retryOrdinal !== currentAttempt.retryOrdinal + 1
        || compareRfc3339Timestamps(
          interruptedAttempt.interruptedAt.timestamp,
          replacementAttempt.startedAt.timestamp,
        ) > 0
      ) {
        throw new Error(
          `Pending interpretation outcome for "${existing.rawFindingId}" may change owner only with an atomic started-to-interrupted retry handoff`,
        );
      }
    }
    if (
      existing.kind === 'pending_attempt'
      && candidate.kind !== 'pending_attempt'
    ) {
      const currentAttempt = currentAttempts.get(existing.attemptId);
      const nextAttempt = nextAttempts.get(existing.attemptId);
      const appliedCompletion = currentAttempt?.stage === 'completed'
        && nextAttempt?.stage === 'applied';
      const interruptedLanding = currentAttempt?.stage === 'started'
        && isInterruptedLanding(nextAttempt, candidate);
      if (!appliedCompletion && !interruptedLanding) {
        throw new Error(
          `Terminal interpretation outcome for "${existing.rawFindingId}" requires an applied completion or bounded interrupted landing in the same mutation`,
        );
      }
    }
  }

  for (const existingAttempt of current.interpretationAttempts) {
    if (existingAttempt.stage !== 'started') {
      continue;
    }
    const candidateAttempt = nextAttempts.get(existingAttempt.attemptId);
    if (candidateAttempt?.stage !== 'interrupted') {
      continue;
    }
    for (const rawFindingId of existingAttempt.rawFindingIds) {
      const currentOutcome = current.rawInterpretationOutcomes.find(
        (outcome) => outcome.rawFindingId === rawFindingId,
      );
      const nextOutcome = nextOutcomes.get(rawFindingId);
      if (isInterruptedLanding(candidateAttempt, nextOutcome)) {
        continue;
      }
      if (
        currentOutcome?.kind !== 'pending_attempt'
        || currentOutcome.attemptId !== existingAttempt.attemptId
        || nextOutcome?.kind !== 'pending_attempt'
        || nextOutcome.attemptId === existingAttempt.attemptId
      ) {
        throw new Error(
          `Interrupted interpretation attempt "${existingAttempt.attemptId}" requires every owned raw outcome to transfer atomically`,
        );
      }
    }
  }

  for (const existingAttempt of current.interpretationAttempts) {
    if (existingAttempt.stage !== 'completed') {
      continue;
    }
    const candidateAttempt = nextAttempts.get(existingAttempt.attemptId);
    if (candidateAttempt?.stage !== 'applied') {
      continue;
    }
    for (const rawFindingId of existingAttempt.rawFindingIds) {
      const currentOutcome = current.rawInterpretationOutcomes.find(
        (outcome) => outcome.rawFindingId === rawFindingId,
      );
      const nextOutcome = nextOutcomes.get(rawFindingId);
      if (
        currentOutcome?.kind !== 'pending_attempt'
        || currentOutcome.attemptId !== existingAttempt.attemptId
        || nextOutcome === undefined
        || nextOutcome.kind === 'pending_attempt'
      ) {
        throw new Error(
          `Applied interpretation attempt "${existingAttempt.attemptId}" requires every owned pending outcome to become terminal in the same mutation`,
        );
      }
    }
  }
}

export type FindingLedgerPendingTransitionKind =
  | 'ordinary'
  | 'stage'
  | 'unchanged'
  | 'rebind'
  | 'finalize';

function withoutStorageUpdatedAt(
  ledger: FindingLedger,
): Omit<FindingLedger, 'updatedAt'> {
  const projection = { ...ledger };
  delete (projection as Partial<FindingLedger>).updatedAt;
  return projection;
}

function withoutPendingAndStorageUpdatedAt(
  ledger: FindingLedger,
): Omit<FindingLedger, 'updatedAt' | 'pendingManagerCommit'> {
  const projection = { ...ledger };
  delete projection.pendingManagerCommit;
  delete (projection as Partial<FindingLedger>).updatedAt;
  return projection;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const detachAliases = (value: unknown): unknown => (
    JSON.parse(JSON.stringify(value)) as unknown
  );
  return canonicalJson(detachAliases(left)) === canonicalJson(detachAliases(right));
}

function samePublicationIntentIgnoringDestination(
  current: FindingManagerReportPublication,
  next: FindingManagerReportPublication,
): boolean {
  const currentIntent = { ...current };
  const nextIntent = { ...next };
  delete (currentIntent as Partial<typeof currentIntent>).destinationRunId;
  delete (nextIntent as Partial<typeof nextIntent>).destinationRunId;
  return sameCanonicalValue(currentIntent, nextIntent);
}

function assertCanonicalStageRoundMarker(
  current: FindingLedger,
  next: FindingLedger,
): void {
  const pending = next.pendingManagerCommit!;
  const currentMarkers = current.stopBudget?.roundMarkers ?? [];
  const completedMarkers = pending.completed.stopBudget?.roundMarkers ?? [];
  const expectedMarkers = addRoundMarker(currentMarkers, pending.roundMarker);
  if (
    currentMarkers.includes(pending.roundMarker)
    || !sameCanonicalValue(completedMarkers, expectedMarkers)
  ) {
    throw new Error(
      `Pending manager commit "${pending.publication.publicationId}" is not a canonical stage transition`,
    );
  }
}

export function assertFindingLedgerAppendOnlyTransition(
  current: FindingLedger,
  next: FindingLedger,
): FindingLedgerPendingTransitionKind {
  assertFindingLedgerAppendOnlyProjection(current);
  assertFindingLedgerAppendOnlyProjection(next);
  assertRawFindingsAppendOnly(current.rawFindings, next.rawFindings);
  assertEvidenceRecordsAppendOnly(current.evidenceRecords, next.evidenceRecords);
  assertCanonicalBindingSetAppendOnly(
    current.evidenceBindings,
    next.evidenceBindings,
  );
  assertRegistryPrefix(
    current.lifecycleReservations,
    next.lifecycleReservations,
    'reservationId',
    'Lifecycle reservation',
  );
  assertRegistryPrefix(
    current.lifecycleEvents,
    next.lifecycleEvents,
    'eventId',
    'Lifecycle event',
  );
  assertContractRegistryTransitions(current, next);
  assertReviewerAnomalySettlementTransition(current, next);
  next.interpretationAttempts
    .slice(current.interpretationAttempts.length)
    .forEach((attempt) => {
      if (attempt.stage !== 'started') {
        throw new Error(`New interpretation attempt "${attempt.attemptId}" must begin in started stage`);
      }
      for (const rawFindingId of attempt.rawFindingIds) {
        const outcome = next.rawInterpretationOutcomes.find(
          (candidate) => candidate.rawFindingId === rawFindingId,
        );
        if (
          outcome?.kind !== 'pending_attempt'
          || outcome.attemptId !== attempt.attemptId
        ) {
          throw new Error(
            `New interpretation attempt "${attempt.attemptId}" must own every raw outcome`,
          );
        }
      }
    });
  assertInterpretationCaseTransition(current, next);

  const pending = current.pendingManagerCommit;
  const nextPending = next.pendingManagerCommit;
  if (pending === undefined && nextPending === undefined) {
    return 'ordinary';
  }
  if (pending === undefined) {
    if (
      !sameCanonicalValue(
        withoutPendingAndStorageUpdatedAt(current),
        withoutPendingAndStorageUpdatedAt(next),
      )
    ) {
      throw new Error(
        `Pending manager commit "${nextPending!.publication.publicationId}" changed the staged top-level projection`,
      );
    }
    assertCanonicalStageRoundMarker(current, next);
    return 'stage';
  }
  if (nextPending === undefined) {
    const expectedFinalized: FindingLedger = {
      workflowName: current.workflowName,
      ...pending.completed,
    };
    if (
      !sameCanonicalValue(
        withoutStorageUpdatedAt(expectedFinalized),
        withoutStorageUpdatedAt(next),
      )
    ) {
      throw new Error(
        `Pending manager commit "${pending.publication.publicationId}" changes require the dedicated finalization API `
        + 'or authorized rebind API; finalization does not match its completed projection',
      );
    }
    return 'finalize';
  }
  if (
    !sameCanonicalValue(
      withoutPendingAndStorageUpdatedAt(current),
      withoutPendingAndStorageUpdatedAt(next),
    )
    || pending.roundMarker !== nextPending.roundMarker
    || !sameCanonicalValue(pending.completed, nextPending.completed)
    || !samePublicationIntentIgnoringDestination(
      pending.publication,
      nextPending.publication,
    )
  ) {
    throw new Error(
      `Pending manager commit "${pending.publication.publicationId}" changes require the dedicated finalization API `
      + 'or authorized rebind API; the pending commit was replaced or mutated',
    );
  }
  return pending.publication.destinationRunId
    === nextPending.publication.destinationRunId
    ? 'unchanged'
    : 'rebind';
}

function uniqueRawFindingsById(
  rawFindings: readonly RawFinding[],
  label: string,
): Map<string, RawFinding> {
  const byId = new Map<string, RawFinding>();
  for (const rawFinding of rawFindings) {
    const existing = byId.get(rawFinding.rawFindingId);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate ${label} raw finding "${rawFinding.rawFindingId}" is not allowed`,
      );
    }
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  return byId;
}
