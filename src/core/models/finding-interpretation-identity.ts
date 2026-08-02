import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  findingContentAddress,
} from './finding-contract-identity.js';
import type { InterpretationAttemptFence } from './finding-types.js';

export function computeInterpretationAttemptId(
  caseSnapshotId: string,
  attemptOrdinal: number,
  retryOrdinal: number,
): string {
  return findingContentAddress('interpretation-attempt', {
    caseSnapshotId,
    attemptOrdinal,
    retryOrdinal,
  });
}

export function computeInterpretationCohortId(
  caseId: string,
  semanticProjectionDigest: string,
  rawFindingIds: readonly string[],
): string {
  return findingContentAddress('interpretation-cohort', {
    caseId,
    semanticProjectionDigest,
    rawFindingIds: binarySortedUnique(rawFindingIds),
  });
}

function canonicalFence(fence: InterpretationAttemptFence): InterpretationAttemptFence {
  return {
    attemptId: fence.attemptId,
    caseId: fence.caseId,
    semanticProjectionDigest: fence.semanticProjectionDigest,
    rawFindingIds: [...fence.rawFindingIds].sort(compareBinaryStrings),
  };
}

export function computeInterpretationBatchId(
  fences: readonly InterpretationAttemptFence[],
): string {
  return findingContentAddress(
    'interpretation-batch',
    {
      fences: [...fences]
        .map(canonicalFence)
        .sort((left, right) => compareBinaryStrings(left.attemptId, right.attemptId)),
    },
  );
}
