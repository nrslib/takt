import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  computeFindingLifecycleProjectionDigest,
  computeFindingLifecycleResultDigest,
  createFindingLifecycleEvent,
  findingLifecycleReservationIdentityViolation,
} from '../../models/finding-lifecycle-identity.js';
import {
  assertEligibleEvidenceForLifecycleOperation,
  assertFindingLifecycleAuthorityInvariant,
} from '../../models/finding-lifecycle-invariants.js';
import { FINDING_LIFECYCLE_OPERATION_CONTRACTS } from '../../models/finding-lifecycle-contract.js';
import { computeConflictRawClaimSnapshotDigest } from '../../models/finding-contract-identity.js';
import type {
  FindingEvidenceBinding,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingLifecycleEntityHead,
  FindingLifecycleOutcome,
  FindingLifecycleOperation,
  FindingLifecycleReservation,
  FindingObservation,
  FindingProvisionalClaimBindingAuthorization,
  RawFinding,
} from './types.js';
import {
  assertProvisionalClaimBindingAuthorization,
} from './pre-admission-entity-binding-commit.js';
import {
  createProductFindingEntry,
  isProvisionalFindingEntry,
} from './finding-entry.js';
import {
  verifyProvisionalProductTransitionAuthorityProof,
} from './provisional-product-transition-proof.js';

export interface VerifiedLifecycleReservation {
  reservation: FindingLifecycleReservation;
  evidenceBindings: FindingEvidenceBinding[];
}

export interface VerifiedLifecycleMutation {
  mutationId: string;
  findings: FindingLedgerEntry[];
  conflicts: FindingLedgerConflict[];
  occurredAt: FindingObservation;
  provisionalClaimBindingAuthorizationsByTarget?: ReadonlyMap<
    string,
    readonly FindingProvisionalClaimBindingAuthorization[]
  >;
}

