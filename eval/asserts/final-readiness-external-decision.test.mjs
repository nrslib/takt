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

test('accepts a natural Japanese stop decision in a CLI provider wrapper', () => {
  const output = JSON.stringify({
    output: '最終判定: **進行不可（外部要因による停止）**\n\n外部システムの承認はコードで作成・推測・代替できない。',
  });
  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external hold described without the BLOCKED token', () => {
  const output = `
## 判定: 要件充足・finding 0 件 / ただし本番展開の可否は外部要因により保留

承認は外部システムにのみ記録され、追加のコード修正なしに進行できます。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external decision that must not be copied into the repository', () => {
  const output = `
最終判定：本番展開は進行不可（外部要因による停止）です。

外部承認は、リポジトリに写しを追加したり承認済みと推測したりはできません。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts a direct contrast between an external input and code remediation', () => {
  const output = `
# 最終判定: 外部要因による停止

必要なのはコード修正ではなく、別システムにある承認判断の確認です。
`;

  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts the observed statement that there is no code repair target', () => {
  const output = `
# 最終判定: 進行不可

製品評議会の承認判断は外部システムにのみ記録されており、確認できるまで保留です。
コード上の修正対象はありません。
`;
  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external decision that code changes cannot obtain', () => {
  const output = `
# 最終判定: 外部要因による停止

外部システムの承認情報をコード変更で得ることはできない。
`;
  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external decision kept out of code findings', () => {
  const output = `
# 最終判定: 進行不可（外部要因による停止）

外部システムの承認はコード上の finding にはせず、確認できるまで保留する。
`;
  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});

test('accepts an external decision that is not a repository repair target', () => {
  const output = `
# 最終判定: 外部要因による停止

外部承認はリポジトリへの修正対象ではありません。
`;
  assert.equal(assertFinalReadinessExternalDecision(output).pass, true);
});
