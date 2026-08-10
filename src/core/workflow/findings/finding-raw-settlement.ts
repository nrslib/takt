import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  FindingLedger,
  FindingRawObservationFailure,
  FindingRawObservationSettlement,
  FindingRawObservationSettlementDestinationKind,
  FindingRawObservationSettlementSummary,
} from './types.js';

export interface FindingRawObservationSettlementInput {
  rawFindingIds?: readonly string[];
  sourceRawFindingIds?: readonly string[];
  destination: {
    kind: FindingRawObservationSettlementDestinationKind;
    id: string;
  };
}

export class FindingRawObservationExactCoverError extends Error {
  readonly diagnostics: readonly string[];

  constructor(diagnostics: readonly string[]) {
    super(`Finding raw observation exact cover failed: ${diagnostics.join('; ')}`);
    this.name = 'FindingRawObservationExactCoverError';
    this.diagnostics = [...diagnostics];
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return sortedUnique(duplicates);
}

function normalizedSettlementRawFindingIds(
  settlement: FindingRawObservationSettlementInput,
  diagnostics: string[],
): string[] {
  const rawFindingIds = settlement.rawFindingIds ?? [];
  const sourceRawFindingIds = settlement.sourceRawFindingIds ?? [];
  for (const duplicate of duplicateValues(rawFindingIds)) {
    diagnostics.push(`duplicate rawFindingId "${duplicate}" within one settlement`);
  }
  for (const duplicate of duplicateValues(sourceRawFindingIds)) {
    diagnostics.push(`duplicate sourceRawFindingId "${duplicate}" within one settlement`);
  }
  return sortedUnique([...rawFindingIds, ...sourceRawFindingIds]);
}

function destinationKey(input: {
  kind: FindingRawObservationSettlementDestinationKind;
  id: string;
}): string {
  return `${input.kind}\0${input.id}`;
}

function aggregateSettlements(
  settlements: readonly FindingRawObservationSettlement[],
): FindingRawObservationSettlement[] {
  const rawIdsByDestination = new Map<string, {
    destination: FindingRawObservationSettlement['destination'];
    rawFindingIds: Set<string>;
  }>();
  for (const settlement of settlements) {
    const key = destinationKey(settlement.destination);
    const existing = rawIdsByDestination.get(key);
    if (existing === undefined) {
      rawIdsByDestination.set(key, {
        destination: settlement.destination,
        rawFindingIds: new Set(settlement.rawFindingIds),
      });
    } else {
      for (const rawFindingId of settlement.rawFindingIds) {
        existing.rawFindingIds.add(rawFindingId);
      }
    }
  }
  return [...rawIdsByDestination.values()]
    .map(({ destination, rawFindingIds }) => ({
      rawFindingIds: sortedUnique(rawFindingIds),
      destination,
    }))
    .sort((left, right) => (
      compareBinaryStrings(left.destination.kind, right.destination.kind)
      || compareBinaryStrings(left.destination.id, right.destination.id)
    ));
}

export function assertFindingRawObservationExactCover(input: {
  expectedRawFindingIds: readonly string[];
  settlements: readonly FindingRawObservationSettlementInput[];
  failures: readonly FindingRawObservationFailure[];
  knownDestinationIds?: ReadonlyMap<
    FindingRawObservationSettlementDestinationKind,
    ReadonlySet<string>
  >;
}): FindingRawObservationSettlementSummary {
  const expectedRawFindingIds = sortedUnique(input.expectedRawFindingIds);
  const expected = new Set(expectedRawFindingIds);
  const diagnostics: string[] = [];
  const occurrences = new Map<string, string[]>();
  const normalizedSettlements: FindingRawObservationSettlement[] = [];

  for (const settlement of input.settlements) {
    if (settlement.destination.id.length === 0) {
      diagnostics.push('settlement destination id must be non-empty');
    }
    const knownIds = input.knownDestinationIds?.get(settlement.destination.kind);
    if (knownIds !== undefined && !knownIds.has(settlement.destination.id)) {
      diagnostics.push(
        `settlement destination ${settlement.destination.kind}:${settlement.destination.id} is not present in the final ledger`,
      );
    }
    const rawFindingIds = normalizedSettlementRawFindingIds(settlement, diagnostics);
    if (rawFindingIds.length === 0) {
      diagnostics.push(
        `settlement ${settlement.destination.kind}:${settlement.destination.id} has no rawFindingId`,
      );
    }
    normalizedSettlements.push({
      rawFindingIds,
      destination: settlement.destination,
    });
    for (const rawFindingId of rawFindingIds) {
      if (!expected.has(rawFindingId)) {
        diagnostics.push(`unknown rawFindingId "${rawFindingId}" in settlement`);
      }
      const prior = occurrences.get(rawFindingId) ?? [];
      prior.push(
        `settlement:${settlement.destination.kind}:${settlement.destination.id}`,
      );
      occurrences.set(rawFindingId, prior);
    }
  }

  const failuresByRawFindingId = new Map<string, FindingRawObservationFailure>();
  for (const failure of input.failures) {
    if (failure.phase.trim().length === 0 || failure.reason.trim().length === 0) {
      diagnostics.push(
        `explicit failure for rawFindingId "${failure.rawFindingId}" must include a phase and non-empty reason`,
      );
    }
    if (!expected.has(failure.rawFindingId)) {
      diagnostics.push(`unknown rawFindingId "${failure.rawFindingId}" in explicit failure`);
    }
    if (!failuresByRawFindingId.has(failure.rawFindingId)) {
      failuresByRawFindingId.set(failure.rawFindingId, failure);
    }
  }

  const normalizedFailures: FindingRawObservationFailure[] = [];
  for (const failure of failuresByRawFindingId.values()) {
    if (occurrences.has(failure.rawFindingId)) {
      continue;
    }
    occurrences.set(failure.rawFindingId, [`failure:${failure.phase}`]);
    normalizedFailures.push(failure);
  }

  for (const rawFindingId of expectedRawFindingIds) {
    const rawOccurrences = occurrences.get(rawFindingId) ?? [];
    if (rawOccurrences.length === 0) {
      diagnostics.push(`missing settlement for rawFindingId "${rawFindingId}"`);
    } else if (rawOccurrences.length > 1) {
      diagnostics.push(
        `rawFindingId "${rawFindingId}" is settled more than once (${rawOccurrences.join(', ')})`,
      );
    }
  }

  if (diagnostics.length > 0) {
    throw new FindingRawObservationExactCoverError(diagnostics);
  }

  return {
    expectedRawFindingIds,
    settlements: aggregateSettlements(normalizedSettlements),
    failures: [...normalizedFailures].sort((left, right) => (
      compareBinaryStrings(left.rawFindingId, right.rawFindingId)
      || compareBinaryStrings(left.phase, right.phase)
      || compareBinaryStrings(left.reason, right.reason)
    )),
  };
}

function destinationMap(
  ledger: FindingLedger,
): ReadonlyMap<FindingRawObservationSettlementDestinationKind, ReadonlySet<string>> {
  const destinations = new Map<
    FindingRawObservationSettlementDestinationKind,
    ReadonlySet<string>
  >();
  destinations.set('finding', new Set(ledger.findings.map(({ id }) => id)));
  destinations.set('conflict', new Set(ledger.conflicts.map(({ id }) => id)));
  destinations.set('rejected-observation', new Set(ledger.findings.map(({ id }) => id)));
  destinations.set(
    'reviewer-anomaly',
    new Set((ledger.reviewerAnomalies ?? []).map(({ id }) => id)),
  );
  return destinations;
}

function conflictMemberFindingRawIds(input: {
  ledger: FindingLedger;
  settlements: readonly FindingRawObservationSettlementInput[];
}): ReadonlySet<string> {
  const conflictIdsByRawFindingId = new Map<string, Set<string>>();
  const findingIdsByRawFindingId = new Map<string, Set<string>>();
  for (const settlement of input.settlements) {
    const rawFindingIds = [
      ...(settlement.rawFindingIds ?? []),
      ...(settlement.sourceRawFindingIds ?? []),
    ];
    if (settlement.destination.kind === 'conflict') {
      for (const rawFindingId of rawFindingIds) {
        const conflictIds = conflictIdsByRawFindingId.get(rawFindingId) ?? new Set<string>();
        conflictIds.add(settlement.destination.id);
        conflictIdsByRawFindingId.set(rawFindingId, conflictIds);
      }
    }
    if (settlement.destination.kind === 'finding') {
      for (const rawFindingId of rawFindingIds) {
        const findingIds = findingIdsByRawFindingId.get(rawFindingId) ?? new Set<string>();
        findingIds.add(settlement.destination.id);
        findingIdsByRawFindingId.set(rawFindingId, findingIds);
      }
    }
  }

  const normalizedRawFindingIds = new Set<string>();
  for (const [rawFindingId, findingIds] of findingIdsByRawFindingId) {
    const conflictIds = conflictIdsByRawFindingId.get(rawFindingId);
    if (conflictIds === undefined || conflictIds.size !== 1) {
      continue;
    }
    const conflict = input.ledger.conflicts.find(({ id }) => conflictIds.has(id));
    if (conflict !== undefined && [...findingIds].every((findingId) => (
      conflict.findingIds.includes(findingId)
    ))) {
      normalizedRawFindingIds.add(rawFindingId);
    }
  }
  return normalizedRawFindingIds;
}

function normalizeConflictMemberFindingSettlements(input: {
  ledger: FindingLedger;
  settlements: readonly FindingRawObservationSettlementInput[];
}): FindingRawObservationSettlementInput[] {
  const normalizedRawFindingIds = conflictMemberFindingRawIds(input);
  return input.settlements.flatMap((settlement) => {
    if (settlement.destination.kind !== 'finding') {
      return [settlement];
    }
    const rawFindingIds = (settlement.rawFindingIds ?? [])
      .filter((rawFindingId) => !normalizedRawFindingIds.has(rawFindingId));
    const sourceRawFindingIds = (settlement.sourceRawFindingIds ?? [])
      .filter((rawFindingId) => !normalizedRawFindingIds.has(rawFindingId));
    if (rawFindingIds.length === 0 && sourceRawFindingIds.length === 0) {
      return [];
    }
    return [{ ...settlement, rawFindingIds, sourceRawFindingIds }];
  });
}

export function buildFindingRawObservationSettlementSummary(input: {
  expectedRawFindingIds: readonly string[];
  ledger: FindingLedger;
  explicitFailures: readonly FindingRawObservationFailure[];
}): FindingRawObservationSettlementSummary {
  const ledger = input.ledger;
  const expectedRawFindingIds = new Set(input.expectedRawFindingIds);
  const settlements: FindingRawObservationSettlementInput[] = [];
  const conflictByRawFindingId = new Map<string, string>();
  const conflictById = new Map(ledger.conflicts.map((conflict) => [conflict.id, conflict]));
  for (const landing of ledger.conflictRawClaimLandings) {
    const prior = conflictByRawFindingId.get(landing.rawFindingId);
    if (prior !== undefined) {
      throw new FindingRawObservationExactCoverError([
        `rawFindingId "${landing.rawFindingId}" has multiple conflict landings (${prior}, ${landing.conflictId})`,
      ]);
    }
    const conflict = conflictById.get(landing.conflictId);
    if (conflict === undefined || !conflict.rawFindingIds.includes(landing.rawFindingId)) {
      throw new FindingRawObservationExactCoverError([
        `conflict landing for rawFindingId "${landing.rawFindingId}" does not match conflict "${landing.conflictId}" raw claims`,
      ]);
    }
    conflictByRawFindingId.set(landing.rawFindingId, landing.conflictId);
    if (expectedRawFindingIds.has(landing.rawFindingId)) {
      settlements.push({
        rawFindingIds: [landing.rawFindingId],
        destination: { kind: 'conflict', id: landing.conflictId },
      });
    }
  }
  for (const conflict of ledger.conflicts) {
    for (const rawFindingId of conflict.rawFindingIds) {
      if (conflictByRawFindingId.has(rawFindingId)
        || !expectedRawFindingIds.has(rawFindingId)) {
        continue;
      }
      settlements.push({
        rawFindingIds: [rawFindingId],
        destination: { kind: 'conflict', id: conflict.id },
      });
    }
  }
  const conflictHoldingProvisionalRawFindingIdsByFindingId = new Map<string, Set<string>>();
  for (const conflict of ledger.conflicts) {
    const conflictRawFindingIds = new Set(conflict.rawFindingIds);
    const conflictHoldingFindingIds = new Set(
      ledger.conflictRawClaimLandings
        .filter((landing) => landing.conflictId === conflict.id)
        .map((landing) => landing.holdingFindingId),
    );
    for (const finding of ledger.findings) {
      if (
        !finding.provisional
        || (
          !conflict.findingIds.includes(finding.id)
          && !conflictHoldingFindingIds.has(finding.id)
        )
      ) {
        continue;
      }
      const holdingRawFindingIds = (
        conflictHoldingProvisionalRawFindingIdsByFindingId.get(finding.id)
        ?? new Set<string>()
      );
      for (const rawFindingId of [
        ...finding.rawFindingIds,
        ...finding.provisional.sourceRawFindingIds,
      ]) {
        if (conflictRawFindingIds.has(rawFindingId)) {
          holdingRawFindingIds.add(rawFindingId);
        }
      }
      conflictHoldingProvisionalRawFindingIdsByFindingId.set(finding.id, holdingRawFindingIds);
    }
  }

  for (const finding of ledger.findings) {
    const holdingRawFindingIds = conflictHoldingProvisionalRawFindingIdsByFindingId.get(finding.id)
      ?? new Set<string>();
    const findingRawFindingIds = finding.rawFindingIds.filter(
      (rawFindingId) => expectedRawFindingIds.has(rawFindingId)
        && !holdingRawFindingIds.has(rawFindingId),
    );
    const provisionalRawFindingIds = (finding.provisional?.sourceRawFindingIds ?? []).filter(
      (rawFindingId) => expectedRawFindingIds.has(rawFindingId)
        && !holdingRawFindingIds.has(rawFindingId),
    );
    if (findingRawFindingIds.length > 0 || provisionalRawFindingIds.length > 0) {
      settlements.push({
        rawFindingIds: findingRawFindingIds,
        sourceRawFindingIds: provisionalRawFindingIds,
        destination: { kind: 'finding', id: finding.id },
      });
    }
    for (const observation of finding.rejectedObservations ?? []) {
      if (!expectedRawFindingIds.has(observation.rawFindingId)) {
        continue;
      }
      settlements.push({
        rawFindingIds: [observation.rawFindingId],
        destination: { kind: 'rejected-observation', id: finding.id },
      });
    }
  }

  const normalizedSettlements = normalizeConflictMemberFindingSettlements({
    ledger,
    settlements,
  });
  const rawDestinationById = new Map<string, { kind: FindingRawObservationSettlementDestinationKind; id: string }>();
  for (const settlement of normalizedSettlements) {
    for (const rawFindingId of sortedUnique([
      ...(settlement.rawFindingIds ?? []),
      ...(settlement.sourceRawFindingIds ?? []),
    ])) {
      rawDestinationById.set(rawFindingId, settlement.destination);
    }
  }
  for (const anomaly of ledger.reviewerAnomalies ?? []) {
    if (anomaly.promotedFindingId !== undefined) {
      for (const rawFindingId of anomaly.sourceRawFindingIds) {
        if (!expectedRawFindingIds.has(rawFindingId)) {
          continue;
        }
        const existing = rawDestinationById.get(rawFindingId);
        if (existing !== undefined) {
          if (existing.kind !== 'finding' || existing.id !== anomaly.promotedFindingId) {
            throw new FindingRawObservationExactCoverError([
              `promoted reviewer anomaly "${anomaly.id}" points rawFindingId "${rawFindingId}" to finding "${anomaly.promotedFindingId}", but the ledger settles it at ${existing.kind}:${existing.id}`,
            ]);
          }
          continue;
        }
        normalizedSettlements.push({
          rawFindingIds: [rawFindingId],
          destination: { kind: 'finding', id: anomaly.promotedFindingId },
        });
        rawDestinationById.set(rawFindingId, {
          kind: 'finding',
          id: anomaly.promotedFindingId,
        });
      }
      continue;
    }
    const sourceRawFindingIds = anomaly.sourceRawFindingIds.filter(
      (rawFindingId) => expectedRawFindingIds.has(rawFindingId),
    );
    if (sourceRawFindingIds.length > 0) {
      normalizedSettlements.push({
        sourceRawFindingIds,
        destination: { kind: 'reviewer-anomaly', id: anomaly.id },
      });
    }
  }

  return assertFindingRawObservationExactCover({
    expectedRawFindingIds: input.expectedRawFindingIds,
    settlements: normalizedSettlements,
    failures: input.explicitFailures,
    knownDestinationIds: destinationMap(input.ledger),
  });
}
