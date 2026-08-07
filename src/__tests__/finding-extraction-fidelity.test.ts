import { describe, expect, it } from 'vitest';
import {
  describeRawFindingExtractionFidelityFailure,
  hasRawFindingExtractionFidelityFailure,
} from '../core/workflow/findings/extraction-fidelity.js';
import { projectReviewerRawStructuredOutputWithEnvelope } from '../core/workflow/findings/raw-canonicalization.js';
import { ReviewerRawFindingSchema } from '../core/models/finding-schemas.js';

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

describe('reassertsReviewerAnomalyId の null（生成 schema 準拠形）', () => {
  // 生成 schema は reassertsReviewerAnomalyId を required かつ nullable と宣言する。
  // schema を厳密に守る provider（claude-sdk）は echo 対象が無ければ必ず null を出す。
  // これを projection が「不正な shape」として candidate ごと畳んでいたため、
  // 健全な抽出が extraction-fidelity 失敗として全没収されていた。
  const SCHEMA_CONFORMANT_CANDIDATE = {
    ...COMPLETE_CANDIDATE,
    reassertsReviewerAnomalyId: null,
  };

  it('should keep the candidate when reassertsReviewerAnomalyId is null', () => {
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate: SCHEMA_CONFORMANT_CANDIDATE }],
    }).structuredOutput;

    expect(hasRawFindingExtractionFidelityFailure(projected)).toBe(false);
    const item = (projected.rawFindings as { candidate: Record<string, unknown> }[])[0]!;
    // null は「echo なし」＝キー欠落として畳む。post-hoc 検証は非空文字列の
    // optional しか許さないため、null を record へ残してはいけない。
    expect(Object.hasOwn(item.candidate, 'reassertsReviewerAnomalyId')).toBe(false);
    expect(() => ReviewerRawFindingSchema.parse(item)).not.toThrow();
  });

  it('should keep a non-empty reassertsReviewerAnomalyId echo', () => {
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [{
        rawExcerpt: CLAIM_EXCERPT,
        candidate: { ...COMPLETE_CANDIDATE, reassertsReviewerAnomalyId: 'anomaly-1' },
      }],
    }).structuredOutput;

    expect(hasRawFindingExtractionFidelityFailure(projected)).toBe(false);
    const item = (projected.rawFindings as { candidate: Record<string, unknown> }[])[0]!;
    expect(item.candidate.reassertsReviewerAnomalyId).toBe('anomaly-1');
  });

  it('should keep the candidate when reassertsReviewerAnomalyId is absent or undefined', () => {
    // required を緩く扱う provider はキーごと省略する。null 修正の前後で
    // この経路が変わっていないことを固定する。
    for (const candidate of [
      { ...COMPLETE_CANDIDATE },
      { ...COMPLETE_CANDIDATE, reassertsReviewerAnomalyId: undefined },
    ]) {
      const projected = projectReviewerRawStructuredOutputWithEnvelope({
        rawFindings: [{ rawExcerpt: CLAIM_EXCERPT, candidate }],
      }).structuredOutput;

      expect(hasRawFindingExtractionFidelityFailure(projected)).toBe(false);
      const item = (projected.rawFindings as { candidate: Record<string, unknown> }[])[0]!;
      expect(Object.hasOwn(item.candidate, 'reassertsReviewerAnomalyId')).toBe(false);
      expect(() => ReviewerRawFindingSchema.parse(item)).not.toThrow();
    }
  });

  it('should collapse the candidate when reassertsReviewerAnomalyId is a non-string value', () => {
    // null / undefined だけを「echo なし」として通し、それ以外の非文字列は
    // 従来どおり shape 不正として candidate を破棄する。
    for (const invalid of [1, 0, true, false, {}, [], { id: 'anomaly-1' }]) {
      const projected = projectReviewerRawStructuredOutputWithEnvelope({
        rawFindings: [{
          rawExcerpt: CLAIM_EXCERPT,
          candidate: { ...COMPLETE_CANDIDATE, reassertsReviewerAnomalyId: invalid },
        }],
      }).structuredOutput;

      expect(projected.rawFindings).toEqual([{ rawExcerpt: CLAIM_EXCERPT, candidate: null }]);
      expect(hasRawFindingExtractionFidelityFailure(projected)).toBe(true);
    }
  });

  it('should collapse the candidate when reassertsReviewerAnomalyId is an empty string', () => {
    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [{
        rawExcerpt: CLAIM_EXCERPT,
        candidate: { ...COMPLETE_CANDIDATE, reassertsReviewerAnomalyId: '' },
      }],
    }).structuredOutput;

    expect(projected.rawFindings).toEqual([{ rawExcerpt: CLAIM_EXCERPT, candidate: null }]);
  });
});

describe('describeRawFindingExtractionFidelityFailure', () => {
  it('should name the projected items that lost the claim and why', () => {
    const describedNullCandidate = describeRawFindingExtractionFidelityFailure({
      rawFindings: [
        { rawExcerpt: CLAIM_EXCERPT, candidate: COMPLETE_CANDIDATE },
        { rawExcerpt: 'Another stated problem.', candidate: null },
      ],
    });
    expect(describedNullCandidate).toBe(
      '1/2 projected items lost the claim (#1: candidate is null after projection)',
    );

    expect(describeRawFindingExtractionFidelityFailure({
      rawFindings: [{
        rawExcerpt: CLAIM_EXCERPT,
        candidate: { ...COMPLETE_CANDIDATE, description: null },
      }],
    })).toBe('1/1 projected items lost the claim (#0: candidate description is null)');
  });

  it('should describe a structured output that carries no rawFindings array', () => {
    expect(describeRawFindingExtractionFidelityFailure({ rawFindings: 'invalid' }))
      .toBe('projected structured output has no rawFindings array');
    expect(describeRawFindingExtractionFidelityFailure(undefined))
      .toBe('projected structured output is not an object');
  });
});
