import assert from 'node:assert/strict';
import test from 'node:test';
import assertFinalReadinessPrecision from './final-readiness-precision.mjs';

function approvedOutput(extra = '') {
  return `
## Result: APPROVE

## Decision for Each Finding
| Finding ID / source | Treatment | Evidence |
|---------------------|-----------|----------|
| OLD-REVIEW-readme-L1 | Unnecessary expansion | No current evidence requires this documentation expansion |

${extra}
`;
}

test('accepts APPROVE while preserving the excluded finding', () => {
  assert.equal(assertFinalReadinessPrecision(approvedOutput()).pass, true);
});

test('accepts the equivalent Japanese treatment', () => {
  const output = `
## 結果: APPROVE

OLD-REVIEW-readme-L1 は必要以上の拡張であり、修正対象にしない。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts the observed final-decision heading without selecting the finding for repair', () => {
  const output = `
# 最終判定: APPROVE

### 前段 finding

OLD-REVIEW-readme-L1 は必要以上の拡張であり、今回の修正対象ではありません。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts a Japanese statement preserving the prior decision', () => {
  const output = `
# 最終判定: APPROVE

## 前段 finding

OLD-REVIEW-readme-L1 は、全表記を README に列挙する要求が元要件にないため、前段の判断どおり必要以上の拡張です。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts compact exclusion wording from the supervisor', () => {
  const output = `
# 最終判定: APPROVE

OLD-REVIEW-readme-L1 は前段の判断どおり今回の修正対象ではありません。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, true);
});

test('accepts an explicit statement that no repair target exists', () => {
  const output = `
# 最終判定: APPROVE

OLD-REVIEW-readme-L1 は今回の範囲外であり、修正対象はありません。
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

test('rejects explicitly selecting the prior finding for repair', () => {
  const output = approvedOutput('OLD-REVIEW-readme-L1 is selected for repair.');
  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects negating the exclusion decision', () => {
  const output = `
# 最終判定: APPROVE

OLD-REVIEW-readme-L1 は必要以上の拡張ではなく、今回は修正対象にする。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects selecting a finding for repair after preserving its prior treatment', () => {
  const output = `
# 最終判定: APPROVE

OLD-REVIEW-readme-L1 は前段の判断どおり必要以上の拡張です。しかし今回は修正対象にする。
`;

  assert.equal(assertFinalReadinessPrecision(output).pass, false);
});

test('rejects a newly unresolved problem in an approved result', () => {
  const output = approvedOutput('FINAL-NEW-readme-L1 requires a fix.');
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
