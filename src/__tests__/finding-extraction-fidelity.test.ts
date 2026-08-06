import { describe, expect, it } from 'vitest';
import { hasRawFindingExtractionFidelityFailure } from '../core/workflow/findings/extraction-fidelity.js';
import { projectReviewerRawStructuredOutputWithEnvelope } from '../core/workflow/findings/raw-canonicalization.js';

const CLAIM_EXCERPT = 'Issue: src/example.ts still bypasses the required boundary.';
const COMPLETE_CANDIDATE = {
  rawFindingId: null,
  familyTag: null,
  severity: null,
  title: null,
  description: 'src/example.ts still bypasses the required boundary.',
  suggestion: null,
  relation: null,
  targetFindingIds: [],
  target: null,
  evidenceRequests: [],
};

describe('hasRawFindingExtractionFidelityFailure', () => {
  it('should report a failure when an item has a non-empty rawExcerpt and a null candidate', () => {
    expect(hasRawFindingExtractionFidelityFailure({
      rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: null }],
    })).toBe(true);
  });

  it('should report a failure when an item has a non-empty rawExcerpt and no candidate key', () => {
    expect(hasRawFindingExtractionFidelityFailure({
      rawFindings: [{ rawExcerpt: CLAIM_EXCERPT }],
    })).toBe(true);
  });

  it('should report a failure when the candidate description is null', () => {
    expect(hasRawFindingExtractionFidelityFailure({
      rawFindings: [{
        rawExcerpt: CLAIM_EXCERPT,
        candidate: { ...COMPLETE_CANDIDATE, description: null },
      }],
    })).toBe(true);
  });

  it('should report a failure when only one item among several lost its claim', () => {
    expect(hasRawFindingExtractionFidelityFailure({
      rawFindings: [
        { rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE },
        { rawExcerpt: 'Another stated problem.', candidate: null },
      ],
    })).toBe(true);
  });

  it('should report no failure for a complete candidate, an empty list, or a non-publication value', () => {
    expect(hasRawFindingExtractionFidelityFailure({
      rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE }],
    })).toBe(false);
    expect(hasRawFindingExtractionFidelityFailure({ rawFindings: [] })).toBe(false);
    expect(hasRawFindingExtractionFidelityFailure({ rawFindings: 'invalid' })).toBe(false);
    expect(hasRawFindingExtractionFidelityFailure(undefined)).toBe(false);
    expect(hasRawFindingExtractionFidelityFailure(null)).toBe(false);
  });

  it('should report a failure for an incomplete candidate once the reviewer projection collapses it to null', () => {
    // 実運用で検出に使うのは projection 後の形。必須フィールドを欠く candidate は
    // projection で null へ畳まれるため、全欠けと同じ経路で検出される。
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [{
        rawExcerpt: CLAIM_EXCERPT,
        candidate: { description: 'partial only' },
      }],
    }).structuredOutput;

    expect(projected.rawFindings).toEqual([{ rawExcerpt: CLAIM_EXCERPT, candidate: null }]);
    expect(hasRawFindingExtractionFidelityFailure(projected)).toBe(true);
  });
});
