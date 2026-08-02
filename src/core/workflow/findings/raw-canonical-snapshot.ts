import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  binarySortedUnique,
  computeRawCanonicalSnapshotId,
  computeRawPayloadDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type { RawCanonicalSnapshot } from '../../models/finding-contract-types.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type { FindingLedger, FindingObservation } from './types.js';

function sortedSet(values: readonly string[]): string[] {
  return binarySortedUnique([...new Set(values)]);
}

export function createRawCanonicalSnapshot(input: {
  item: CanonicalIntakeItem;
  capturedAt: FindingObservation;
}): RawCanonicalSnapshot {
  const canonical = input.item.canonical;
  const captureDependencyDigests = sortedSet(canonical.issuedEngineProofRecords.flatMap(
    (record) => [record.snapshotId, record.resultDigest, ...record.dependencyDigests],
  ));
  const snapshotWithoutId = {
    rawFindingId: canonical.rawFindingId,
    rawPayloadDigest: computeRawPayloadDigest(input.item.wire),
    reviewerStableKey: canonical.reviewerStableKey,
    lineageKey: canonical.lineageKey,
    targetIdentityHash: canonical.targetIdentityHash,
    claimIdentityHash: canonical.claimIdentityHash,
    semanticClaimIdentityHash: canonical.semanticClaimIdentityHash,
    canonicalProvenance: structuredClone(canonical.provenance),
    canonicalizationContextDigest: findingContentAddress('raw-canonicalization-context', {
      reviewer: canonical.reviewer,
      stepName: canonical.stepName,
      sourceBinding: canonical.sourceBinding,
      provenance: canonical.provenance,
    }),
    captureAdmissionSnapshotId: findingContentAddress('raw-capture-admission-snapshot', {
      sourceBinding: canonical.sourceBinding,
      evidenceSetHash: canonical.evidenceSetHash,
      evidenceCoverageGaps: [...canonical.evidenceCoverageGaps],
    }),
    captureDependencyDigests,
    canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
  };
  return {
    rawCanonicalSnapshotId: computeRawCanonicalSnapshotId(snapshotWithoutId),
    ...snapshotWithoutId,
    capturedAt: structuredClone(input.capturedAt),
  };
}

export function assertCompatibleRawCanonicalSnapshot(
  existing: RawCanonicalSnapshot,
  candidate: RawCanonicalSnapshot,
): void {
  const existingContent = { ...existing, capturedAt: candidate.capturedAt };
  if (canonicalJson(existingContent) !== canonicalJson(candidate)) {
    throw new Error(
      `Raw canonical snapshot for "${candidate.rawFindingId}" conflicts with persisted content`,
    );
  }
}

export function appendRawFindingsWithCanonicalSnapshots(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  capturedAt: FindingObservation;
}): FindingLedger {
  const rawFindings = [...input.ledger.rawFindings];
  const rawCanonicalSnapshots = [...input.ledger.rawCanonicalSnapshots];
  for (const item of input.items) {
    const rawFindingId = item.wire.rawFindingId;
    if (item.canonical.rawFindingId !== rawFindingId) {
      throw new Error(
        `Canonical and wire raw finding identity mismatch: "${item.canonical.rawFindingId}" !== "${rawFindingId}"`,
      );
    }
    const existingRaws = rawFindings.filter((raw) => raw.rawFindingId === rawFindingId);
    const existingSnapshots = rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === rawFindingId,
    );
    if (existingRaws.length > 1 || existingSnapshots.length > 1) {
      throw new Error(`Raw finding "${rawFindingId}" does not have exact persisted identity`);
    }
    if (existingRaws.length === 0 && existingSnapshots.length === 1) {
      throw new Error(`Canonical snapshot for "${rawFindingId}" references a missing raw finding`);
    }

    const candidate = createRawCanonicalSnapshot({ item, capturedAt: input.capturedAt });
    const existingRaw = existingRaws[0];
    if (
      existingRaw !== undefined
      && computeRawPayloadDigest(existingRaw) !== candidate.rawPayloadDigest
    ) {
      throw new Error(`Raw finding "${rawFindingId}" conflicts with persisted content`);
    }
    if (existingRaw === undefined) {
      rawFindings.push(structuredClone(item.wire));
    }

    const existingSnapshot = existingSnapshots[0];
    if (existingSnapshot === undefined) {
      rawCanonicalSnapshots.push(candidate);
    } else {
      assertCompatibleRawCanonicalSnapshot(existingSnapshot, candidate);
    }
  }
  return {
    ...input.ledger,
    rawFindings,
    rawCanonicalSnapshots,
  };
}
