import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasFinalDecision,
  hasFixVerificationDecision,
} from './final-readiness-decision.mjs';

test('accepts the existing Markdown heading format', () => {
  assert.equal(hasFinalDecision('## Final Decision: APPROVE', 'APPROVE'), true);
});

test('accepts a headingless English decision', () => {
  assert.equal(hasFinalDecision('Final Decision is BLOCKED', 'BLOCKED'), true);
});

test('accepts a headingless Japanese decision', () => {
  assert.equal(hasFinalDecision('最終判定は REJECT', 'REJECT'), true);
});

test('accepts a Markdown table decision', () => {
  assert.equal(hasFinalDecision('| Final Decision | **BLOCKED** |', 'BLOCKED'), true);
});

test('does not treat a prose mention as the final decision', () => {
  assert.equal(hasFinalDecision('The final decision is BLOCKED only if approval remains pending.', 'BLOCKED'), false);
});

test('does not treat when or unless clauses as the final decision', () => {
  assert.equal(hasFinalDecision('Final Decision: BLOCKED when approval remains pending.', 'BLOCKED'), false);
  assert.equal(hasFinalDecision('Final Decision: APPROVE unless a gate fails.', 'APPROVE'), false);
});

test('does not treat Japanese conditional clauses as the final decision', () => {
  assert.equal(hasFinalDecision('最終判定: 外部承認がない場合は進行不可', 'BLOCKED'), false);
  assert.equal(hasFinalDecision('最終判定: 問題がなければ APPROVE', 'APPROVE'), false);
});

test('does not accept a decision that remains conditional until a later event', () => {
  assert.equal(hasFinalDecision('最終判定: APPROVE（全ゲート成功を条件とする）', 'APPROVE'), false);
  assert.equal(hasFinalDecision('最終判定: 全ゲート成功後に APPROVE', 'APPROVE'), false);
});

test('does not accept a list of decision choices as a final decision', () => {
  assert.equal(hasFinalDecision('## Result: APPROVE / REJECT / BLOCKED', 'BLOCKED'), false);
  assert.equal(hasFinalDecision('## Result: APPROVE / REJECT / BLOCKED', 'APPROVE'), false);
});

test('does not accept a conditional value after a decision heading', () => {
  assert.equal(hasFinalDecision('# Final Decision\n\nBLOCKED only if approval remains pending.', 'BLOCKED'), false);
});

test('does not accept a bare decision without a decision label', () => {
  assert.equal(hasFinalDecision('BLOCKED', 'BLOCKED'), false);
});

test('accepts a Japanese decision with a parenthetical explanation', () => {
  assert.equal(hasFinalDecision('## 判定: REJECT（差し戻し）', 'REJECT'), true);
});

test('accepts a natural Japanese external-stop decision', () => {
  assert.equal(
    hasFinalDecision('最終判定: **進行不可（外部要因による停止）**', 'BLOCKED'),
    true,
  );
});

test('accepts a supervisor decision label', () => {
  assert.equal(hasFinalDecision('# 監督判定: REJECT', 'REJECT'), true);
});

test('accepts an overall decision label', () => {
  assert.equal(hasFinalDecision('総合判定: 外部要因による停止。', 'BLOCKED'), true);
});

test('treats an externally deferred rollout as blocked even when code requirements are satisfied', () => {
  assert.equal(
    hasFinalDecision('## 判定: 要件充足・finding 0 件 / ただし本番展開の可否は外部要因により保留', 'BLOCKED'),
    true,
  );
});

test('accepts a decision value on the line after a heading', () => {
  assert.equal(hasFinalDecision('# 最終判定\n\n**進行不可。外部要因による停止です。**', 'BLOCKED'), true);
});

test('unwraps a CLI provider response', () => {
  const output = JSON.stringify({ output: '## 判定: APPROVE（要件充足）' });
  assert.equal(hasFinalDecision(output, 'APPROVE'), true);
});

test('does not treat a criticized prior completion conclusion as the current decision', () => {
  const output = `
## 判定: REJECT

検出済みの違反を残したまま「修正完了」と結論づけた点が不整合です。
`;
  assert.equal(hasFixVerificationDecision(output, 'INCOMPLETE'), true);
  assert.equal(hasFixVerificationDecision(output, 'COMPLETE'), false);
});
