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

function rawSourcesForRecord(input: {
  rawFindings: readonly RawFinding[];
  preferredRawFindingIds: ReadonlySet<string>;
  record: FindingEvidenceRecord;
}): RawFinding[] {
  if (
    input.preferredRawFindingIds.size === 0
    && input.record.kind === 'engine_proof'
    && input.record.subject.kind === 'finding_provisional_product_transition'
  ) {
    return [];
  }
  const matches = (raw: RawFinding): boolean => (
    evidenceRecordMatchesRawClaim(input.record, raw)
    && (
      input.record.kind !== 'engine_proof'
      || input.record.targetFindingId === raw.targetFindingId
    )
  );
  const preferred = input.rawFindings.filter((raw) => (
    input.preferredRawFindingIds.has(raw.rawFindingId) && matches(raw)
  ));
  if (preferred.length > 0) {
    return preferred;
  }
  const fallback = input.rawFindings.find((raw) => matches(raw));
  return fallback === undefined ? [] : [fallback];
}

function contributionOriginForRaw(
  ledger: FindingLedger,
  raw: RawFinding | undefined,
  interpretationCaseIdsByRawFindingId?: ReadonlyMap<string, string>,
): FindingEvidenceBinding['contributionOrigin'] {
  if (raw === undefined) {
    return { kind: 'external' };
  }
  const explicitCaseId = interpretationCaseIdsByRawFindingId?.get(raw.rawFindingId);
  if (explicitCaseId !== undefined) {
    return { kind: 'interpretation_case', caseId: explicitCaseId };
  }
  const observations = ledger.interpretationRawObservations.filter(
    (observation) => observation.rawFindingId === raw.rawFindingId,
  );
  if (observations.length > 1) {
    throw new Error(
      `Raw finding "${raw.rawFindingId}" has multiple interpretation observations`,
    );
  }
  const observation = observations[0];
  return observation === undefined
    ? { kind: 'external' }
    : { kind: 'interpretation_case', caseId: observation.caseId };
}

export interface LifecycleEvidenceSource {
  sourceRawFindingIds: readonly string[];
  authorityEvidenceIds: readonly string[];
}

export interface FindingLifecycleCommand {
  operation: FindingLifecycleOperation;
  changes: {
    findings: readonly Omit<FindingLedgerEntry, 'revision'>[];
    conflicts: readonly Omit<FindingLedgerConflict, 'revision'>[];
  };
  authority: FindingLifecycleAuthority;
  evidenceSourcesByTarget: ReadonlyMap<string, LifecycleEvidenceSource>;
  interpretationCaseIdsByRawFindingId?: ReadonlyMap<string, string>;
  expectedHeadsByTarget?: ReadonlyMap<string, FindingLifecycleEntityHead | null>;
  reservedMutationId?: string;
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
  interpretationCaseIdsByRawFindingId?: ReadonlyMap<string, string>;
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
      const raws = rawSourcesForRecord({
        rawFindings: input.ledger.rawFindings,
        preferredRawFindingIds: evidence.preferredRawFindingIds,
        record,
      });
      if (raws.length === 0 && record.kind !== 'engine_proof') {
        return [];
      }
      const bindingRaws = raws.length === 0 ? [undefined] : raws;
      return bindingRaws.map((raw) => createFindingEvidenceBinding({
        evidenceId,
        claimIdentityHash: record.claimIdentityHash,
        sourceRawFindingId: raw?.rawFindingId ?? null,
        sourceRawIntegrityDigest: raw === undefined
          ? null
          : computeRawFindingIntegrityDigest(raw),
        contributionOrigin: contributionOriginForRaw(
          input.ledger,
          raw,
          input.interpretationCaseIdsByRawFindingId,
        ),
        operation: input.operation,
        target,
      }));
    });
  });
  return [...new Map(bindings.map((binding) => [binding.bindingId, binding])).values()]
    .sort((left, right) => compareBinaryStrings(left.bindingId, right.bindingId));
}

function commandContext(
  _authority: FindingLifecycleAuthority,
): FindingLifecycleReservationContext {
  return { kind: 'transaction' };
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
      const current = ledger.findings.find((candidate) => candidate.id === finding.id);
      return FindingLedgerEntrySchema.parse(JSON.parse(JSON.stringify({
        ...finding,
        // A later command in the same lifecycle transaction must retain
        // evidence consumed by an earlier command. Assemble that monotonic
        // projection here, where both the current head and next command are
        // authoritative, instead of making each producer predict intermediate
        // proof ids.
        evidenceIds: [...new Set([
          ...(current?.evidenceIds ?? []),
          ...finding.evidenceIds,
        ])].sort(compareBinaryStrings),
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
      interpretationCaseIdsByRawFindingId: command.interpretationCaseIdsByRawFindingId,
    });
    const reservation = createFindingLifecycleReservation({
      operation: command.operation,
      targets,
      evidenceBindingIds: bindings.map((binding) => binding.bindingId),
      authority: command.authority,
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
