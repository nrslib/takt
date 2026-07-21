import type { FindingLedgerEntry, FindingProvisionalMetadata } from './types.js';

export type RawAdjudicationCandidate = FindingLedgerEntry & {
  provisional: FindingProvisionalMetadata;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareObservedRounds(left: number | undefined, right: number | undefined): number {
  if (left === undefined || right === undefined) {
    if (left === right) {
      return 0;
    }
    return left === undefined ? -1 : 1;
  }
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
  const attemptComparison = (left.provisional.adjudicationAttempts ?? []).length
    - (right.provisional.adjudicationAttempts ?? []).length;
  if (attemptComparison !== 0) {
    return attemptComparison;
  }
  const observedAtComparison = compareStrings(
    left.provisional.firstObservedAt.timestamp,
    right.provisional.firstObservedAt.timestamp,
  );
  return observedAtComparison !== 0 ? observedAtComparison : compareStrings(left.id, right.id);
}
