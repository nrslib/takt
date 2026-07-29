import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import {
  evidenceRecordMatchesRawEvidence,
  findingEvidenceRecordIdentityViolation,
} from './finding-evidence-record.js';
import {
  computeFindingLifecycleProjectionDigest,
  computeFindingLifecycleHeadResultDigest,
  findingEvidenceBindingIdentityViolation,
  findingLifecycleEventIdentityViolation,
  findingLifecycleReservationIdentityViolation,
  sortFindingLifecycleTargets,
} from './finding-lifecycle-identity.js';
import { computeRawFindingIntegrityDigest } from './finding-raw-integrity.js';
import {
  computeAnchorRelevanceDecisionDigest,
} from './finding-anchor-relevance.js';
import {
  FINDING_LIFECYCLE_OPERATION_CONTRACTS,
  findingLifecycleAuthorityContract,
} from './finding-lifecycle-contract.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedger,
  FindingLifecycleAuthority,
  FindingLifecycleEntityHead,
  FindingLifecycleMutationTarget,
  FindingLifecycleOperation,
  RawFinding,
} from './finding-types.js';

export interface FindingLifecycleAuthorityProjection {
  readonly findings: readonly FindingLedger['findings'][number][];
  readonly evidenceRecords: readonly FindingLedger['evidenceRecords'][number][];
  readonly evidenceBindings: readonly FindingLedger['evidenceBindings'][number][];
  readonly lifecycleReservations: readonly FindingLedger['lifecycleReservations'][number][];
  readonly lifecycleEvents: readonly FindingLedger['lifecycleEvents'][number][];
  readonly rawFindings: readonly FindingLedger['rawFindings'][number][];
  readonly conflicts: readonly FindingLedger['conflicts'][number][];
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

function assertCanonicalIds(ids: readonly string[], label: string): void {
  const canonical = [...new Set(ids)].sort(compareBinaryStrings);
  if (
    canonical.length !== ids.length
    || canonical.some((id, index) => id !== ids[index])
  ) {
    throw new Error(`${label} must be a binary-sorted unique set`);
  }
}

function assertTargetHead(target: FindingLifecycleMutationTarget): void {
  const head = target.expectedHead;
  if (head === null) {
    return;
  }
  if (head.entityKind !== target.entityKind || head.entityId !== target.entityId) {
    throw new Error(`Lifecycle target "${target.entityId}" has a mismatched expected head`);
  }
}

function assertCanonicalTargets(
  operation: FindingLifecycleOperation,
  targets: readonly FindingLifecycleMutationTarget[],
): void {
  if (targets.length === 0) {
    throw new Error(`Lifecycle operation "${operation}" requires at least one target`);
  }
  const contract = FINDING_LIFECYCLE_OPERATION_CONTRACTS[operation];
  const canonical = sortFindingLifecycleTargets(targets);
  const keys = new Set<string>();
  targets.forEach((target, index) => {
    assertTargetHead(target);
    if (target.expectedHead === null && !contract.allowsCreate) {
      throw new Error(`Lifecycle operation "${operation}" cannot create "${target.entityId}"`);
    }
    const key = targetKey(target);
    if (keys.has(key)) {
      throw new Error(`Lifecycle operation "${operation}" contains duplicate target "${target.entityId}"`);
    }
    keys.add(key);
    if (targetKey(canonical[index]!) !== key) {
      throw new Error(`Lifecycle operation "${operation}" targets are not canonical`);
    }
  });
  const findingTargets = targets.filter((target) => target.entityKind === 'finding');
  const conflictTargets = targets.filter((target) => target.entityKind === 'conflict');
  switch (contract.targetShape) {
    case 'multiple_findings':
      if (findingTargets.length < 2 || conflictTargets.length !== 0) {
        throw new Error(`Lifecycle operation "${operation}" requires at least two finding targets`);
      }
      break;
    case 'conflict_and_its_findings':
      if (conflictTargets.length !== 1 || findingTargets.length === 0) {
        throw new Error(
          `Lifecycle operation "${operation}" requires one conflict and at least one finding target`,
        );
      }
      break;
    case 'one_finding_and_one_conflict':
      if (findingTargets.length !== 1 || conflictTargets.length !== 1) {
        throw new Error(
          `Lifecycle operation "${operation}" requires exactly one finding and one conflict target`,
        );
      }
      break;
    case 'one_finding':
      if (findingTargets.length !== 1 || conflictTargets.length !== 0) {
        throw new Error(`Lifecycle operation "${operation}" requires exactly one finding target`);
      }
      break;
    case 'one_conflict':
      if (findingTargets.length !== 0 || conflictTargets.length !== 1) {
        throw new Error(`Lifecycle operation "${operation}" requires exactly one conflict target`);
      }
  }
}

function assertReservationContext(
  reservation: FindingLedger['lifecycleReservations'][number],
  conflicts: readonly FindingLedger['conflicts'][number][],
): void {
  const targetKeys = new Set(reservation.targets.map(targetKey));
  if (reservation.context.kind === 'conflict_adjudication') {
    const context = reservation.context;
    const conflict = conflicts.find(
      (candidate) => candidate.id === context.conflictId,
    );
    if (
      reservation.operation !== 'apply_conflict_adjudication'
      || reservation.authority.kind !== 'conflict_adjudication'
      || conflict === undefined
      || reservation.authority.conflictId !== context.conflictId
      || reservation.authority.evidenceHash !== context.evidenceHash
      || reservation.authority.originStep !== context.originStep
      || !sameValue(
        reservation.authority.inputBindingIds,
        reservation.evidenceBindingIds,
      )
      || !sameValue(
        reservation.authority.findingIds,
        conflict.findingIds,
      )
      || !sameValue(
        conflict.findingIds,
        reservation.targets
          .filter((target) => target.entityKind === 'finding')
          .map((target) => target.entityId),
      )
      || !targetKeys.has(targetKey({
        entityKind: 'conflict',
        entityId: context.conflictId,
      }))
    ) {
      throw new Error(`Lifecycle reservation "${reservation.reservationId}" has an invalid conflict adjudication context`);
    }
    return;
  }
  if (reservation.operation === 'apply_conflict_adjudication') {
    throw new Error(`Lifecycle reservation "${reservation.reservationId}" requires an operation-specific context`);
  }
  if (reservation.authority.kind === 'conflict_adjudication') {
    throw new Error(`Lifecycle reservation "${reservation.reservationId}" has an invalid transaction authority`);
  }
}

function assertRawEvidenceBinding(input: {
  binding: FindingEvidenceBinding;
  record: FindingEvidenceRecord;
  raw: RawFinding;
  findingsById: ReadonlyMap<string, FindingLedger['findings'][number]>;
}): void {
  if (input.binding.sourceRawIntegrityDigest !== computeRawFindingIntegrityDigest(input.raw)) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" has stale raw finding integrity`);
  }
  const claimIdentityHash = input.raw.claimIdentityHash;
  if (input.binding.claimIdentityHash !== claimIdentityHash) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" does not match its raw claim identity`);
  }
  if (!input.raw.evidence.some((evidence) => (
    evidenceRecordMatchesRawEvidence(input.record, evidence)
  ))) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" is not present in its raw evidence set`);
  }
  if (
    input.record.kind === 'engine_proof'
    && input.record.targetFindingId !== input.raw.targetFindingId
  ) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" has an invalid engine proof target`);
  }
  const operation = input.binding.operation;
  const target = input.binding.target;
  const validRelation = (() => {
    if (target.entityKind === 'conflict') {
      return operation === 'create_conflict' || (
        (
          operation === 'observe_conflict'
          || operation === 'apply_conflict_adjudication'
          || operation === 'apply_resolution_renotification'
        )
        && input.raw.targetFindingId !== null
      );
    }
    if (operation === 'create_finding') {
      return (
        input.raw.relation === 'new'
        && input.raw.targetFindingId === null
      ) || (
        (input.raw.relation === 'persists' || input.raw.relation === 'reopened')
        && input.raw.targetFindingId !== null
      );
    }
    if (operation === 'update_provisional') {
      return true;
    }
    if (operation === 'persist_finding' || operation === 'record_rejected_observation') {
      return (
        operation === 'persist_finding'
        && input.raw.relation === 'new'
        && input.raw.targetFindingId === null
      ) || (
        input.raw.relation === 'persists'
        && (
          input.raw.targetFindingId === target.entityId
          || (
            operation === 'persist_finding'
            && input.findingsById.get(target.entityId)?.rawFindingIds.includes(
              input.raw.rawFindingId,
            ) === true
          )
          || (
            operation === 'persist_finding'
            && input.findingsById.get(target.entityId)?.description !== undefined
            && input.findingsById.get(target.entityId)?.claimIdentityHash
              === input.raw.claimIdentityHash
          )
        )
      );
    }
    if (operation === 'resolve_finding') {
      return (
        input.raw.relation === 'resolution_confirmation'
        && input.raw.targetFindingId === target.entityId
      ) || (
        input.raw.relation === 'new'
        && input.raw.targetFindingId === null
        && input.findingsById.get(target.entityId)?.provisional !== undefined
        && input.raw.claimIdentityHash
          === input.findingsById.get(target.entityId)?.claimIdentityHash
      );
    }
    if (operation === 'reopen_finding') {
      return input.raw.relation === 'reopened' && input.raw.targetFindingId === target.entityId;
    }
    if (operation === 'promote_provisional') {
      return input.raw.relation === 'persists'
        && input.raw.targetFindingId === target.entityId;
    }
    if (
      operation === 'waive_finding'
      || operation === 'invalidate_finding'
      || operation === 'supersede_findings'
      || operation === 'dismiss_finding'
      || operation === 'record_dispute'
      || operation === 'record_recovery_attempt'
    ) {
      return false;
    }
    return operation === 'apply_resolution_renotification';
  })();
  if (!validRelation) {
    throw new Error(
      `Evidence binding "${input.binding.bindingId}" uses raw relation "${input.raw.relation}" for ineligible operation "${operation}"`,
    );
  }
}

