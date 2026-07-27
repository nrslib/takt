import { describe, expect, it } from 'vitest';
import { foldRawFindingEvidence } from '../core/workflow/findings/finding-evidence-fold.js';
import type { RawFinding } from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';

function rawFinding(rawFindingId: string): RawFinding {
  return {
    rawFindingId,
    stepName: 'reviewers',
    reviewer: rawFindingId,
    familyTag: 'correctness',
    severity: 'medium',
    title: rawFindingId,
    description: `evidence:${rawFindingId}`,
    relation: 'new',
  };
}

describe('binary string decision order', () => {
  it.each([
    ['NFC and decomposed accents', 'raw-é', 'raw-e\u0301'],
    ['letter case', 'raw-A', 'raw-a'],
    ['supplementary code points', 'raw-\u{1F600}', 'raw-\u{1F601}'],
  ])('never treats distinct %s as equal and is independent of input order', (
    _case,
    left,
    right,
  ) => {
    expect(left).not.toBe(right);
    expect(compareBinaryStrings(left, right)).not.toBe(0);
    expect(compareBinaryStrings(right, left))
      .toBe(-compareBinaryStrings(left, right));

    const forward = [left, right].sort(compareBinaryStrings);
    const reversed = [right, left].sort(compareBinaryStrings);
    expect(forward).toEqual(reversed);

    const forwardEvidence = foldRawFindingEvidence([
      rawFinding(left),
      rawFinding(right),
    ]);
    const reversedEvidence = foldRawFindingEvidence([
      rawFinding(right),
      rawFinding(left),
    ]);
    expect(forwardEvidence).toEqual(reversedEvidence);
    expect(forwardEvidence.description).toBe(`evidence:${forward[0]}`);
  });
});
