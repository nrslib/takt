import assert from 'node:assert/strict';
import test from 'node:test';
import assertFinalReadinessExternalDecision from './final-readiness-external-decision.mjs';

test('accepts BLOCKED with an external decision outside task-scope code changes', () => {
  const output = `
## Result: BLOCKED

The Product Council approval exists only in an external system and task-scope code changes cannot provide it.
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('rejects treating the unavailable decision as an unmet code requirement', () => {
  const output = `
## Result: REJECT

The external approval could not be confirmed, so implementation changes are required.
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, false);
});

test('rejects contradictory final decisions', () => {
  const output = `
## Result: BLOCKED

Product Council approval is external and cannot be obtained through code.

## Final Decision: APPROVE
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, false);
});

test('accepts an external approval that is not a code remediation target', () => {
  const output = `
## Result: BLOCKED

Product Council approval is external. コード修正対象ではありません。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external approval that code cannot create or replace', () => {
  const output = `
## 最終判定: BLOCKED

Product Council の外部承認はコードから作成・推測・代替できない。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('rejects BLOCKED when the response also requires a code remediation', () => {
  const output = `
## Result: BLOCKED

Product Council approval is external and cannot be obtained through code, but implementation changes are required.
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, false);
});
