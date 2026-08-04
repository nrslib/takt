import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { findingContentAddress } from './finding-contract-identity.js';
import type {
  FindingEvidenceBinding,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingLifecycleEntityHead,
  FindingLifecycleEvent,
  FindingLifecycleAuthority,
  FindingLifecycleMutationTarget,
  FindingLifecycleOperation,
  FindingLifecycleOutcome,
  FindingLifecycleReservation,
  FindingLifecycleReservationContext,
} from './finding-types.js';

function targetKey(target: FindingLifecycleMutationTarget): string {
  return `${target.entityKind}\0${target.entityId}`;
}

export function sortFindingLifecycleTargets(
  targets: readonly FindingLifecycleMutationTarget[],
): FindingLifecycleMutationTarget[] {
  return [...targets].sort((left, right) => (
    compareBinaryStrings(targetKey(left), targetKey(right))
  ));
}

function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareBinaryStrings);
}

export type FindingEvidenceBindingPayload = Omit<FindingEvidenceBinding, 'bindingId'>;

export function computeFindingEvidenceBindingId(
  binding: FindingEvidenceBindingPayload,
): string {
  return findingContentAddress('finding-evidence-binding', binding);
}

export function createFindingEvidenceBinding(
  binding: FindingEvidenceBindingPayload,
): FindingEvidenceBinding {
  const payload = structuredClone(binding);
  return {
    bindingId: computeFindingEvidenceBindingId(payload),
    ...payload,
  };
}

interface FindingLifecycleReservationIdentityPayload {
  operation: FindingLifecycleOperation;
  targets: FindingLifecycleMutationTarget[];
  evidenceBindingIds: string[];
  authority: FindingLifecycleAuthority;
  context: FindingLifecycleReservationContext;
}

function reservationIdentityPayload(
  reservation: FindingLifecycleReservationIdentityPayload,
): FindingLifecycleReservationIdentityPayload {
  return {
    operation: reservation.operation,
    targets: sortFindingLifecycleTargets(reservation.targets),
    evidenceBindingIds: sortedUniqueIds(reservation.evidenceBindingIds),
    authority: structuredClone(reservation.authority),
    context: structuredClone(reservation.context),
  };
}

export type FindingLifecycleReservationPayload =
  Omit<FindingLifecycleReservation, 'reservationId' | 'mutationId'>;

export function computeFindingLifecycleMutationId(
  reservation: FindingLifecycleReservationIdentityPayload,
): string {
  return findingContentAddress(
    'finding-lifecycle-mutation',
    reservationIdentityPayload(reservation),
  );
}

export function computeFindingLifecycleReservationId(
  reservation: FindingLifecycleReservationIdentityPayload,
): string {
  return findingContentAddress(
    'finding-lifecycle-reservation',
    reservationIdentityPayload(reservation),
  );
}

export function createFindingLifecycleReservation(
  reservation: FindingLifecycleReservationPayload,
): FindingLifecycleReservation {
  const identity = reservationIdentityPayload(structuredClone(reservation));
  return {
    reservationId: computeFindingLifecycleReservationId(identity),
    mutationId: computeFindingLifecycleMutationId(identity),
    ...identity,
    reservedAt: structuredClone(reservation.reservedAt),
  };
}

interface EventTransitionPayload {
  before: FindingLifecycleEntityHead | null;
  after: Omit<FindingLifecycleEntityHead, 'eventId'>;
}

export interface FindingLifecycleEventPayload {
  mutationId: string;
  reservationId: string;
  operation: FindingLifecycleOperation;
  transitions: EventTransitionPayload[];
  evidenceBindingIds: string[];
  outcome: FindingLifecycleOutcome;
  resultDigest: string;
  occurredAt: FindingLifecycleEvent['occurredAt'];
}

function eventIdentityPayload(event: FindingLifecycleEventPayload | FindingLifecycleEvent) {
  return {
    mutationId: event.mutationId,
    reservationId: event.reservationId,
    operation: event.operation,
    transitions: event.transitions.map((transition) => ({
      before: transition.before,
      after: {
        entityKind: transition.after.entityKind,
        entityId: transition.after.entityId,
        revision: transition.after.revision,
        projectionDigest: transition.after.projectionDigest,
      },
    })),
    evidenceBindingIds: sortedUniqueIds(event.evidenceBindingIds),
    outcome: structuredClone(event.outcome),
    resultDigest: event.resultDigest,
    occurredAt: event.occurredAt,
  };
}

