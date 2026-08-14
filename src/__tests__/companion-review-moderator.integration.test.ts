import { describe, expect, it, vi } from 'vitest';
import {
  moderateCompanionResult,
  validateModeratorDecisions,
} from '../core/workflow/companion/moderator.js';

const reviewerResult = {
  findings: [
    { severity: 'must_fix' as const, file: 'src/a.ts', line: 1, finding: 'first' },
    { severity: 'nit' as const, file: 'src/b.ts', line: 2, finding: 'second' },
  ],
};

describe('companion moderator', () => {
  it('returns only accepted findings from the current round', async () => {
    const result = await moderateCompanionResult({
      reviewerResult,
      diffSummary: 'two files',
      runModerator: vi.fn().mockResolvedValue({
        findings: [
          { action: 'accept', sourceIndex: 0 },
          { action: 'reject', sourceIndex: 1 },
        ],
      }),
    });

    expect(result?.accepted.findings).toEqual([reviewerResult.findings[0]]);
  });

  it('does not invoke a moderator for an empty reviewer list', async () => {
    const runModerator = vi.fn();
    const result = await moderateCompanionResult({
      reviewerResult: { findings: [] },
      diffSummary: 'empty',
      runModerator,
    });

    expect(result).toBeUndefined();
    expect(runModerator).not.toHaveBeenCalled();
  });

  it.each([
    {
      decisions: [{ action: 'accept' as const, sourceIndex: 0 }],
      message: 'exactly once',
    },
    {
      decisions: [
        { action: 'accept' as const, sourceIndex: 0 },
        { action: 'reject' as const, sourceIndex: 0 },
      ],
      message: 'more than once',
    },
    {
      decisions: [
        { action: 'accept' as const, sourceIndex: 0 },
        { action: 'reject' as const, sourceIndex: 3 },
      ],
      message: 'unknown finding index',
    },
  ])('validates sourceIndex cardinality: $message', ({ decisions, message }) => {
    expect(() => validateModeratorDecisions({ findings: decisions }, reviewerResult))
      .toThrow(message);
  });
});