function assertEngineProofWithoutRaw(input: {
  binding: FindingEvidenceBinding;
  record: FindingEvidenceRecord;
}): void {
  if (input.record.kind !== 'engine_proof') {
    throw new Error(`Evidence binding "${input.binding.bindingId}" has no source raw finding`);
  }
  const target = input.binding.target;
  const expectedTargetFindingId = target.entityKind === 'finding'
    && target.expectedHead !== null
    ? target.entityId
    : null;
  if (input.record.targetFindingId !== expectedTargetFindingId) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" has an invalid engine proof target`);
  }
}

function assertBindingSemantics(input: {
  binding: FindingEvidenceBinding;
  evidenceRecordsById: ReadonlyMap<string, FindingEvidenceRecord>;
  rawFindingsById: ReadonlyMap<string, RawFinding>;
  findingsById: ReadonlyMap<string, FindingLedger['findings'][number]>;
}): void {
  const record = input.evidenceRecordsById.get(input.binding.evidenceId);
  if (record === undefined) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" references unknown evidence "${input.binding.evidenceId}"`);
  }
  const recordViolation = findingEvidenceRecordIdentityViolation(record);
  if (recordViolation !== undefined) {
    throw new Error(recordViolation);
  }
  if (record.claimIdentityHash !== input.binding.claimIdentityHash) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" has a mismatched claim identity`);
  }
  if (input.binding.sourceRawFindingId === null) {
    if (input.binding.sourceRawIntegrityDigest !== null) {
      throw new Error(`Evidence binding "${input.binding.bindingId}" has raw integrity without a raw finding`);
    }
    assertEngineProofWithoutRaw({ binding: input.binding, record });
    return;
  }
  if (input.binding.sourceRawIntegrityDigest === null) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" is missing raw finding integrity`);
  }
  const raw = input.rawFindingsById.get(input.binding.sourceRawFindingId);
  if (raw === undefined) {
    throw new Error(`Evidence binding "${input.binding.bindingId}" references unknown raw finding "${input.binding.sourceRawFindingId}"`);
  }
  assertRawEvidenceBinding({
    binding: input.binding,
    record,
    raw,
    findingsById: input.findingsById,
  });
}

