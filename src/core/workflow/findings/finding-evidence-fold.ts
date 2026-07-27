import type {
  FindingObservation,
  FindingRecord,
  RawFinding,
} from './types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

function compareRawFinding(left: RawFinding, right: RawFinding): number {
  return compareBinaryStrings(left.rawFindingId, right.rawFindingId);
}

function mergeIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort(compareBinaryStrings);
}

export function selectPrimaryRawFinding(
  rawFindings: readonly RawFinding[],
): RawFinding {
  const primary = [...rawFindings].sort(compareRawFinding)[0];
  if (primary === undefined) {
    throw new Error('At least one raw finding is required to select primary finding evidence');
  }
  return primary;
}

export function foldRawFindingEvidence(
  rawFindings: readonly RawFinding[],
): Pick<FindingRecord, 'location' | 'description' | 'suggestion' | 'reviewers'> {
  const ordered = [...rawFindings].sort(compareRawFinding);
  const primary = selectPrimaryRawFinding(ordered);
  return {
    ...(primary.location !== undefined ? { location: primary.location } : {}),
    description: primary.description,
    ...(primary.suggestion !== undefined ? { suggestion: primary.suggestion } : {}),
    reviewers: mergeIds([], ordered.map((raw) => raw.reviewer)),
  };
}

export function foldFindingObservation(input: {
  readonly finding: FindingRecord;
  readonly rawFindings: readonly RawFinding[];
  readonly observation: FindingObservation;
}): Pick<
  FindingRecord,
  'rawFindingIds' | 'location' | 'description' | 'suggestion' | 'reviewers' | 'lastSeen'
> {
  const evidence = foldRawFindingEvidence(input.rawFindings);
  return {
    rawFindingIds: mergeIds(
      input.finding.rawFindingIds,
      input.rawFindings.map((raw) => raw.rawFindingId),
    ),
    location: evidence.location ?? input.finding.location,
    description: evidence.description,
    suggestion: evidence.suggestion ?? input.finding.suggestion,
    reviewers: mergeIds(input.finding.reviewers, evidence.reviewers),
    lastSeen: input.observation,
  };
}