export function computeFindingLifecycleEventId(
  event: FindingLifecycleEventPayload | FindingLifecycleEvent,
): string {
  return findingContentAddress('finding-lifecycle-event', eventIdentityPayload(event));
}

export function createFindingLifecycleEvent(
  event: FindingLifecycleEventPayload,
): FindingLifecycleEvent {
  const payload = eventIdentityPayload(structuredClone(event));
  const eventId = computeFindingLifecycleEventId(payload);
  return {
    eventId,
    ...payload,
    transitions: payload.transitions.map((transition) => ({
      ...transition,
      after: {
        ...transition.after,
        eventId,
      },
    })),
  };
}

function computeResultDigest(
  heads: readonly Omit<FindingLifecycleEntityHead, 'eventId'>[],
): string {
  return findingContentAddress('finding-lifecycle-result', {
    heads: [...heads].sort((left, right) => (
      compareBinaryStrings(
        `${left.entityKind}\0${left.entityId}`,
        `${right.entityKind}\0${right.entityId}`,
      )
    )),
  });
}

export function computeFindingLifecycleProjectionDigest(
  projection: FindingLedgerEntry | FindingLedgerConflict,
): string {
  return findingContentAddress('finding-lifecycle-entity-projection', projection);
}

export function computeFindingLifecycleResultDigest(input: {
  findings: readonly FindingLedgerEntry[];
  conflicts: readonly FindingLedgerConflict[];
}): string {
  return computeResultDigest([
    ...input.findings.map((finding) => ({
      entityKind: 'finding' as const,
      entityId: finding.id,
      revision: finding.revision,
      projectionDigest: computeFindingLifecycleProjectionDigest(finding),
    })),
    ...input.conflicts.map((conflict) => ({
      entityKind: 'conflict' as const,
      entityId: conflict.id,
      revision: conflict.revision,
      projectionDigest: computeFindingLifecycleProjectionDigest(conflict),
    })),
  ]);
}

export function computeFindingLifecycleHeadResultDigest(
  heads: readonly FindingLifecycleEntityHead[],
): string {
  return computeResultDigest(heads.map((head) => ({
    entityKind: head.entityKind,
    entityId: head.entityId,
    revision: head.revision,
    projectionDigest: head.projectionDigest,
  })));
}

export function findingEvidenceBindingIdentityViolation(
  binding: FindingEvidenceBinding,
): string | undefined {
  const canonicalId = computeFindingEvidenceBindingId({
    evidenceId: binding.evidenceId,
    claimIdentityHash: binding.claimIdentityHash,
    sourceRawFindingId: binding.sourceRawFindingId,
    sourceRawIntegrityDigest: binding.sourceRawIntegrityDigest,
    contributionOrigin: binding.contributionOrigin,
    operation: binding.operation,
    target: binding.target,
  });
  return binding.bindingId === canonicalId
    ? undefined
    : `Evidence binding "${binding.bindingId}" does not match its canonical content address "${canonicalId}"`;
}

export function findingLifecycleReservationIdentityViolation(
  reservation: FindingLifecycleReservation,
): string | undefined {
  const identity = reservationIdentityPayload(reservation);
  const canonicalMutationId = computeFindingLifecycleMutationId(identity);
  if (reservation.mutationId !== canonicalMutationId) {
    return `Lifecycle mutation "${reservation.mutationId}" does not match its canonical content address "${canonicalMutationId}"`;
  }
  const canonicalReservationId = computeFindingLifecycleReservationId(identity);
  return reservation.reservationId === canonicalReservationId
    ? undefined
    : `Lifecycle reservation "${reservation.reservationId}" does not match its canonical content address "${canonicalReservationId}"`;
}

export function findingLifecycleEventIdentityViolation(
  event: FindingLifecycleEvent,
): string | undefined {
  const canonicalId = computeFindingLifecycleEventId(event);
  if (event.eventId !== canonicalId) {
    return `Lifecycle event "${event.eventId}" does not match its canonical content address "${canonicalId}"`;
  }
  return event.transitions.every((transition) => transition.after.eventId === event.eventId)
    ? undefined
    : `Lifecycle event "${event.eventId}" has an invalid after head`;
}
