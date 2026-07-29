import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { computeClaimIdentityHash } from '../../models/finding-claim-identity.js';
import {
  evidenceRecordMatchesRawEvidence,
} from '../../models/finding-evidence-record.js';
import {
  createFindingEvidenceBinding,
  createFindingLifecycleReservation,
  sortFindingLifecycleTargets,
} from '../../models/finding-lifecycle-identity.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import {
  FindingLedgerConflictSchema,
  FindingLedgerEntrySchema,
} from '../../models/finding-schemas.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingLifecycleMutationTarget,
  FindingLifecycleEntityHead,
  FindingLifecycleOperation,
  FindingLifecycleAuthority,
  FindingLifecycleReservationContext,
  FindingObservation,
  RawFinding,
} from './types.js';
import {
  applyVerifiedLifecycleMutation,
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from './lifecycle-mutation.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';
import { captureReviewScopeSnapshot } from './snapshot.js';

function targetKey(target: { entityKind: string; entityId: string }): string {
  return `${target.entityKind}\0${target.entityId}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function changedEntities<T extends { id: string }>(
  current: readonly T[],
  next: readonly T[],
  parseProjection: (value: unknown) => T,
  entityKind: 'finding' | 'conflict',
): T[] {
  const currentById = new Map(
    current.map((entity) => {
      const parsed = parseProjection(JSON.parse(JSON.stringify(entity)));
      return [parsed.id, parsed] as const;
    }),
  );
  const nextById = new Map(
    next.map((entity) => {
      const parsed = parseProjection(JSON.parse(JSON.stringify(entity)));
      return [parsed.id, parsed] as const;
    }),
  );
  const ids = [...new Set([
    ...currentById.keys(),
    ...nextById.keys(),
  ])].sort(compareBinaryStrings);
  return ids.flatMap((id) => {
    const existing = currentById.get(id);
    const proposed = nextById.get(id);
    if (existing !== undefined && proposed === undefined) {
      throw new Error(`Lifecycle transaction cannot delete ${entityKind} projection "${id}"`);
    }
    if (proposed === undefined || (existing !== undefined && sameValue(existing, proposed))) {
      return [];
    }
    return [proposed];
  });
}

function collectChangedFindings(
  current: readonly FindingLedgerEntry[],
  next: readonly FindingLedgerEntry[],
): FindingLedgerEntry[] {
  return changedEntities(
    current,
    next,
    (value) => FindingLedgerEntrySchema.parse(value),
    'finding',
  );
}

function collectChangedConflicts(
  current: readonly FindingLedgerConflict[],
  next: readonly FindingLedgerConflict[],
): FindingLedgerConflict[] {
  return changedEntities(
    current,
    next,
    (value) => FindingLedgerConflictSchema.parse(value),
    'conflict',
  );
}

function lifecycleTargets(input: {
  current: FindingLedger;
  findings: readonly FindingLedgerEntry[];
  conflicts: readonly FindingLedgerConflict[];
  expectedHeadsByTarget?: ReadonlyMap<string, FindingLifecycleEntityHead | null>;
}): FindingLifecycleMutationTarget[] {
  const expectedHead = (
    entityKind: 'finding' | 'conflict',
    entityId: string,
  ): FindingLifecycleEntityHead | null => {
    const key = targetKey({ entityKind, entityId });
    return input.expectedHeadsByTarget?.has(key)
      ? input.expectedHeadsByTarget.get(key) ?? null
      : captureFindingLifecycleHead(input.current, entityKind, entityId) ?? null;
  };
  return sortFindingLifecycleTargets([
    ...input.findings.map((finding) => ({
      entityKind: 'finding' as const,
      entityId: finding.id,
      expectedHead: expectedHead('finding', finding.id),
    })),
    ...input.conflicts.map((conflict) => ({
      entityKind: 'conflict' as const,
      entityId: conflict.id,
      expectedHead: expectedHead('conflict', conflict.id),
    })),
  ]);
}

function evidenceRecordMatchesRawClaim(
  record: FindingEvidenceRecord,
  raw: RawFinding,
): boolean {
  return (
    record.claimIdentityHash === computeClaimIdentityHash(raw)
    && raw.evidence.some((evidence) => evidenceRecordMatchesRawEvidence(record, evidence))
  );
}

function rawSourceForRecord(input: {
  rawFindings: readonly RawFinding[];
  preferredRawFindingIds: ReadonlySet<string>;
  record: FindingEvidenceRecord;
}): RawFinding | undefined {
  const candidates = [
    ...input.rawFindings.filter((raw) => input.preferredRawFindingIds.has(raw.rawFindingId)),
    ...input.rawFindings.filter((raw) => !input.preferredRawFindingIds.has(raw.rawFindingId)),
  ];
  return candidates.find((raw) => (
    evidenceRecordMatchesRawClaim(input.record, raw)
    && (
      input.record.kind !== 'engine_proof'
      || input.record.targetFindingId === raw.targetFindingId
    )
  ));
}

export interface LifecycleEvidenceSource {
  sourceRawFindingIds: readonly string[];
  authorityEvidenceIds: readonly string[];
}

type LifecycleAuthorityInput =
  | Exclude<FindingLifecycleAuthority, { kind: 'conflict_adjudication' }>
  | Omit<Extract<FindingLifecycleAuthority, { kind: 'conflict_adjudication' }>, 'inputBindingIds'>;

export interface FindingLifecycleCommand {
  operation: FindingLifecycleOperation;
  changes: {
    findings: readonly Omit<FindingLedgerEntry, 'revision'>[];
    conflicts: readonly Omit<FindingLedgerConflict, 'revision'>[];
  };
  authority: LifecycleAuthorityInput;
  evidenceSourcesByTarget: ReadonlyMap<string, LifecycleEvidenceSource>;
  expectedHeadsByTarget?: ReadonlyMap<string, FindingLifecycleEntityHead | null>;
  conflictEvidencePrecondition?: {
    conflictId: string;
    evidenceSetHash: string;
    cwd: string;
  };
  reservedMutationId?: string;
}

function assertConflictEvidencePrecondition(
  ledger: FindingLedger,
  command: FindingLifecycleCommand,
): void {
  const precondition = command.conflictEvidencePrecondition;
  if (precondition === undefined) {
    return;
  }
  if (
    command.operation !== 'resolve_conflict'
    || !command.changes.conflicts.some(
      (conflict) => conflict.id === precondition.conflictId,
    )
  ) {
    throw new Error('Conflict evidence precondition is only valid for its resolve command');
  }
  const conflict = ledger.conflicts.find(
    (candidate) => candidate.id === precondition.conflictId,
  );
  const freshEvidenceSetHash = conflict === undefined
    ? null
    : computeConflictEvidenceHash(
        conflict,
        ledger,
        captureReviewScopeSnapshot(precondition.cwd).reviewScopeSnapshotId,
      );
  if (freshEvidenceSetHash !== precondition.evidenceSetHash) {
    throw new Error(
      `Conflict evidence dependency CAS failed for "${precondition.conflictId}"`,
    );
  }
}

export function reserveFindingConflictAdjudicationLifecycle(input: {
  ledger: FindingLedger;
  conflictId: string;
  evidenceHash: string;
  originStep: string | null;
  reservedAt: FindingObservation;
}): {
  ledger: FindingLedger;
  mutationId: string;
} {
  const conflict = input.ledger.conflicts.find(
    (candidate) => candidate.id === input.conflictId,
  );
  if (conflict === undefined || conflict.status !== 'active') {
    throw new Error(`Cannot reserve inactive conflict "${input.conflictId}" for adjudication`);
  }
  const findings = conflict.findingIds.map((findingId) => {
    const finding = input.ledger.findings.find((candidate) => candidate.id === findingId);
    if (finding === undefined) {
      throw new Error(
        `Conflict adjudication reservation references unknown finding "${findingId}"`,
      );
    }
    return finding;
  });
  const targets = lifecycleTargets({
    current: input.ledger,
    findings,
    conflicts: [conflict],
  });
  const bindings = evidenceBindings({
    ledger: input.ledger,
    operation: 'apply_conflict_adjudication',
    targets,
    evidenceSourcesByTarget: new Map([[
      `conflict\0${conflict.id}`,
      {
        sourceRawFindingIds: conflict.rawFindingIds,
        authorityEvidenceIds: [],
      },
    ]]),
  });
  const authority: FindingLifecycleAuthority = {
    kind: 'conflict_adjudication',
    conflictId: conflict.id,
    findingIds: [...conflict.findingIds],
    evidenceHash: input.evidenceHash,
    inputBindingIds: bindings.map((binding) => binding.bindingId),
    originStep: input.originStep,
  };
  const reservation = createFindingLifecycleReservation({
    operation: 'apply_conflict_adjudication',
    targets,
    evidenceBindingIds: authority.inputBindingIds,
    authority,
    context: {
      kind: 'conflict_adjudication',
      conflictId: conflict.id,
      evidenceHash: input.evidenceHash,
      originStep: input.originStep,
    },
    reservedAt: input.reservedAt,
  });
  return {
    ledger: reserveVerifiedLifecycleMutation(input.ledger, {
      reservation,
      evidenceBindings: bindings,
    }),
    mutationId: reservation.mutationId,
  };
}

function targetEvidence(input: {
  ledger: FindingLedger;
  target: FindingLifecycleMutationTarget;
  evidenceSource: LifecycleEvidenceSource;
}): {
  evidenceIds: string[];
  preferredRawFindingIds: Set<string>;
} {
  const rawFindings = input.evidenceSource.sourceRawFindingIds.map((rawFindingId) => {
    const raw = input.ledger.rawFindings.find((candidate) => candidate.rawFindingId === rawFindingId);
    if (raw === undefined) {
      throw new Error(`Lifecycle evidence source references unknown raw finding "${rawFindingId}"`);
    }
    return raw;
  });
  const rawEvidenceIds = input.ledger.evidenceRecords.flatMap((record) => (
    rawFindings.some((raw) => evidenceRecordMatchesRawClaim(record, raw))
      ? [record.evidenceId]
      : []
  ));
  return {
    evidenceIds: [...new Set([
      ...rawEvidenceIds,
      ...input.evidenceSource.authorityEvidenceIds,
    ])]
      .sort(compareBinaryStrings),
    preferredRawFindingIds: new Set(input.evidenceSource.sourceRawFindingIds),
  };
}

function evidenceBindings(input: {
  ledger: FindingLedger;
  operation: FindingLifecycleOperation;
  targets: readonly FindingLifecycleMutationTarget[];
  evidenceSourcesByTarget: ReadonlyMap<string, LifecycleEvidenceSource>;
}): FindingEvidenceBinding[] {
  const evidenceRecordsById = new Map(
    input.ledger.evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const bindings = input.targets.flatMap((target) => {
    const evidenceSource = input.evidenceSourcesByTarget.get(targetKey(target)) ?? {
      sourceRawFindingIds: [],
      authorityEvidenceIds: [],
    };
    const evidence = targetEvidence({
      ledger: input.ledger,
      target,
      evidenceSource,
    });
    return evidence.evidenceIds.flatMap((evidenceId) => {
      const record = evidenceRecordsById.get(evidenceId);
      if (record === undefined) {
        throw new Error(`Lifecycle transaction references unknown evidence "${evidenceId}"`);
      }
      const raw = rawSourceForRecord({
        rawFindings: input.ledger.rawFindings,
        preferredRawFindingIds: evidence.preferredRawFindingIds,
        record,
      });
      if (raw === undefined && record.kind !== 'engine_proof') {
        return [];
      }
      return [createFindingEvidenceBinding({
        evidenceId,
        claimIdentityHash: record.claimIdentityHash,
        sourceRawFindingId: raw?.rawFindingId ?? null,
        sourceRawIntegrityDigest: raw === undefined
          ? null
          : computeRawFindingIntegrityDigest(raw),
        operation: input.operation,
        target,
      })];
    });
  });
  return [...new Map(bindings.map((binding) => [binding.bindingId, binding])).values()]
    .sort((left, right) => compareBinaryStrings(left.bindingId, right.bindingId));
}

function commandContext(
  authority: LifecycleAuthorityInput,
): FindingLifecycleReservationContext {
  return authority.kind === 'conflict_adjudication'
    ? {
        kind: 'conflict_adjudication',
        conflictId: authority.conflictId,
        evidenceHash: authority.evidenceHash,
        originStep: authority.originStep,
      }
    : { kind: 'transaction' };
}

function commandChanges(
  ledger: FindingLedger,
  command: FindingLifecycleCommand,
): {
  findings: FindingLedgerEntry[];
  conflicts: FindingLedgerConflict[];
} {
  return {
    findings: command.changes.findings.map((finding) => {
      const head = captureFindingLifecycleHead(ledger, 'finding', finding.id);
      return FindingLedgerEntrySchema.parse(JSON.parse(JSON.stringify({
        ...finding,
        revision: head === undefined ? 1 : head.revision + 1,
      })));
    }),
    conflicts: command.changes.conflicts.map((conflict) => {
      const head = captureFindingLifecycleHead(ledger, 'conflict', conflict.id);
      return FindingLedgerConflictSchema.parse(JSON.parse(JSON.stringify({
        ...conflict,
        revision: head === undefined ? 1 : head.revision + 1,
      })));
    }),
  };
}

export function applyFindingLifecycleCommands(input: {
  ledger: FindingLedger;
  commands: readonly FindingLifecycleCommand[];
  occurredAt: FindingObservation;
}): FindingLedger {
  let ledger = input.ledger;
  for (const command of input.commands) {
    assertConflictEvidencePrecondition(ledger, command);
    const changes = commandChanges(ledger, command);
    if (command.reservedMutationId !== undefined) {
      const reservation = ledger.lifecycleReservations.find(
        (candidate) => candidate.mutationId === command.reservedMutationId,
      );
      if (reservation === undefined) {
        throw new Error(
          `Lifecycle command references missing pre-reservation "${command.reservedMutationId}"`,
        );
      }
      if (
        reservation.operation !== command.operation
        || !sameValue(reservation.context, commandContext(command.authority))
      ) {
        throw new Error(
          `Lifecycle command no longer matches pre-reservation "${command.reservedMutationId}"`,
        );
      }
      ledger = applyVerifiedLifecycleMutation(ledger, {
        mutationId: reservation.mutationId,
        findings: changes.findings,
        conflicts: changes.conflicts,
        occurredAt: input.occurredAt,
      });
      continue;
    }
    const targets = lifecycleTargets({
      current: ledger,
      findings: changes.findings,
      conflicts: changes.conflicts,
      expectedHeadsByTarget: command.expectedHeadsByTarget,
    });
    const bindings = evidenceBindings({
      ledger,
      operation: command.operation,
      targets,
      evidenceSourcesByTarget: command.evidenceSourcesByTarget,
    });
    const authority = command.authority.kind === 'conflict_adjudication'
      ? {
          ...command.authority,
          inputBindingIds: bindings.map((binding) => binding.bindingId),
        }
      : command.authority;
    const reservation = createFindingLifecycleReservation({
      operation: command.operation,
      targets,
      evidenceBindingIds: bindings.map((binding) => binding.bindingId),
      authority,
      context: commandContext(command.authority),
      reservedAt: input.occurredAt,
    });
    const reserved = reserveVerifiedLifecycleMutation(ledger, {
      reservation,
      evidenceBindings: bindings,
    });
    ledger = applyVerifiedLifecycleMutation(reserved, {
      mutationId: reservation.mutationId,
      findings: changes.findings,
      conflicts: changes.conflicts,
      occurredAt: input.occurredAt,
    });
  }
  return ledger;
}

function transactionBase(current: FindingLedger, proposed: FindingLedger): FindingLedger {
  if (
    !sameValue(current.evidenceBindings, proposed.evidenceBindings)
    || !sameValue(current.lifecycleReservations, proposed.lifecycleReservations)
    || !sameValue(current.lifecycleEvents, proposed.lifecycleEvents)
    || !sameValue(current.rawRecoveryAttempts, proposed.rawRecoveryAttempts)
    || !sameValue(current.rawRecoveryResults, proposed.rawRecoveryResults)
  ) {
    throw new Error('Lifecycle transaction proposal cannot mutate authority registries directly');
  }
  return {
    ...proposed,
    findings: current.findings,
    conflicts: current.conflicts,
    evidenceBindings: current.evidenceBindings,
    lifecycleReservations: current.lifecycleReservations,
    lifecycleEvents: current.lifecycleEvents,
    rawRecoveryAttempts: current.rawRecoveryAttempts,
    rawRecoveryResults: current.rawRecoveryResults,
  };
}

export function mergeFindingLifecycleCommandState(
  current: FindingLedger,
  proposed: FindingLedger,
): FindingLedger {
  if (
    collectChangedFindings(current.findings, proposed.findings).length > 0
    || collectChangedConflicts(current.conflicts, proposed.conflicts).length > 0
  ) {
    throw new Error('Semantic lifecycle command stages left unapplied projection changes');
  }
  return transactionBase(current, proposed);
}

/**
 * Applies the reconciler-authored semantic command stream over the proposal's
 * non-projection state. The proposal is used only for the final exact
 * projection check; operation and authority are never inferred from it.
 */
export function applyManagerDecisionLifecycleCommands(input: {
  current: FindingLedger;
  proposed: FindingLedger;
  commands: readonly FindingLifecycleCommand[];
  occurredAt: FindingObservation;
}): FindingLedger {
  const ledger = applyFindingLifecycleCommands({
    ledger: transactionBase(input.current, input.proposed),
    commands: input.commands,
    occurredAt: input.occurredAt,
  });
  const unmatchedFindings = collectChangedFindings(ledger.findings, input.proposed.findings);
  const unmatchedConflicts = collectChangedConflicts(ledger.conflicts, input.proposed.conflicts);
  if (unmatchedFindings.length > 0 || unmatchedConflicts.length > 0) {
    throw new Error(
      'Manager semantic lifecycle commands do not exactly match the proposal: '
      + `findings=${unmatchedFindings.map((finding) => finding.id).join(',')}; `
      + `conflicts=${unmatchedConflicts.map((conflict) => conflict.id).join(',')}`,
    );
  }
  return ledger;
}
