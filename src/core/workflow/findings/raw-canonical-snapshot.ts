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
import type { FindingObservation } from './types.js';

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
