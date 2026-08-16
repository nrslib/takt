import assert from 'node:assert/strict';
import test from 'node:test';
import assertFinalReadinessPrecision from './final-readiness-precision.mjs';

function approvedOutput(extra = '') {
  return `
## Result: APPROVE

## Finding Dispositions
| Finding ID / source | Disposition | Evidence |
|---------------------|-------------|----------|
| OLD-REVIEW-readme-L1 | overreach | No current counter-evidence; do not reopen |

${extra}
`;
}

test('accepts APPROVE while preserving the excluded finding', () => {
  assert.equal(assertFinalReadinessPrecision(approvedOutput()).pass, true);
});

test('accepts the equivalent Japanese disposition', () => {
  const output = `
## 結果: APPROVE

OLD-REVIEW-readme-L1 は overreach のため再開しない。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts the observed final-decision heading without reopening a negated actionable finding', () => {
  const output = `
# 最終判定: APPROVE

### 前段 finding

OLD-REVIEW-readme-L1 は overreach のため解消要求なしです。未解消の actionable finding はありません。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts the observed Japanese non-actionable preservation statement', () => {
  const output = `
# 最終判定: APPROVE

## 前段 finding

OLD-REVIEW-readme-L1 は、全表記を README に列挙する要求が元要件にないため、前段裁定どおり非 actionable です。未解消の actionable finding はありません。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('rejects APPROVE when the prior finding is omitted', () => {
  assert.equal(assertFinalReadinessPrecision('## Result: APPROVE').pass, false);
});

test('rejects reopening the prior finding', () => {
  const output = approvedOutput('OLD-REVIEW-readme-L1 remains open and requires a fix.');
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects explicitly making the prior finding actionable', () => {
  const output = approvedOutput('OLD-REVIEW-readme-L1 is actionable.');
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects reopening a finding after mentioning its prior non-actionable disposition', () => {
  const output = `
# 最終判定: APPROVE

OLD-REVIEW-readme-L1 は前段裁定どおり非 actionable です。しかし今回は actionable として再開する。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects a newly actionable family in an approved result', () => {
  const output = approvedOutput('FINAL-NEW-readme-L1 is actionable.');
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects contradictory APPROVE and REJECT results', () => {
  const output = `${approvedOutput()}\n## 結果: REJECT`;
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects the removed MERGEABLE result vocabulary', () => {
  const output = approvedOutput().replace('Result: APPROVE', 'Result: MERGEABLE');
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});
