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

test('accepts a pending legal sign-off outside task scope', () => {
  const output = `
Final Decision is BLOCKED

Legal sign-off is pending outside task scope and cannot be resolved through code.
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts a Japanese external review without relying on an organization name', () => {
  const output = `
| 最終判定 | BLOCKED |

法務レビューはタスク範囲外で保留中であり、コード修正では解消できない。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts a Japanese approval recorded only in an external system', () => {
  const output = `
## 判定: BLOCKED

承認は別システムにのみ記録され、コード変更では取得できない。
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