function targetKey(target: {
  entityKind: string;
  entityId: string;
}): string {
  return `${target.entityKind}\0${target.entityId}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameOptionalValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return sameValue(left, right);
}

function mergeEvidenceBindings(
  ledger: FindingLedger,
  additions: readonly FindingEvidenceBinding[],
): FindingEvidenceBinding[] {
  const byId = new Map(ledger.evidenceBindings.map((binding) => [
    binding.bindingId,
    binding,
  ]));
  for (const binding of additions) {
    const existing = byId.get(binding.bindingId);
    if (existing !== undefined && !sameValue(existing, binding)) {
      throw new Error(`Evidence binding "${binding.bindingId}" cannot be replaced`);
    }
    byId.set(binding.bindingId, binding);
  }
  return [...byId.values()].sort((left, right) => (
    compareBinaryStrings(left.bindingId, right.bindingId)
  ));
}

function assertSuppliedBindings(input: VerifiedLifecycleReservation): void {
  const suppliedIds = input.evidenceBindings
    .map((binding) => binding.bindingId)
    .sort(compareBinaryStrings);
  if (
    suppliedIds.length !== input.reservation.evidenceBindingIds.length
    || suppliedIds.some(
      (bindingId, index) => bindingId !== input.reservation.evidenceBindingIds[index],
    )
  ) {
    throw new Error(
      `Lifecycle mutation "${input.reservation.mutationId}" has an invalid evidence binding payload`,
    );
  }
}

function reservationTargetMatchesCurrentHead(
  ledger: FindingLedger,
  target: FindingLifecycleReservation['targets'][number],
): boolean {
  const current = currentEntity(ledger, target.entityKind, target.entityId);
  const head = captureFindingLifecycleHead(ledger, target.entityKind, target.entityId);
  return target.expectedHead === null
    ? current === undefined && head === undefined
    : current !== undefined
      && head !== undefined
      && sameValue(head, target.expectedHead);
}

export function findingLifecycleReservationMatchesCurrentHeads(
  ledger: FindingLedger,
  reservation: Pick<FindingLifecycleReservation, 'targets'>,
): boolean {
  return reservation.targets.every((target) => (
    reservationTargetMatchesCurrentHead(ledger, target)
  ));
}

function assertReservationPremises(
  ledger: FindingLedger,
  reservation: FindingLifecycleReservation,
): void {
  if (findingLifecycleReservationMatchesCurrentHeads(ledger, reservation)) {
    return;
  }
  const staleTarget = reservation.targets.find((target) => (
    !reservationTargetMatchesCurrentHead(ledger, target)
  ))!;
  if (staleTarget.expectedHead === null) {
    throw new Error(`Lifecycle reservation expected "${staleTarget.entityId}" to be absent`);
  }
  throw new Error(`Lifecycle reservation has a stale full head for "${staleTarget.entityId}"`);
}

export function reserveVerifiedLifecycleMutation(
  ledger: FindingLedger,
  input: VerifiedLifecycleReservation,
): FindingLedger {
  assertFindingLifecycleAuthorityInvariant(ledger);
  const identityViolation = findingLifecycleReservationIdentityViolation(input.reservation);
  if (identityViolation !== undefined) {
    throw new Error(identityViolation);
  }
  assertSuppliedBindings(input);
  const evidenceBindings = mergeEvidenceBindings(ledger, input.evidenceBindings);
  assertEligibleEvidenceForLifecycleOperation({
    operation: input.reservation.operation,
    authority: input.reservation.authority,
    targets: input.reservation.targets,
    evidenceBindingIds: input.reservation.evidenceBindingIds,
    evidenceBindings,
    evidenceRecords: ledger.evidenceRecords,
    rawFindings: ledger.rawFindings,
    findings: ledger.findings,
    findingScopeBindings: ledger.findingScopeBindings,
    provisionalConflictNormalizationSnapshots:
      ledger.provisionalConflictNormalizationSnapshots,
    provisionalConflictNormalizations: ledger.provisionalConflictNormalizations,
  });
  const existing = ledger.lifecycleReservations.find(
    (reservation) => reservation.mutationId === input.reservation.mutationId,
  );
  if (existing !== undefined) {
    if (existing.reservationId !== input.reservation.reservationId) {
      throw new Error(`Lifecycle mutation "${input.reservation.mutationId}" changed its reservation payload`);
    }
    return ledger;
  }
  assertReservationPremises(ledger, input.reservation);
  if (ledger.lifecycleReservations.some(
    (reservation) => reservation.reservationId === input.reservation.reservationId,
  )) {
    throw new Error(`Lifecycle reservation "${input.reservation.reservationId}" already exists`);
  }
  const next: FindingLedger = {
    ...ledger,
    updatedAt: input.reservation.reservedAt.timestamp,
    evidenceBindings,
    lifecycleReservations: [
      ...ledger.lifecycleReservations,
      input.reservation,
    ],
  };
  assertFindingLifecycleAuthorityInvariant(next);
  return next;
}

function currentEntity(
  ledger: FindingLedger,
  entityKind: 'finding' | 'conflict',
  entityId: string,
): FindingLedgerEntry | FindingLedgerConflict | undefined {
  return entityKind === 'finding'
    ? ledger.findings.find((finding) => finding.id === entityId)
    : ledger.conflicts.find((conflict) => conflict.id === entityId);
}

export function captureFindingLifecycleHead(
  ledger: FindingLedger,
  entityKind: 'finding' | 'conflict',
  entityId: string,
): FindingLifecycleEntityHead | undefined {
  for (let index = ledger.lifecycleEvents.length - 1; index >= 0; index -= 1) {
    const transition = ledger.lifecycleEvents[index]!.transitions.find((candidate) => (
      candidate.after.entityKind === entityKind
      && candidate.after.entityId === entityId
    ));
    if (transition !== undefined) {
      return transition.after;
    }
  }
  return undefined;
}

function assertFindingState(
  operation: FindingLifecycleOperation,
  current: FindingLedgerEntry | undefined,
  after: FindingLedgerEntry,
): void {
  const expected = {
    create_finding: ['open', 'new'],
    persist_finding: ['open', 'persists'],
    resolve_finding: ['resolved', 'resolved'],
    reopen_finding: ['open', 'reopened'],
    waive_finding: ['waived', 'waived'],
    invalidate_finding: ['invalidated', 'invalidated'],
    dismiss_finding: ['dismissed', 'dismissed'],
  } as const;
  if (operation === 'supersede_findings') {
    if (
      (after.status === 'superseded' && after.lifecycle === 'superseded')
      || (
        current !== undefined
        && after.status === current.status
        && after.lifecycle === current.lifecycle
      )
    ) {
      return;
    }
  } else if (operation in expected) {
    const [status, lifecycle] = expected[operation as keyof typeof expected];
    if (after.status === status && after.lifecycle === lifecycle) {
      return;
    }
  } else if (
    operation === 'record_dispute'
    || operation === 'record_rejected_observation'
    || operation === 'record_recovery_attempt'
  ) {
    if (
      current !== undefined
      && after.status === current.status
      && after.lifecycle === current.lifecycle
    ) {
      return;
    }
  } else if (operation === 'attach_raw_to_provisional') {
    if (
      current?.status === 'open'
      && current.provisional !== undefined
      && after.status === 'open'
      && after.provisional !== undefined
    ) {
      return;
    }
  } else {
    return;
  }
  throw new Error(
    `Lifecycle operation "${operation}" produced an invalid finding state for "${after.id}"`,
  );
}

function assertSpecialAuthorityDelta(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  const authority = input.reservation.authority;
  if (authority.kind === 'rejected_observation') {
    const target = input.reservation.targets[0]!;
    const before = currentEntity(input.ledger, 'finding', target.entityId) as FindingLedgerEntry;
    const after = input.changes.get(targetKey(target)) as FindingLedgerEntry;
    const previous = before.rejectedObservations ?? [];
    const next = after.rejectedObservations ?? [];
    if (
      next.length !== previous.length + 1
      || !sameValue(next.slice(0, previous.length), previous)
      || next.at(-1)?.rawFindingId !== authority.rawFindingId
    ) {
      throw new Error(
        `Rejected observation authority for "${target.entityId}" does not match its append-only projection delta`,
      );
    }
    return;
  }
  if (authority.kind === 'verified_raw_provisional_identity') {
    const target = input.reservation.targets[0]!;
    const before = currentEntity(input.ledger, 'finding', target.entityId) as FindingLedgerEntry;
    const after = input.changes.get(targetKey(target)) as FindingLedgerEntry;
    const immutableFields = [
      'id', 'status', 'target', 'targetIdentityHash', 'claimIdentityHash',
      'semanticClaimIdentityHash', 'severity', 'title',
    ] as const;
    if (
      before.provisional === undefined
      || after.provisional === undefined
      || immutableFields.some((field) => !sameOptionalValue(before[field], after[field]))
      || before.provisional.kind !== after.provisional.kind
      || before.provisional.stableKey !== after.provisional.stableKey
      || before.provisional.lineageKey !== after.provisional.lineageKey
      || before.rawFindingIds.includes(authority.rawFindingId)
      || before.provisional.sourceRawFindingIds.includes(authority.rawFindingId)
      || after.rawFindingIds.filter((id) => id === authority.rawFindingId).length !== 1
      || after.provisional.sourceRawFindingIds.filter(
        (id) => id === authority.rawFindingId,
      ).length !== 1
    ) {
      throw new Error(
        `Raw provisional identity authority for "${target.entityId}" does not match its projection delta`,
      );
    }
    return;
  }
  if (authority.kind === 'conflict_reactivation') {
    const target = input.reservation.targets[0]!;
    const before = currentEntity(input.ledger, 'conflict', target.entityId) as FindingLedgerConflict;
    const after = input.changes.get(targetKey(target)) as FindingLedgerConflict;
    const newRawFindingIds = authority.newRawClaims.map(({ rawFindingId }) => rawFindingId);
    const coveredLandingIds = new Set(input.ledger.conflictClaimSettlements
      .filter((settlement) => settlement.conflictId === before.id)
      .flatMap((settlement) => settlement.rawClaimLandingIds));
    const priorLandings = input.ledger.conflictRawClaimLandings.filter(
      (landing) => landing.conflictId === before.id
        && !newRawFindingIds.includes(landing.rawFindingId),
    );
    const productTargets = before.findingIds.every((findingId) => {
      const finding = input.ledger.findings.find((candidate) => candidate.id === findingId);
      return finding?.status === 'open' && finding.provisional === undefined;
    });
    const immutableFields = ['id', 'findingIds', 'description', 'firstSeen'] as const;
    if (
      before.status !== 'resolved'
      || after.status !== 'active'
      || authority.newRawClaims.length === 0
      || new Set(newRawFindingIds).size !== newRawFindingIds.length
      || newRawFindingIds.some((rawFindingId) => before.rawFindingIds.includes(rawFindingId))
      || authority.newRawClaims.some((claim) => {
        const raw = input.ledger.rawFindings.filter(
          (candidate) => candidate.rawFindingId === claim.rawFindingId,
        );
        const snapshots = input.ledger.rawCanonicalSnapshots.filter(
          (snapshot) => snapshot.rawFindingId === claim.rawFindingId,
        );
        return raw.length !== 1
          || snapshots.length !== 1
          || snapshots[0]!.rawCanonicalSnapshotId !== claim.rawCanonicalSnapshotId
          || snapshots[0]!.rawPayloadDigest !== claim.rawPayloadDigest
          || computeConflictRawClaimSnapshotDigest(snapshots[0]!) !== claim.claimSnapshotDigest;
      })
      || priorLandings.some((landing) => !coveredLandingIds.has(landing.rawClaimLandingId))
      || input.ledger.conflictAdjudicationAttempts.some((attempt) => (
        attempt.conflictId === before.id
        && (attempt.stage === 'started' || attempt.stage === 'proposed')
      ))
      || !productTargets
      || immutableFields.some((field) => !sameOptionalValue(before[field], after[field]))
      || !sameValue(
        after.rawFindingIds,
        [...new Set([...before.rawFindingIds, ...newRawFindingIds])].sort(compareBinaryStrings),
      )
      || Object.prototype.hasOwnProperty.call(after, 'resolvedAt')
      || Object.prototype.hasOwnProperty.call(after, 'resolvedEvidence')
    ) {
      throw new Error(
        `Conflict reactivation authority for "${target.entityId}" does not match its projection delta`,
      );
    }
  }
}

function assertConflictState(
  operation: FindingLifecycleOperation,
  current: FindingLedgerConflict | undefined,
  after: FindingLedgerConflict,
): void {
  if (operation === 'create_conflict' && after.status === 'active') {
    return;
  }
  if (operation === 'resolve_conflict' && after.status === 'resolved') {
    return;
  }
  if (operation === 'observe_conflict' && current?.status === 'active' && after.status === 'active') {
    return;
  }
  if (operation === 'reactivate_conflict' && current?.status === 'resolved' && after.status === 'active') {
    return;
  }
  if (
    operation !== 'create_conflict'
    && operation !== 'resolve_conflict'
    && operation !== 'observe_conflict'
    && operation !== 'reactivate_conflict'
  ) {
    return;
  }
  throw new Error(
    `Lifecycle operation "${operation}" produced an invalid conflict state for "${after.id}"`,
  );
}

function mutationChanges(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
}): Map<string, FindingLedgerEntry | FindingLedgerConflict> {
  const changes = new Map<string, FindingLedgerEntry | FindingLedgerConflict>();
  for (const finding of input.mutation.findings) {
    const key = targetKey({ entityKind: 'finding', entityId: finding.id });
    if (changes.has(key)) {
      throw new Error(`Lifecycle mutation contains duplicate entity "${finding.id}"`);
    }
    assertFindingState(
      input.reservation.operation,
      currentEntity(input.ledger, 'finding', finding.id) as FindingLedgerEntry | undefined,
      finding,
    );
    changes.set(key, finding);
  }
  for (const conflict of input.mutation.conflicts) {
    const key = targetKey({ entityKind: 'conflict', entityId: conflict.id });
    if (changes.has(key)) {
      throw new Error(`Lifecycle mutation contains duplicate entity "${conflict.id}"`);
    }
    assertConflictState(
      input.reservation.operation,
      currentEntity(input.ledger, 'conflict', conflict.id) as FindingLedgerConflict | undefined,
      conflict,
    );
    changes.set(key, conflict);
  }
  if (changes.size === 0) {
    throw new Error('Lifecycle mutation must change at least one reserved target');
  }
  const reservedKeys = new Set(input.reservation.targets.map((target) => targetKey(target)));
  if ([...changes.keys()].some((key) => !reservedKeys.has(key))) {
    throw new Error('Lifecycle mutation changes an entity outside its reservation');
  }
  return changes;
}

function changedProjectionKeys(
  before: FindingLedgerEntry | FindingLedgerConflict | undefined,
  after: FindingLedgerEntry | FindingLedgerConflict,
): Set<string> {
  const beforeRecord = before as unknown as Record<string, unknown> | undefined;
  const afterRecord = after as unknown as Record<string, unknown>;
  return new Set(
    [...new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after),
    ])].filter((key) => {
      const beforeHasKey = beforeRecord !== undefined
        && Object.prototype.hasOwnProperty.call(beforeRecord, key);
      const afterHasKey = Object.prototype.hasOwnProperty.call(afterRecord, key);
      return beforeHasKey !== afterHasKey
        || (
          beforeHasKey
          && afterHasKey
          && !sameValue(beforeRecord[key], afterRecord[key])
        );
    }),
  );
}

function assertMutationTargetCoverage(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  const reservedKeys = input.reservation.targets.map(targetKey).sort(compareBinaryStrings);
  const changedKeys = [...input.changes.keys()].sort(compareBinaryStrings);
  if (!sameValue(reservedKeys, changedKeys)) {
    throw new Error('Lifecycle mutation must transition every reserved target');
  }
}

function assertOperationProjectionDelta(input: {
  operation: FindingLifecycleOperation;
  ledger: FindingLedger;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  const contract = FINDING_LIFECYCLE_OPERATION_CONTRACTS[input.operation];
  for (const [key, after] of input.changes) {
    const entityKind = key.startsWith('finding\0') ? 'finding' : 'conflict';
    const before = currentEntity(input.ledger, entityKind, after.id);
    if (before === undefined && contract.allowsCreate) {
      continue;
    }
    const allowed = new Set(
      entityKind === 'finding'
        ? contract.findingDelta
        : contract.conflictDelta,
    );
    const forbidden = [...changedProjectionKeys(before, after)]
      .filter((field) => !allowed.has(field));
    if (forbidden.length > 0) {
      throw new Error(
        `Lifecycle operation "${input.operation}" changed forbidden projection fields for "${key}": ${forbidden.join(', ')}`,
      );
    }
  }
}

function assertSettledConflictSubjectContinuity(input: {
  ledger: FindingLedger;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  for (const settlement of input.ledger.conflictClaimSettlements) {
    const changed = input.changes.get(`finding\0${settlement.findingId}`);
    if (changed === undefined || 'findingIds' in changed) {
      continue;
    }
    if (
      (settlement.outcome === 'merged'
        && (changed.status !== 'superseded'
          || changed.supersededByFindingId !== settlement.targetFindingId))
      || (settlement.outcome === 'promoted' && changed.provisional !== undefined)
      || (settlement.outcome === 'resolved' && changed.status !== 'resolved')
      || (settlement.outcome === 'invalidated' && changed.status !== 'invalidated')
    ) {
      throw new Error(`Settled conflict subject "${settlement.findingId}" cannot be reopened or repurposed`);
    }
  }
}

function transitionRawFindings(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  target: FindingLifecycleReservation['targets'][number];
}): RawFinding[] {
  const bindingIds = new Set(input.reservation.evidenceBindingIds);
  const rawById = new Map(
    input.ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]),
  );
  const transitionRawIds = new Set<string>();
  for (const binding of input.ledger.evidenceBindings) {
    if (
      bindingIds.has(binding.bindingId)
      && sameValue(binding.target, input.target)
      && binding.sourceRawFindingId !== null
    ) {
      transitionRawIds.add(binding.sourceRawFindingId);
    }
  }
  if (transitionRawIds.size === 0) {
    for (const binding of input.ledger.evidenceBindings) {
      if (
        !bindingIds.has(binding.bindingId)
        || !sameValue(binding.target, input.target)
      ) {
        continue;
      }
      const record = input.ledger.evidenceRecords.find(
        (candidate) => candidate.evidenceId === binding.evidenceId,
      );
      if (
        record?.kind === 'engine_proof'
        && record.subject.kind === 'finding_provisional_product_transition'
      ) {
        for (const source of record.subject.sourceRawFindings) {
          transitionRawIds.add(source.rawFindingId);
        }
      }
    }
  }
  return [...transitionRawIds]
    .sort(compareBinaryStrings)
    .map((rawFindingId) => {
      const rawFinding = rawById.get(rawFindingId);
      if (rawFinding === undefined) {
        throw new Error(
          `Lifecycle transition references missing raw finding "${rawFindingId}"`,
        );
      }
      return rawFinding;
    });
}

function assertFormalProductTransition(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  if (
    input.reservation.operation !== 'promote_provisional'
    && input.reservation.operation !== 'reopen_finding'
  ) {
    return;
  }
  const target = input.reservation.targets[0]!;
  const before = currentEntity(
    input.ledger,
    target.entityKind,
    target.entityId,
  );
  const after = input.changes.get(targetKey(target));
  if (
    before === undefined
    || after === undefined
    || !('lifecycle' in before)
    || !('lifecycle' in after)
  ) {
    throw new Error(
      `Lifecycle operation "${input.reservation.operation}" requires an existing finding target`,
    );
  }

  if (!isProvisionalFindingEntry(before)) {
    if (input.reservation.operation !== 'reopen_finding') {
      throw new Error(
        `Lifecycle operation "promote_provisional" requires a provisional finding`,
      );
    }
    if (
      before.status !== 'resolved'
      && before.status !== 'waived'
      && before.status !== 'dismissed'
    ) {
      throw new Error(
        `Ordinary product reopen for "${before.id}" requires a closed finding`,
      );
    }
    const immutableProductFields = [
      'target',
      'targetIdentityHash',
      'claimIdentityHash',
      'semanticClaimIdentityHash',
      'severity',
      'title',
      'provisional',
    ] as const;
    const rewritten = immutableProductFields.filter(
      (field) => !sameOptionalValue(before[field], after[field]),
    );
    if (rewritten.length > 0) {
      throw new Error(
        `Ordinary product reopen for "${before.id}" rewrote immutable claim fields: ${rewritten.join(', ')}`,
      );
    }
    return;
  }

  const removesProvisional = after.provisional === undefined;
  if (
    input.reservation.operation === 'reopen_finding'
    && !removesProvisional
  ) {
    return;
  }
  if (!removesProvisional) {
    throw new Error(
      `Lifecycle operation "promote_provisional" did not remove provisional metadata`,
    );
  }

  const transitionRaws = transitionRawFindings({
    ledger: input.ledger,
    reservation: input.reservation,
    target,
  });
  if (transitionRaws.length === 0) {
    throw new Error(
      `Lifecycle operation "${input.reservation.operation}" has no provisional transition source`,
    );
  }
  const product = createProductFindingEntry(after);
  const bindingIds = new Set(input.reservation.evidenceBindingIds);
  const transitionProofs = input.ledger.evidenceBindings.flatMap((binding) => {
    if (
      !bindingIds.has(binding.bindingId)
      || !sameValue(binding.target, target)
    ) {
      return [];
    }
    const record = input.ledger.evidenceRecords.find(
      (candidate) => candidate.evidenceId === binding.evidenceId,
    );
    return record?.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_product_transition'
      ? [record]
      : [];
  });
  if (transitionProofs.length !== 1) {
    throw new Error(
      `Lifecycle operation "${input.reservation.operation}" requires exactly one provisional transition proof`,
    );
  }
  verifyProvisionalProductTransitionAuthorityProof({
    ledger: input.ledger,
    operation: input.reservation.operation,
    findingId: before.id,
    transitionRawFindings: transitionRaws,
    after: product,
    proof: transitionProofs[0]!,
  });
}

function hasProvisionalClaimBindingAuthorization(input: {
  authorizations: readonly FindingProvisionalClaimBindingAuthorization[];
  ledger: FindingLedger;
  target: FindingEvidenceBinding['target'];
  after: FindingLedgerEntry;
  sourceRawFindingId: string;
}): boolean {
  for (let index = 0; index < input.authorizations.length; index += 1) {
    const authorization = input.authorizations[index];
    assertProvisionalClaimBindingAuthorization(authorization);
    const reference = authorization.reference;
    if (!reference.sourceRawFindingIds.includes(input.sourceRawFindingId)) {
      continue;
    }
    if (reference.kind === 'new_provisional_bundle') {
      if (
        input.target.expectedHead === null
        && reference.expectedHead === null
        && input.after.provisional !== undefined
        && sameValue(
          reference.sourceRawFindingIds,
          input.after.provisional.sourceRawFindingIds,
        )
      ) {
        return true;
      }
      continue;
    }
    if (
      input.target.expectedHead === null
      || reference.findingId !== input.target.entityId
      || reference.expectedTargetHead.revision !== input.target.expectedHead.revision
      || reference.expectedTargetHead.projectionDigest
        !== input.target.expectedHead.projectionDigest
    ) {
      continue;
    }
    const before = input.ledger.findings.find(
      (finding) => finding.id === input.target.entityId,
    );
    if (before?.status === 'open'
      && before.provisional?.kind === reference.expectedProvisionalKind
      && before.provisional.stableKey === reference.expectedStableKey
      && before.provisional.lineageKey === reference.expectedLineageKey
      && input.after.status === 'open'
      && input.after.provisional?.kind === reference.expectedProvisionalKind
      && input.after.provisional.stableKey === reference.expectedStableKey
      && input.after.provisional.lineageKey === reference.expectedLineageKey
    ) {
      return true;
    }
  }
  return false;
}

function claimBindingAuthorizationsForTarget(
  mutation: VerifiedLifecycleMutation,
  target: FindingEvidenceBinding['target'],
): readonly FindingProvisionalClaimBindingAuthorization[] {
  return mutation.provisionalClaimBindingAuthorizationsByTarget
    ?.get(targetKey(target)) ?? [];
}

function assertManagerProofConditions(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  for (const bindingId of input.reservation.evidenceBindingIds) {
    const binding = input.ledger.evidenceBindings.find(
      (candidate) => candidate.bindingId === bindingId,
    )!;
    const record = input.ledger.evidenceRecords.find(
      (candidate) => candidate.evidenceId === binding.evidenceId,
    )!;
    if (
      record.kind !== 'engine_proof'
      || record.verifierId !== 'takt.finding-lifecycle-policy'
      || record.verifierVersion !== '1'
    ) {
      continue;
    }
    const after = input.changes.get(targetKey(binding.target));
    if (after === undefined || !('lifecycle' in after)) {
      throw new Error(`Lifecycle manager proof "${record.proofId}" has no changed finding target`);
    }
    const subject = record.subject;
    if (subject.kind === 'finding_provisional_isolation') {
      const claimBindingAuthorizations = claimBindingAuthorizationsForTarget(
        input.mutation,
        binding.target,
      );
      const sourceRaw = binding.sourceRawFindingId === null
        ? undefined
        : input.ledger.rawFindings.find(
            (raw) => raw.rawFindingId === binding.sourceRawFindingId,
          );
      const priorFinding = binding.target.expectedHead === null
        ? undefined
        : input.ledger.findings.find((finding) => finding.id === after.id);
      const admittedClaimIdentityHash = priorFinding === undefined
        ? after.claimIdentityHash
        : priorFinding.claimIdentityHash;
      const bindingRetainsPreviouslyAdmittedRaw = sourceRaw !== undefined
        && priorFinding?.provisional?.sourceRawFindingIds.includes(
          sourceRaw.rawFindingId,
        ) === true
        && after.provisional?.sourceRawFindingIds.includes(
          sourceRaw.rawFindingId,
        ) === true;
      const proofMatchesProvisionalClaim = record.claimIdentityHash === admittedClaimIdentityHash
        || bindingRetainsPreviouslyAdmittedRaw
        || (
          sourceRaw !== undefined
          && record.claimIdentityHash === sourceRaw.claimIdentityHash
          && after.provisional?.sourceRawFindingIds.includes(sourceRaw.rawFindingId) === true
          && hasProvisionalClaimBindingAuthorization({
            authorizations: claimBindingAuthorizations,
            ledger: input.ledger,
            target: binding.target,
            after,
            sourceRawFindingId: sourceRaw.rawFindingId,
          })
        );
      if (
        after.provisional === undefined
        || subject.findingId !== after.id
        || subject.provisionalKind !== after.provisional.kind
        || subject.stableKey !== after.provisional.stableKey
        || !proofMatchesProvisionalClaim
      ) {
        throw new Error(`Lifecycle manager proof "${record.proofId}" does not match the provisional projection delta`);
      }
    } else if (
      subject.kind === 'finding_target_invalid'
      && subject.reason !== after.invalidatedEvidence
    ) {
      throw new Error(`Lifecycle manager proof "${record.proofId}" does not match the invalidation projection delta`);
    } else if (subject.kind === 'finding_claim_sets_equal') {
      const changedIds = [...input.changes.values()]
        .filter((projection): projection is FindingLedgerEntry => 'lifecycle' in projection)
        .map((projection) => projection.id)
        .sort(compareBinaryStrings);
      if (!sameValue(changedIds, subject.findingIds)) {
        throw new Error(`Lifecycle manager proof "${record.proofId}" does not match the supersession projection delta`);
      }
    }
  }
}

function assertExistingProvisionalClaimBindings(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  if (input.reservation.operation !== 'update_provisional') {
    return;
  }
  const reservationBindingIds = new Set(input.reservation.evidenceBindingIds);
  for (const target of input.reservation.targets) {
    if (target.entityKind !== 'finding' || target.expectedHead === null) {
      continue;
    }
    const before = input.ledger.findings.find((finding) => finding.id === target.entityId);
    const after = input.changes.get(targetKey(target));
    if (before === undefined || after === undefined || !('lifecycle' in after)) {
      continue;
    }
    for (const raw of introducedDistinctRawClaims(input.ledger, before, after)) {
      if (!hasAuthorizedIsolationProofForRaw({
        ledger: input.ledger,
        reservationBindingIds,
        target,
        after,
        rawFindingId: raw.rawFindingId,
        authorizations: claimBindingAuthorizationsForTarget(
          input.mutation,
          target,
        ),
      })) {
        throw new Error(
          `Lifecycle target "${target.entityId}" has no pre-admission authorization for distinct raw claim "${raw.rawFindingId}"`,
        );
      }
    }
  }
}

function introducedDistinctRawClaims(
  ledger: FindingLedger,
  before: FindingLedgerEntry,
  after: FindingLedgerEntry,
): RawFinding[] {
  const existingRawFindingIds = new Set(
    before.provisional?.sourceRawFindingIds ?? [],
  );
  return (after.provisional?.sourceRawFindingIds ?? []).flatMap((rawFindingId) => {
    if (existingRawFindingIds.has(rawFindingId)) {
      return [];
    }
    const raw = ledger.rawFindings.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    );
    if (raw === undefined) {
      throw new Error(`Lifecycle projection references missing raw finding "${rawFindingId}"`);
    }
    return raw.claimIdentityHash === before.claimIdentityHash ? [] : [raw];
  });
}

function hasAuthorizedIsolationProofForRaw(input: {
  ledger: FindingLedger;
  reservationBindingIds: ReadonlySet<string>;
  target: FindingEvidenceBinding['target'];
  after: FindingLedgerEntry;
  rawFindingId: string;
  authorizations: readonly FindingProvisionalClaimBindingAuthorization[];
}): boolean {
  return input.ledger.evidenceBindings.some((binding) => {
    if (
      !input.reservationBindingIds.has(binding.bindingId)
      || binding.sourceRawFindingId !== input.rawFindingId
      || !sameValue(binding.target, input.target)
    ) {
      return false;
    }
    const record = input.ledger.evidenceRecords.find(
      (candidate) => candidate.evidenceId === binding.evidenceId,
    );
    return record?.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_isolation'
      && hasProvisionalClaimBindingAuthorization({
        authorizations: input.authorizations,
        ledger: input.ledger,
        target: input.target,
        after: input.after,
        sourceRawFindingId: input.rawFindingId,
      });
  });
}

function assertCreateClaimBindings(input: {
  reservation: FindingLifecycleReservation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
  bindings: readonly FindingEvidenceBinding[];
  rawFindings: readonly FindingLedger['rawFindings'][number][];
}): void {
  for (const bindingId of input.reservation.evidenceBindingIds) {
    const binding = input.bindings.find((candidate) => candidate.bindingId === bindingId)!;
    if (
      binding.target.entityKind !== 'finding'
      || binding.target.expectedHead !== null
    ) {
      continue;
    }
    const after = input.changes.get(targetKey(binding.target)) as FindingLedgerEntry;
    if (
      after.provisional !== undefined
      && after.claimIdentityHash === null
      && binding.claimIdentityHash === null
    ) {
      continue;
    }
    const sourceRaw = binding.sourceRawFindingId === null
      ? undefined
      : input.rawFindings.find(
          (raw) => raw.rawFindingId === binding.sourceRawFindingId,
        );
    const sourceMatchesCreatedFinding = sourceRaw !== undefined
      && (
        sourceRaw.claimIdentityHash === after.claimIdentityHash
        || (
          after.semanticClaimIdentityHash !== null
          && sourceRaw.semanticClaimIdentityHash === after.semanticClaimIdentityHash
        )
      );
    const sourceBelongsToCreatedProvisional = sourceRaw !== undefined
      && input.reservation.operation === 'update_provisional'
      && binding.claimIdentityHash === sourceRaw.claimIdentityHash
      && after.provisional?.sourceRawFindingIds.includes(sourceRaw.rawFindingId) === true;
    if (
      after.claimIdentityHash === null
      || (
        after.claimIdentityHash !== binding.claimIdentityHash
        && !sourceMatchesCreatedFinding
        && !sourceBelongsToCreatedProvisional
      )
    ) {
      throw new Error(`Evidence binding "${binding.bindingId}" does not match the created finding claim`);
    }
  }
}

function nextFindingId(ledger: FindingLedger, changes: readonly FindingLedgerEntry[]): number {
  let nextId = ledger.nextId;
  for (const finding of changes) {
    const match = /^F-(\d{4})$/.exec(finding.id);
    if (match === null) {
      throw new Error(`Invalid finding id format "${finding.id}"`);
    }
    nextId = Math.max(nextId, Number(match[1]) + 1);
  }
  return nextId;
}

function lifecycleOutcome(
  _reservation: FindingLifecycleReservation,
  _mutation: VerifiedLifecycleMutation,
): FindingLifecycleOutcome {
  return { kind: 'projection_applied' };
}

export function applyVerifiedLifecycleMutation(
  ledger: FindingLedger,
  mutation: VerifiedLifecycleMutation,
): FindingLedger {
  assertFindingLifecycleAuthorityInvariant(ledger);
  const reservation = ledger.lifecycleReservations.find(
    (candidate) => candidate.mutationId === mutation.mutationId,
  );
  if (reservation === undefined) {
    throw new Error(`Lifecycle mutation "${mutation.mutationId}" has no reservation`);
  }
  const resultDigest = computeFindingLifecycleResultDigest(mutation);
  const applied = ledger.lifecycleEvents.find(
    (event) => event.mutationId === mutation.mutationId,
  );
  if (applied !== undefined) {
    if (applied.resultDigest !== resultDigest) {
      throw new Error(`Lifecycle mutation "${mutation.mutationId}" changed its result payload`);
    }
    return ledger;
  }

  const casPremiseTargets = reservation.targets;
  assertReservationPremises(ledger, reservation);
  const changes = mutationChanges({ ledger, reservation, mutation });
  if (changes.size === 0) {
    throw new Error(`Lifecycle mutation "${mutation.mutationId}" must change at least one reserved entity`);
  }
  assertCreateClaimBindings({
    reservation,
    changes,
    bindings: ledger.evidenceBindings,
    rawFindings: ledger.rawFindings,
  });
  assertMutationTargetCoverage({ ledger, reservation, mutation, changes });
  assertSettledConflictSubjectContinuity({ ledger, changes });
  assertOperationProjectionDelta({
    operation: reservation.operation,
    ledger,
    changes,
  });
  assertFormalProductTransition({ ledger, reservation, changes });
  assertManagerProofConditions({ ledger, reservation, mutation, changes });
  assertExistingProvisionalClaimBindings({ ledger, reservation, mutation, changes });
  assertSpecialAuthorityDelta({ ledger, reservation, changes });
  const transitions = casPremiseTargets.flatMap((target) => {
    const after = changes.get(targetKey(target));
    if (after === undefined) {
      return [];
    }
    const current = currentEntity(ledger, target.entityKind, target.entityId);
    const currentHead = captureFindingLifecycleHead(ledger, target.entityKind, target.entityId);
    if (target.expectedHead === null) {
      if (current !== undefined || currentHead !== undefined || after.revision !== 1) {
        throw new Error(`Lifecycle create CAS failed for "${target.entityId}"`);
      }
    } else if (
      current === undefined
      || currentHead === undefined
      || !sameValue(currentHead, target.expectedHead)
      || after.revision !== target.expectedHead.revision + 1
    ) {
      throw new Error(
        `Lifecycle full-head CAS failed for "${target.entityId}": expected revision ${target.expectedHead.revision + 1}, received ${after.revision}`,
      );
    }
    return [{
      before: target.expectedHead,
      after: {
        entityKind: target.entityKind,
        entityId: target.entityId,
        revision: after.revision,
        projectionDigest: computeFindingLifecycleProjectionDigest(after),
      },
    }];
  });
  const event = createFindingLifecycleEvent({
    mutationId: mutation.mutationId,
    reservationId: reservation.reservationId,
    operation: reservation.operation,
    transitions,
    evidenceBindingIds: reservation.evidenceBindingIds,
    outcome: lifecycleOutcome(reservation, mutation),
    resultDigest,
    occurredAt: mutation.occurredAt,
  });
  const next: FindingLedger = {
    ...ledger,
    nextId: nextFindingId(ledger, mutation.findings),
    updatedAt: mutation.occurredAt.timestamp,
    findings: [
      ...ledger.findings.filter((finding) => (
        !changes.has(targetKey({ entityKind: 'finding', entityId: finding.id }))
      )),
      ...mutation.findings,
    ].sort((left, right) => compareBinaryStrings(left.id, right.id)),
    conflicts: [
      ...ledger.conflicts.filter((conflict) => (
        !changes.has(targetKey({ entityKind: 'conflict', entityId: conflict.id }))
      )),
      ...mutation.conflicts,
    ].sort((left, right) => compareBinaryStrings(left.id, right.id)),
    lifecycleEvents: [...ledger.lifecycleEvents, event],
  };
  assertFindingLifecycleAuthorityInvariant(next);
  return next;
}
