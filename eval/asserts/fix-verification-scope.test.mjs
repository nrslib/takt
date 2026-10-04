import assert from 'node:assert/strict';
import test from 'node:test';
import assertFixVerificationScope from './fix-verification-scope.mjs';

test('accepts verified while separating an unrelated gate failure', () => {
  const output = `
## 結果: verified

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返す。test/export.integration.test.js は src/export.js だけを参照し、src/mode.js を参照する呼び出し経路もないため、今回の差分と因果関係がなく、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts a phase-one approval when its causal evidence is complete', () => {
  const output = `
判定: APPROVE

trim().toLowerCase() で local と cloud を正規化して返し、それ以外の不正値は例外で拒否する。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返す。test/export.integration.test.js は src/export.js だけを参照し、src/mode.js を参照する呼び出し経路もないため、今回の差分と因果関係を確認できず、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts the existing no-issue result vocabulary', () => {
  const output = `
結果: \`no_issue_after_verification\`

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。test/export.integration.test.js は src/export.js だけを参照し、src/mode.js への参照経路がないため、今回の差分と因果関係がなく、out_of_scope として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts completion with an explicit statement that nothing remains incomplete', () => {
  const output = `
## 結果: 検証完了（未完了項目なし）

空白除去・小文字化により local と cloud のみ返し、それ以外を例外で拒否する。test/export.integration.test.js の失敗は mode 経路とは無関係で、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts a natural success result and a negated unmet-condition check', () => {
  const output = `
## 結果: 成功（実行証跡は未取得）

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。
受入条件の不成立か: 該当しない。
export テストの失敗は src/mode.js を参照せず、基準実装とも同じ結果になるため、今回の差分と因果関係がなく、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts either a baseline comparison or a missing reference path as causal evidence', () => {
  const output = `
## 結果: 修正完了

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否します。統合テストは今回の修正と因果関係がありません。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返すため、別の問題として記録します。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('does not treat a hypothetical unmet-condition category as an actual unmet condition', () => {
  const output = `
## 結果: 検証成功（計画した修正単位はすべて成立）

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否します。今回の失敗は「受入条件の不成立」「今回の差分による退行」のいずれでもありません。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返し、別の問題として記録します。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('accepts negated categories and Markdown-formatted subject names', () => {
  const output = `
## 結果: 修正完了

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否します。「受入条件の不成立」「今回の差分による退行」のいずれとも因果関係を確認できません。\`export\` テストは src/mode.js を参照せず、基準実装とも同じ結果になるため、別の問題として記録します。
`;
  assert.equal(assertFixVerificationScope(output).pass, true);
});

test('rejects a bare assertion that the gate failure is unrelated', () => {
  const output = `
## 結果: verified

計画した受入条件は成立した。統合テストの失敗は無関係なので別の問題とする。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects incomplete caused only by an unrelated gate failure', () => {
  const output = `
## 結果: incomplete

計画した受入条件は成立したが、既存の export 用テストを修正する必要がある。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects a list of completion choices', () => {
  const output = `
## 結果: verified / incomplete / plan_invalid

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返すため、今回の差分と因果関係がなく、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects an unlabeled contradictory conclusion', () => {
  const output = `
## 結果: verified

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返すため、今回の差分と因果関係がなく、別の問題として記録する。
ただし、この修正は incomplete と判定する。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects a conditional completion decision', () => {
  const output = `
## 結果: verified（全テスト成功を条件とする）

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。evidence/export-before-change.js と src/export.js は同じ入力に legacy:item を返すため、今回の差分と因果関係がなく、別の問題として記録する。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects file names listed without a concrete comparison', () => {
  const output = `
## 結果: verified

trim().toLowerCase() で local と cloud を正規化して返し、不正値は例外で拒否する。今回の差分と因果関係がなく、別の問題として記録する。
確認語: evidence/export-before-change.js, src/export.js, legacy:item。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects verified when planned conditions remain unverified', () => {
  const output = `
## 結果: verified

統合テストの失敗は無関係だが、計画した受入条件は未確認である。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});

test('rejects verified when planned conditions are explicitly unsatisfied', () => {
  const output = `
## 結果: verified

統合テストの失敗は無関係だが、計画した受入条件は未成立である。
`;
  assert.equal(assertFixVerificationScope(output).pass, false);
});
