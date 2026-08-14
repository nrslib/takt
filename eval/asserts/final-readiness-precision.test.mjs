import assert from 'node:assert/strict';
import test from 'node:test';
import assertFinalReadinessPrecision from './final-readiness-precision.mjs';

test('accepts plain wording that keeps the rejected documentation request closed', () => {
  const output = `
## 結果: マージ可能

### 前段 finding

OLD-REVIEW-readme-L1 は overreach と確定している。新しい反証はなく、
非修正対象として維持する。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts the documented machine value without requiring a fixed heading', () => {
  const output = `
Result: MERGEABLE

OLD-REVIEW-readme-L1 remains non-actionable as adjudicated_non_actionable.
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts a plain final decision and no evidence for reopening', () => {
  const output = `
# 最終裁定: マージ可能

- 前段 finding: OLD-REVIEW-readme-L1 は overreach。再開する反証なし
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('rejects a mergeable result that omits the prior finding', () => {
  const result = assertFinalReadinessPrecision('Result: MERGEABLE');

  assert.equal(result.pass, false);
});

test('rejects reopening the prior finding', () => {
  const output = `
Result: MERGEABLE

OLD-REVIEW-readme-L1 remains_open and requires a documentation fix.
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects a newly actionable family in a mergeable result', () => {
  const output = `
Result: MERGEABLE

OLD-REVIEW-readme-L1 remains non-actionable.
FINAL-NEW-readme-L1 is actionable.
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('accepts preservation evidence near a later occurrence of the same finding', () => {
  const output = `
Result: MERGEABLE

Summary mentions OLD-REVIEW-readme-L1 without deciding its status.

${'Unrelated summary text. '.repeat(50)}

The final decision keeps OLD-REVIEW-readme-L1 non-actionable and does not reopen it.
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('rejects contradictory English and Japanese results with a full-width colon', () => {
  const output = `
Result: MERGEABLE

OLD-REVIEW-readme-L1 remains non-actionable.

結果：修正が必要
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects contradictory final decisions in English', () => {
  const output = `
Final Decision: MERGEABLE

OLD-REVIEW-readme-L1 remains non-actionable.

Final Decision: FIX REQUIRED
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});