function assertEngineProofOperation(input: {
  operation: FindingLifecycleOperation;
  target: FindingLifecycleMutationTarget;
  targets: readonly FindingLifecycleMutationTarget[];
  record: Extract<FindingEvidenceRecord, { kind: 'engine_proof' }>;
}): void {
  const reject = (): never => {
    throw new Error(
      `Engine proof verifier "${input.record.verifierId}@${input.record.verifierVersion}" subject "${input.record.subject.kind}" is not eligible for lifecycle operation "${input.operation}"`,
    );
  };
  if (
    input.record.purpose === 'claim_evidence'
  ) {
    const findingOperations: FindingLifecycleOperation[] = [
      'create_finding',
      'persist_finding',
      'resolve_finding',
      'reopen_finding',
      'update_provisional',
      'promote_provisional',
      'record_rejected_observation',
      'apply_resolution_renotification',
    ];
    const conflictOperations: FindingLifecycleOperation[] = [
      'create_conflict',
      'observe_conflict',
      'apply_resolution_renotification',
    ];
    if (
      (
        input.target.entityKind === 'finding'
        && !findingOperations.includes(input.operation)
      )
      || (
        input.target.entityKind === 'conflict'
        && !conflictOperations.includes(input.operation)
      )
    ) {
      reject();
    }
    return;
  }
  if (
    input.record.purpose !== 'lifecycle_authority'
    ||
    input.record.verifierId !== 'takt.finding-lifecycle-policy'
    || input.record.verifierVersion !== '1'
    || input.target.entityKind !== 'finding'
  ) {
    reject();
  }
  const subject = input.record.subject;
  switch (subject.kind) {
    case 'finding_provisional_isolation':
      if (
        input.operation !== 'update_provisional'
        || subject.findingId !== input.target.entityId
      ) {
        reject();
      }
      return;
    case 'finding_target_invalid':
      if (
        input.operation !== 'invalidate_finding'
        || subject.findingId !== input.target.entityId
        || input.targets.length !== 1
      ) {
        reject();
      }
      return;
    case 'finding_claim_sets_equal': {
      const targetIds = input.targets.map((target) => target.entityId)
        .sort(compareBinaryStrings);
      if (
        input.operation !== 'supersede_findings'
        || !sameValue(subject.findingIds, targetIds)
      ) {
        reject();
      }
      return;
    }
    case 'finding_provisional_product_transition':
      if (
        input.operation !== subject.operation
        || (
          input.operation !== 'promote_provisional'
          && input.operation !== 'reopen_finding'
        )
        || subject.findingId !== input.target.entityId
        || input.targets.length !== 1
      ) {
        reject();
      }
      return;
    default:
      reject();
  }
}

