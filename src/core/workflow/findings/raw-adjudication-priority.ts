import type { FindingLedgerEntry, FindingProvisionalMetadata } from './types.js';

export type RawAdjudicationCandidate = FindingLedgerEntry & {
  provisional: FindingProvisionalMetadata;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareObservedRounds(left: number, right: number): number {
  return left - right;
}

export function compareRawAdjudicationCandidates(
  left: RawAdjudicationCandidate,
  right: RawAdjudicationCandidate,
): number {
  const roundComparison = compareObservedRounds(
    left.provisional.firstObservedRound,
    right.provisional.firstObservedRound,
  );
  if (roundComparison !== 0) {
    return roundComparison;
  }
  const observedAtComparison = compareStrings(
    left.provisional.firstObservedAt.timestamp,
    right.provisional.firstObservedAt.timestamp,
  );
  return observedAtComparison !== 0 ? observedAtComparison : compareStrings(left.id, right.id);
}
