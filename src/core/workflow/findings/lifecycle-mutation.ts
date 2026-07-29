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
  RawFinding,
} from './types.js';
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

function assertReservationPremises(
  ledger: FindingLedger,
  reservation: FindingLifecycleReservation,
): void {
  for (const target of reservation.targets) {
    const current = currentEntity(ledger, target.entityKind, target.entityId);
    const head = captureFindingLifecycleHead(ledger, target.entityKind, target.entityId);
    if (target.expectedHead === null) {
      if (current !== undefined || head !== undefined) {
        throw new Error(`Lifecycle reservation expected "${target.entityId}" to be absent`);
      }
    } else if (
      current === undefined
      || head === undefined
      || !sameValue(head, target.expectedHead)
    ) {
      throw new Error(`Lifecycle reservation has a stale full head for "${target.entityId}"`);
    }
  }
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
    || operation === 'sync_interpretation_epoch'
  ) {
    if (
      current !== undefined
      && after.status === current.status
      && after.lifecycle === current.lifecycle
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
  }
  if (
    authority.kind === 'system'
    && authority.action === 'sync_interpretation_epoch'
  ) {
    const target = input.reservation.targets[0]!;
    const before = currentEntity(input.ledger, 'finding', target.entityId) as FindingLedgerEntry;
    const after = input.changes.get(targetKey(target)) as FindingLedgerEntry;
    if (
      before.provisional === undefined
      || after.provisional === undefined
      || !sameValue(
        { ...before.provisional, interpretationEpochs: after.provisional.interpretationEpochs },
        after.provisional,
      )
    ) {
      throw new Error(
        `Interpretation epoch sync for "${target.entityId}" changed fields outside interpretationEpochs`,
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
  if (
    operation !== 'create_conflict'
    && operation !== 'resolve_conflict'
    && operation !== 'observe_conflict'
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

function assertAdjudicationMutationContract(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  if (
    input.reservation.context.kind !== 'conflict_adjudication'
    || input.reservation.authority.kind !== 'conflict_adjudication'
  ) {
    throw new Error('Conflict adjudication mutation is missing adjudication authority context');
  }
  const conflictId = input.reservation.context.conflictId;
  const beforeConflict = currentEntity(
    input.ledger,
    'conflict',
    conflictId,
  ) as FindingLedgerConflict | undefined;
  const afterConflict = input.changes.get(
    targetKey({ entityKind: 'conflict', entityId: conflictId }),
  ) as FindingLedgerConflict | undefined;
  if (beforeConflict === undefined || afterConflict === undefined) {
    throw new Error('Conflict adjudication mutation must transition its reserved conflict');
  }
  const beforeAdjudications = beforeConflict.adjudications ?? [];
  const afterAdjudications = afterConflict.adjudications ?? [];
  if (
    afterAdjudications.length !== beforeAdjudications.length + 1
    || !sameValue(afterAdjudications.slice(0, beforeAdjudications.length), beforeAdjudications)
  ) {
    throw new Error('Conflict adjudication must append exactly one adjudication record');
  }
  const record = afterAdjudications.at(-1)!;
  if (
    record.evidenceHash !== input.reservation.context.evidenceHash
    || record.decidedAt.timestamp !== input.mutation.occurredAt.timestamp
    || record.decidedAt.runId !== input.mutation.occurredAt.runId
    || record.decidedAt.stepName !== input.mutation.occurredAt.stepName
  ) {
    throw new Error('Conflict adjudication record does not match its reserved evidence and observation');
  }
  const actionableFix = record.actionableFix?.trim() ?? '';
  const resolvesConflict = record.outcome === 'finding_stale'
    || record.outcome === 'evidence_invalid'
    || (record.outcome === 'finding_valid' && actionableFix.length > 0);
  const expectedConflictFields = new Set([
    'revision',
    'adjudications',
    ...(resolvesConflict
      ? ['status', 'resolvedAt', 'resolvedEvidence']
      : []),
  ]);
  if (!sameValue(
    [...changedProjectionKeys(beforeConflict, afterConflict)].sort(compareBinaryStrings),
    [...expectedConflictFields].sort(compareBinaryStrings),
  )) {
    throw new Error('Conflict adjudication projection does not match its outcome disposition');
  }
  if (
    (resolvesConflict && (
      afterConflict.status !== 'resolved'
      || afterConflict.resolvedAt !== record.decidedAt.timestamp
      || afterConflict.resolvedEvidence
        !== `Conflict adjudication ${conflictId}@${record.evidenceHash}: ${record.outcome}`
    ))
    || (!resolvesConflict && afterConflict.status !== 'active')
  ) {
    throw new Error('Conflict adjudication conflict disposition is inconsistent');
  }

  const reservedFindingIds = input.reservation.targets
    .filter((target) => target.entityKind === 'finding')
    .map((target) => target.entityId)
    .sort(compareBinaryStrings);
  if (!sameValue(
    reservedFindingIds,
    [...beforeConflict.findingIds].sort(compareBinaryStrings),
  )) {
    throw new Error('Conflict adjudication premises do not cover the conflict finding set');
  }
  const shouldChangeFindings = record.outcome === 'finding_stale'
    || record.outcome === 'evidence_invalid'
    || (record.outcome === 'finding_valid' && actionableFix.length > 0);
  const expectedFindingIds = shouldChangeFindings ? reservedFindingIds : [];
  const changedFindingIds = input.mutation.findings
    .map((finding) => finding.id)
    .sort(compareBinaryStrings);
  if (!sameValue(changedFindingIds, expectedFindingIds)) {
    throw new Error('Conflict adjudication finding transitions do not match its outcome');
  }
  for (const findingId of changedFindingIds) {
    const before = currentEntity(input.ledger, 'finding', findingId) as FindingLedgerEntry;
    const after = input.changes.get(
      targetKey({ entityKind: 'finding', entityId: findingId }),
    ) as FindingLedgerEntry;
    const changedFields = changedProjectionKeys(before, after);
    const semanticFields = [...changedFields].filter((field) => field !== 'revision');
    if (semanticFields.length === 0) {
      throw new Error(`Conflict adjudication cannot emit a revision-only finding transition for "${findingId}"`);
    }
    const expectedFields = new Set(
      record.outcome === 'finding_stale'
        ? ['revision', 'status', 'lifecycle', 'resolvedAt', 'resolvedEvidence']
        : record.outcome === 'evidence_invalid'
          ? ['revision', 'status', 'lifecycle', 'invalidatedAt', 'invalidatedEvidence']
          : [
              'revision',
              'suggestion',
              ...(!sameValue(before.lastSeen, after.lastSeen) ? ['lastSeen'] : []),
            ],
    );
    if (!sameValue(
      [...changedFields].sort(compareBinaryStrings),
      [...expectedFields].sort(compareBinaryStrings),
    )) {
      throw new Error(
        `Conflict adjudication produced an invalid finding delta for "${findingId}"`,
      );
    }
    if (record.outcome === 'finding_stale') {
      if (
        after.status !== 'resolved'
        || after.lifecycle !== 'resolved'
        || after.resolvedAt !== record.decidedAt.timestamp
        || after.resolvedEvidence
          !== `Conflict adjudication ${conflictId}@${record.evidenceHash}: finding_stale`
      ) {
        throw new Error(`Conflict adjudication did not resolve finding "${findingId}"`);
      }
    } else if (record.outcome === 'evidence_invalid') {
      if (
        after.status !== 'invalidated'
        || after.lifecycle !== 'invalidated'
        || after.invalidatedAt !== record.decidedAt.timestamp
        || after.invalidatedEvidence
          !== `Conflict adjudication ${conflictId}@${record.evidenceHash}: evidence_invalid`
      ) {
        throw new Error(`Conflict adjudication did not invalidate finding "${findingId}"`);
      }
    } else if (
      record.outcome === 'finding_valid'
      && (
        after.status !== before.status
        || after.lifecycle !== before.lifecycle
        || after.lastSeen.timestamp !== record.decidedAt.timestamp
        || !after.suggestion?.endsWith(`[adjudicated fix] ${actionableFix}`)
      )
    ) {
      throw new Error(`Conflict adjudication did not apply the actionable fix to finding "${findingId}"`);
    }
  }
}

function assertMutationTargetCoverage(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
  mutation: VerifiedLifecycleMutation;
  changes: ReadonlyMap<string, FindingLedgerEntry | FindingLedgerConflict>;
}): void {
  if (input.reservation.operation === 'apply_conflict_adjudication') {
    assertAdjudicationMutationContract(input);
    return;
  }
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

function assertManagerProofConditions(input: {
  ledger: FindingLedger;
  reservation: FindingLifecycleReservation;
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
      if (
        after.provisional === undefined
        || subject.findingId !== after.id
        || subject.provisionalKind !== after.provisional.kind
        || subject.stableKey !== after.provisional.stableKey
        || record.claimIdentityHash !== after.claimIdentityHash
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
    if (
      after.claimIdentityHash === null
      || (
        after.claimIdentityHash !== binding.claimIdentityHash
        && !sourceMatchesCreatedFinding
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
  reservation: FindingLifecycleReservation,
  mutation: VerifiedLifecycleMutation,
): FindingLifecycleOutcome {
  if (
    reservation.authority.kind !== 'conflict_adjudication'
    || reservation.context.kind !== 'conflict_adjudication'
  ) {
    return { kind: 'projection_applied' };
  }
  const context = reservation.context;
  const conflict = mutation.conflicts.find(
    (candidate) => candidate.id === context.conflictId,
  );
  const adjudication = [...(conflict?.adjudications ?? [])].reverse().find(
    (candidate) => candidate.evidenceHash === context.evidenceHash,
  );
  if (adjudication === undefined) {
    throw new Error(
      `Lifecycle adjudication mutation "${reservation.mutationId}" has no closed outcome`,
    );
  }
  return {
    kind: 'conflict_adjudication',
    conflictId: context.conflictId,
    evidenceHash: context.evidenceHash,
    outcome: adjudication.outcome,
  };
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
  assertOperationProjectionDelta({
    operation: reservation.operation,
    ledger,
    changes,
  });
  assertFormalProductTransition({ ledger, reservation, changes });
  assertManagerProofConditions({ ledger, reservation, changes });
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