export function assertEligibleEvidenceForLifecycleOperation(input: {
  operation: FindingLifecycleOperation;
  authority: FindingLifecycleAuthority;
  targets: readonly FindingLifecycleMutationTarget[];
  evidenceBindingIds: readonly string[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  evidenceRecords: readonly FindingEvidenceRecord[];
  rawFindings: readonly RawFinding[];
  findings: readonly FindingLedger['findings'][number][];
}): void {
  assertCanonicalTargets(input.operation, input.targets);
  assertCanonicalIds(input.evidenceBindingIds, 'Lifecycle evidence binding ids');
  const targetByKey = new Map(input.targets.map((target) => [targetKey(target), target]));
  const bindingsById = new Map(
    input.evidenceBindings.map((binding) => [binding.bindingId, binding]),
  );
  if (bindingsById.size !== input.evidenceBindings.length) {
    throw new Error('Lifecycle evidence bindings contain duplicate ids');
  }
  const evidenceRecordsById = new Map(
    input.evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const rawFindingsById = new Map(
    input.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  const findingsById = new Map(
    input.findings.map((finding) => [finding.id, finding]),
  );
  const coveredTargets = new Set<string>();
  for (const bindingId of input.evidenceBindingIds) {
    const binding = bindingsById.get(bindingId);
    if (binding === undefined) {
      throw new Error(`Lifecycle mutation references unknown evidence binding "${bindingId}"`);
    }
    const identityViolation = findingEvidenceBindingIdentityViolation(binding);
    if (identityViolation !== undefined) {
      throw new Error(identityViolation);
    }
    if (binding.operation !== input.operation) {
      throw new Error(
        `Evidence binding "${bindingId}" is not eligible for lifecycle operation "${input.operation}"`,
      );
    }
    const key = targetKey(binding.target);
    const target = targetByKey.get(key);
    if (target === undefined || !sameValue(binding.target, target)) {
      throw new Error(`Evidence binding "${bindingId}" targets a different entity premise`);
    }
    assertBindingSemantics({
      binding,
      evidenceRecordsById,
      rawFindingsById,
      findingsById,
    });
    const record = evidenceRecordsById.get(binding.evidenceId)!;
    if (record.kind === 'engine_proof') {
      assertEngineProofOperation({
        operation: input.operation,
        target,
        targets: input.targets,
        record,
      });
    }
    coveredTargets.add(key);
  }
  const contract = FINDING_LIFECYCLE_OPERATION_CONTRACTS[input.operation];
  const authorityContract = findingLifecycleAuthorityContract(input.authority);
  if (!contract.authorities.includes(authorityContract)) {
    throw new Error(
      `Lifecycle operation "${input.operation}" rejects authority "${authorityContract}"`,
    );
  }
  if (input.authority.kind === 'verified_evidence') {
    if (coveredTargets.size !== targetByKey.size) {
      const missingTargets = [...targetByKey.keys()]
        .filter((key) => !coveredTargets.has(key));
      throw new Error(
        `Lifecycle operation "${input.operation}" lacks eligible evidence for targets: ${missingTargets.join(', ')}`,
      );
    }
    return;
  }
  if (input.authority.kind === 'engine_policy') {
    if (input.authority.decisionKind === 'anchor_relevance') {
      if (
        input.evidenceBindingIds.length === 0
        || coveredTargets.size !== targetByKey.size
      ) {
        throw new Error(
          `Lifecycle operation "${input.operation}" lacks evidence for anchor relevance authority`,
        );
      }
      const boundRecordsByRawFindingId = new Map<string, FindingEvidenceRecord[]>();
      for (const bindingId of input.evidenceBindingIds) {
        const binding = bindingsById.get(bindingId)!;
        if (binding.sourceRawFindingId === null) {
          continue;
        }
        const records = boundRecordsByRawFindingId.get(binding.sourceRawFindingId) ?? [];
        records.push(evidenceRecordsById.get(binding.evidenceId)!);
        boundRecordsByRawFindingId.set(binding.sourceRawFindingId, records);
      }
      const anchorRawFindings = [...boundRecordsByRawFindingId.keys()]
        .map((rawFindingId) => rawFindingsById.get(rawFindingId))
        .filter((rawFinding): rawFinding is RawFinding => (
          rawFinding?.target.kind === 'absence'
        ));
      if (anchorRawFindings.length === 0) {
        throw new Error(
          `Lifecycle operation "${input.operation}" has anchor relevance authority without an absence raw finding`,
        );
      }
      for (const rawFinding of anchorRawFindings) {
        const records = boundRecordsByRawFindingId.get(rawFinding.rawFindingId) ?? [];
        const hasCompleteQuery = records.some((record) => (
          record.kind === 'engine_proof'
          && record.purpose === 'claim_evidence'
          && record.subject.kind === 'repository_query'
          && record.subject.coverage === 'complete'
        ));
        const hasOriginalAnchor = records.some((record) => (
          record.kind === 'engine_proof'
          && record.purpose === 'claim_evidence'
          && record.subject.kind === 'authoritative_quote'
        ));
        if (!hasCompleteQuery || !hasOriginalAnchor) {
          throw new Error(
            `Absence raw finding "${rawFinding.rawFindingId}" lacks its complete query or original anchor binding`,
          );
        }
      }
      const expectedDigest = computeAnchorRelevanceDecisionDigest({
        operation: input.operation,
        rawFindings: anchorRawFindings,
        adjudications: input.authority.anchorAdjudications,
      });
      if (input.authority.decisionDigest !== expectedDigest) {
        throw new Error(
          `Lifecycle operation "${input.operation}" has a mismatched anchor relevance decision digest`,
        );
      }
      return;
    }
    if (input.evidenceBindingIds.length !== 0) {
      throw new Error(`Lifecycle operation "${input.operation}" has an invalid manager policy authority`);
    }
    return;
  }
  if (input.authority.kind === 'conflict_adjudication') {
    const authority = input.authority;
    if (
      input.operation !== 'apply_conflict_adjudication'
      || input.evidenceBindingIds.length === 0
      || !sameValue(input.authority.inputBindingIds, input.evidenceBindingIds)
      || !sameValue(
        authority.findingIds,
        input.targets
          .filter((target) => target.entityKind === 'finding')
          .map((target) => target.entityId),
      )
      || !input.targets.some((target) => (
        target.entityKind === 'conflict'
        && target.entityId === authority.conflictId
        && coveredTargets.has(targetKey(target))
      ))
    ) {
      throw new Error(`Lifecycle operation "${input.operation}" has invalid adjudication input authority`);
    }
    return;
  }
  if (input.authority.kind === 'rejected_observation') {
    const raw = rawFindingsById.get(input.authority.rawFindingId);
    if (
      input.evidenceBindingIds.length !== 0
      || raw === undefined
      || computeRawFindingIntegrityDigest(raw) !== input.authority.rawIntegrityDigest
    ) {
      throw new Error(
        `Lifecycle operation "${input.operation}" has invalid rejected observation authority`,
      );
    }
    return;
  }
  if (input.evidenceBindingIds.length !== 0) {
    throw new Error(`Lifecycle operation "${input.operation}" has invalid system authority`);
  }
}

function assertTransition(input: {
  target: FindingLifecycleMutationTarget;
  transition: FindingLedger['lifecycleEvents'][number]['transitions'][number];
  priorHead: FindingLifecycleEntityHead | undefined;
}): void {
  if (
    targetKey(input.transition.after) !== targetKey(input.target)
    || !sameValue(input.transition.before, input.target.expectedHead)
  ) {
    throw new Error(`Lifecycle event transition does not match target "${input.target.entityId}"`);
  }
  if (input.target.expectedHead === null) {
    if (input.priorHead !== undefined || input.transition.after.revision !== 1) {
      throw new Error(`Lifecycle create transition for "${input.target.entityId}" is invalid`);
    }
    return;
  }
  if (
    input.priorHead === undefined
    || !sameValue(input.priorHead, input.target.expectedHead)
    || input.transition.after.revision !== input.target.expectedHead.revision + 1
  ) {
    throw new Error(`Lifecycle event chain for "${input.target.entityId}" has a stale expected head`);
  }
}

function assertReservationTargetPremise(input: {
  target: FindingLifecycleMutationTarget;
  priorHead: FindingLifecycleEntityHead | undefined;
}): void {
  if (input.target.expectedHead === null) {
    if (input.priorHead !== undefined) {
      throw new Error(
        `Lifecycle reservation premise for "${input.target.entityId}" expected an absent head`,
      );
    }
    return;
  }
  if (
    input.priorHead === undefined
    || !sameValue(input.priorHead, input.target.expectedHead)
  ) {
    throw new Error(
      `Lifecycle reservation premise for "${input.target.entityId}" has a stale expected head`,
    );
  }
}

function assertEventOutcome(
  reservation: FindingLedger['lifecycleReservations'][number],
  event: FindingLedger['lifecycleEvents'][number],
  conflicts: readonly FindingLedger['conflicts'][number][],
): void {
  if (reservation.authority.kind === 'conflict_adjudication') {
    if (
      event.outcome.kind !== 'conflict_adjudication'
      || event.outcome.conflictId !== reservation.authority.conflictId
      || event.outcome.evidenceHash !== reservation.authority.evidenceHash
    ) {
      throw new Error(`Lifecycle event "${event.eventId}" has an invalid adjudication outcome`);
    }
    const outcome = event.outcome;
    const adjudication = conflicts
      .find((conflict) => conflict.id === outcome.conflictId)
      ?.adjudications?.find((record) => (
        record.evidenceHash === outcome.evidenceHash
      ));
    if (adjudication?.outcome !== outcome.outcome) {
      throw new Error(`Lifecycle event "${event.eventId}" has no matching closed adjudication record`);
    }
    return;
  }
  if (event.outcome.kind !== 'projection_applied') {
    throw new Error(`Lifecycle event "${event.eventId}" has an unexpected specialized outcome`);
  }
}

export function assertFindingLifecycleAuthorityInvariant(
  ledger: FindingLifecycleAuthorityProjection,
): void {
  const evidenceRecordsById = new Map(
    ledger.evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const rawFindingsById = new Map(
    ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  const findingsById = new Map(
    ledger.findings.map((finding) => [finding.id, finding]),
  );
  const bindingsById = new Map<string, FindingEvidenceBinding>();
  for (const binding of ledger.evidenceBindings) {
    const violation = findingEvidenceBindingIdentityViolation(binding);
    if (violation !== undefined) {
      throw new Error(violation);
    }
    if (bindingsById.has(binding.bindingId)) {
      throw new Error(`Duplicate evidence binding "${binding.bindingId}"`);
    }
    assertBindingSemantics({
      binding,
      evidenceRecordsById,
      rawFindingsById,
      findingsById,
    });
    bindingsById.set(binding.bindingId, binding);
  }

  const reservationsById = new Map<string, FindingLedger['lifecycleReservations'][number]>();
  const reservationMutationIds = new Set<string>();
  const referencedBindingIds = new Set<string>();
  for (const reservation of ledger.lifecycleReservations) {
    const violation = findingLifecycleReservationIdentityViolation(reservation);
    if (violation !== undefined) {
      throw new Error(violation);
    }
    if (
      reservationsById.has(reservation.reservationId)
      || reservationMutationIds.has(reservation.mutationId)
    ) {
      throw new Error(`Duplicate lifecycle reservation or mutation "${reservation.mutationId}"`);
    }
    assertReservationContext(reservation, ledger.conflicts);
    assertEligibleEvidenceForLifecycleOperation({
      operation: reservation.operation,
      authority: reservation.authority,
      targets: reservation.targets,
      evidenceBindingIds: reservation.evidenceBindingIds,
      evidenceBindings: ledger.evidenceBindings,
      evidenceRecords: ledger.evidenceRecords,
      rawFindings: ledger.rawFindings,
      findings: ledger.findings,
    });
    reservation.evidenceBindingIds.forEach((bindingId) => referencedBindingIds.add(bindingId));
    reservationsById.set(reservation.reservationId, reservation);
    reservationMutationIds.add(reservation.mutationId);
  }
  for (const bindingId of bindingsById.keys()) {
    if (!referencedBindingIds.has(bindingId)) {
      throw new Error(`Evidence binding "${bindingId}" is not owned by a lifecycle reservation`);
    }
  }

  const eventIds = new Set<string>();
  const eventMutationIds = new Set<string>();
  const consumedReservationIds = new Set<string>();
  const consumedBindingIds = new Set<string>();
  const heads = new Map<string, FindingLifecycleEntityHead>();
  for (const event of ledger.lifecycleEvents) {
    const violation = findingLifecycleEventIdentityViolation(event);
    if (violation !== undefined) {
      throw new Error(violation);
    }
    if (eventIds.has(event.eventId) || eventMutationIds.has(event.mutationId)) {
      throw new Error(`Duplicate lifecycle event or mutation "${event.mutationId}"`);
    }
    const reservation = reservationsById.get(event.reservationId);
    if (
      reservation === undefined
      || reservation.mutationId !== event.mutationId
      || reservation.operation !== event.operation
      || !sameValue(reservation.evidenceBindingIds, event.evidenceBindingIds)
      || event.resultDigest !== computeFindingLifecycleHeadResultDigest(
        event.transitions.map((transition) => transition.after),
      )
    ) {
      throw new Error(`Lifecycle event "${event.eventId}" does not match its reservation`);
    }
    if (consumedReservationIds.has(event.reservationId)) {
      throw new Error(`Lifecycle reservation "${event.reservationId}" was consumed more than once`);
    }
    assertEventOutcome(reservation, event, ledger.conflicts);
    const reservationTargets = new Map(
      reservation.targets.map((target, index) => [targetKey(target), { target, index }]),
    );
    const transitionKeys = new Set<string>();
    let lastReservationIndex = -1;
    reservation.targets.forEach((target) => {
      assertReservationTargetPremise({
        target,
        priorHead: heads.get(targetKey(target)),
      });
    });
    event.transitions.forEach((transition) => {
      const key = targetKey(transition.after);
      const reserved = reservationTargets.get(key);
      if (
        reserved === undefined
        || transitionKeys.has(key)
        || reserved.index <= lastReservationIndex
      ) {
        throw new Error(`Lifecycle event "${event.eventId}" changed an unreserved target`);
      }
      assertTransition({ target: reserved.target, transition, priorHead: heads.get(key) });
      heads.set(key, transition.after);
      transitionKeys.add(key);
      lastReservationIndex = reserved.index;
    });
    event.evidenceBindingIds.forEach((bindingId) => consumedBindingIds.add(bindingId));
    eventIds.add(event.eventId);
    eventMutationIds.add(event.mutationId);
    consumedReservationIds.add(event.reservationId);
  }

  const entities = [
    ...ledger.findings.map((finding) => ({
      entityKind: 'finding' as const,
      entityId: finding.id,
      projection: finding,
    })),
    ...ledger.conflicts.map((conflict) => ({
      entityKind: 'conflict' as const,
      entityId: conflict.id,
      projection: conflict,
    })),
  ];
  const entityKeys = new Set(entities.map((entity) => targetKey(entity)));
  for (const entity of entities) {
    const key = targetKey(entity);
    const head = heads.get(key);
    if (
      head === undefined
      || head.revision !== entity.projection.revision
      || head.projectionDigest !== computeFindingLifecycleProjectionDigest(entity.projection)
    ) {
      throw new Error(`Lifecycle head "${key}" does not match the current entity projection`);
    }
  }
  for (const key of heads.keys()) {
    if (!entityKeys.has(key)) {
      throw new Error(`Lifecycle head "${key}" has no current entity projection`);
    }
  }
  for (const bindingId of consumedBindingIds) {
    const binding = bindingsById.get(bindingId)!;
    if (binding.target.entityKind !== 'finding') {
      continue;
    }
    const finding = ledger.findings.find((entry) => entry.id === binding.target.entityId);
    if (finding === undefined || !finding.evidenceIds.includes(binding.evidenceId)) {
      throw new Error(`Evidence binding "${binding.bindingId}" is not retained by its finding projection`);
    }
  }
}
