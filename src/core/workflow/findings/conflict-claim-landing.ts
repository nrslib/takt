import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeConflictHoldingAllocationId,
  computeConflictHoldingStableKey,
  computeConflictRawClaimLandingId,
  computeConflictRawClaimSnapshotDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type { ConflictRawClaimLanding } from '../../models/finding-contract-types.js';
import { evidenceRecordMatchesRawEvidence } from '../../models/finding-evidence-record.js';
import { createFindingLedgerEntry } from './finding-entry.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import {
  assertCompatibleRawCanonicalSnapshot,
  createRawCanonicalSnapshot,
} from './raw-canonical-snapshot.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingObservation,
  RawFinding,
} from './types.js';

function findingId(nextId: number): string {
  return `F-${String(nextId).padStart(4, '0')}`;
}

export function stageCanonicalRawSnapshots(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  observation: FindingObservation;
}): FindingLedger {
  const rawIds = new Set(input.ledger.rawFindings.map((raw) => raw.rawFindingId));
  const snapshots = [...input.ledger.rawCanonicalSnapshots];
  for (const item of input.items) {
    if (!rawIds.has(item.wire.rawFindingId)) {
      continue;
    }
    const candidate = createRawCanonicalSnapshot({ item, capturedAt: input.observation });
    const existing = snapshots.find((snapshot) => snapshot.rawFindingId === item.wire.rawFindingId);
    if (existing === undefined) {
      snapshots.push(candidate);
    } else {
      assertCompatibleRawCanonicalSnapshot(existing, candidate);
    }
  }
  return { ...input.ledger, rawCanonicalSnapshots: snapshots };
}

function rawEvidenceIds(ledger: FindingLedger, raw: RawFinding): string[] {
  return ledger.evidenceRecords.flatMap((record) => (
    record.claimIdentityHash === raw.claimIdentityHash
    && raw.evidence.some((evidence) => evidenceRecordMatchesRawEvidence(record, evidence))
      ? [record.evidenceId]
      : []
  )).sort(compareBinaryStrings);
}

function holdingProjection(input: {
  ledger: FindingLedger;
  raw: RawFinding;
  conflictId: string;
  rawClaimLandingId: string;
  observation: FindingObservation;
}): FindingLedgerEntry {
  const allocationId = computeConflictHoldingAllocationId(
    input.conflictId,
    [input.rawClaimLandingId],
  );
  return createFindingLedgerEntry({
    id: findingId(input.ledger.nextId),
    status: 'open',
    lifecycle: 'new',
    target: structuredClone(input.raw.target),
    targetIdentityHash: input.raw.targetIdentityHash,
    claimIdentityHash: input.raw.claimIdentityHash,
    semanticClaimIdentityHash: input.raw.semanticClaimIdentityHash,
    severity: input.raw.severity,
    title: input.raw.title,
    ...(input.raw.description == null ? {} : { description: input.raw.description }),
    ...(input.raw.suggestion == null ? {} : { suggestion: input.raw.suggestion }),
    evidenceIds: rawEvidenceIds(input.ledger, input.raw),
    reviewers: [input.raw.reviewer],
    rawFindingIds: [input.raw.rawFindingId],
    firstSeen: structuredClone(input.observation),
    lastSeen: structuredClone(input.observation),
    revision: 1,
    provisional: {
      kind: 'raw-adjudication-unresolved',
      stableKey: computeConflictHoldingStableKey({
        conflictId: input.conflictId,
        holdingAllocationId: allocationId,
        provisionalKind: 'raw-adjudication-unresolved',
      }),
      lineageKey: findingContentAddress('conflict-holding-lineage', {
        conflictId: input.conflictId,
        rawFindingId: input.raw.rawFindingId,
      }),
      sourceRawFindingIds: [input.raw.rawFindingId],
      reason: `Raw claim is held by active conflict ${input.conflictId}`,
      firstObservedAt: structuredClone(input.observation),
      lastObservedAt: structuredClone(input.observation),
      gateEffect: 'block',
      recoveryReviewerStableKey: input.raw.reviewer,
      firstObservedRound: stopBudgetRoundsCompleted(input.ledger) + 1,
    },
  });
}

