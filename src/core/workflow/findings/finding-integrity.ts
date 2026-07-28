import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { findingEvidenceRecordIdentityViolation } from '../../models/finding-evidence-record.js';
import { assertFindingLifecycleAuthorityInvariant } from '../../models/finding-lifecycle-invariants.js';
export { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type {
  CanonicalRawFindingProvenance,
  FindingEvidenceRecord,
  FindingLedger,
  FindingManagerReportPublication,
  RawFinding,
} from './types.js';
import { addRoundMarker } from './round-marker.js';

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
  ledger: Pick<
    FindingLedger,
    | 'findings'
    | 'rawFindings'
    | 'evidenceRecords'
    | 'evidenceBindings'
    | 'lifecycleReservations'
    | 'lifecycleEvents'
    | 'rawRecoveryAttempts'
    | 'rawRecoveryResults'
    | 'conflicts'
    | 'pendingManagerCommit'
  >,
): void {
  assertFindingLifecycleAuthorityInvariant(ledger);
  assertRawFindingsAppendOnly([], ledger.rawFindings);
  assertEvidenceRecordsAppendOnly([], ledger.evidenceRecords);
  assertCanonicalBindingSetAppendOnly([], ledger.evidenceBindings);
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
    assertRegistryPrefix(
      ledger.rawRecoveryAttempts,
      completed.rawRecoveryAttempts,
      'attemptId',
      'Raw recovery attempt',
    );
    assertRegistryPrefix(
      ledger.rawRecoveryResults,
      completed.rawRecoveryResults,
      'resultId',
      'Raw recovery result',
    );
    assertFindingLifecycleAuthorityInvariant(completed);
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
  assertRegistryPrefix(
    current.rawRecoveryAttempts,
    next.rawRecoveryAttempts,
    'attemptId',
    'Raw recovery attempt',
  );
  assertRegistryPrefix(
    current.rawRecoveryResults,
    next.rawRecoveryResults,
    'resultId',
    'Raw recovery result',
  );

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
