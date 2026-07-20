import { describe, expect, it } from 'vitest';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';

describe('finding manager output construction', () => {
  it('should return every decision collection as a fresh empty array', () => {
    const first = createEmptyManagerOutput();
    const second = createEmptyManagerOutput();

    expect(first).toEqual({
      matches: [],
      newFindings: [],
      resolvedFindings: [],
      reopenedFindings: [],
      conflicts: [],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      invalidatedFindings: [],
      duplicateFindings: [],
      dismissedFindings: [],
    });
    for (const key of Object.keys(first) as Array<keyof typeof first>) {
      expect(first[key]).not.toBe(second[key]);
    }
  });
});