function createLanding(input: {
  ledger: FindingLedger;
  conflictId: string;
  raw: RawFinding;
  observation: FindingObservation;
}): { ledger: FindingLedger; landing: ConflictRawClaimLanding } {
  const canonicalSnapshots = input.ledger.rawCanonicalSnapshots.filter(
    (snapshot) => snapshot.rawFindingId === input.raw.rawFindingId,
  );
  if (canonicalSnapshots.length !== 1) {
    throw new Error(`Conflict raw claim "${input.raw.rawFindingId}" has no exact canonical snapshot`);
  }
  const canonicalSnapshot = canonicalSnapshots[0]!;
  const identity = {
    conflictId: input.conflictId,
    rawFindingId: input.raw.rawFindingId,
    rawCanonicalSnapshotId: canonicalSnapshot.rawCanonicalSnapshotId,
    rawPayloadDigest: canonicalSnapshot.rawPayloadDigest,
    claimSnapshotDigest: computeConflictRawClaimSnapshotDigest(canonicalSnapshot),
  };
  const rawClaimLandingId = computeConflictRawClaimLandingId(identity);
  const holding = holdingProjection({
    ledger: input.ledger,
    raw: input.raw,
    conflictId: input.conflictId,
    rawClaimLandingId,
    observation: input.observation,
  });
  const { revision: _revision, ...holdingWithoutRevision } = holding;
  void _revision;
  const applied = applyFindingLifecycleCommands({
    ledger: input.ledger,
    commands: [{
      operation: 'create_finding',
      changes: { findings: [holdingWithoutRevision], conflicts: [] },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `finding\0${holding.id}`,
        { sourceRawFindingIds: [input.raw.rawFindingId], authorityEvidenceIds: [] },
      ]]),
    }],
    occurredAt: input.observation,
  });
  const holdingHead = applied.lifecycleEvents.at(-1)?.transitions.find((transition) => (
    transition.after.entityKind === 'finding' && transition.after.entityId === holding.id
  ))?.after;
  if (holdingHead === undefined) {
    throw new Error(`Conflict holding "${holding.id}" has no landing lifecycle event`);
  }
  const allocationId = computeConflictHoldingAllocationId(input.conflictId, [rawClaimLandingId]);
  return {
    ledger: applied,
    landing: {
      rawClaimLandingId,
      ...identity,
      holdingAllocationId: allocationId,
      holdingFindingId: holding.id,
      holdingHeadAfterLanding: holdingHead,
      landingEventId: holdingHead.eventId,
      landedAt: structuredClone(input.observation),
    },
  };
}

export function landUnownedConflictRawClaims(input: {
  ledger: FindingLedger;
  observation: FindingObservation;
}): FindingLedger {
  let ledger = input.ledger;
  const ownersByRawId = new Map(
    ledger.conflictRawClaimLandings.map((landing) => [landing.rawFindingId, landing]),
  );
  for (const conflict of ledger.conflicts) {
    for (const rawFindingId of conflict.rawFindingIds) {
      const owner = ownersByRawId.get(rawFindingId);
      if (owner !== undefined) {
        if (owner.conflictId !== conflict.id) {
          throw new Error(`Raw finding "${rawFindingId}" is owned by another conflict`);
        }
        continue;
      }
      const raw = ledger.rawFindings.find((candidate) => candidate.rawFindingId === rawFindingId);
      if (raw === undefined) {
        throw new Error(`Conflict "${conflict.id}" references unknown raw finding "${rawFindingId}"`);
      }
      const landed = createLanding({
        ledger,
        conflictId: conflict.id,
        raw,
        observation: input.observation,
      });
      ledger = {
        ...landed.ledger,
        conflictRawClaimLandings: [...landed.ledger.conflictRawClaimLandings, landed.landing]
          .sort((left, right) => compareBinaryStrings(left.rawClaimLandingId, right.rawClaimLandingId)),
      };
      ownersByRawId.set(rawFindingId, landed.landing);
    }
  }
  return ledger;
}
