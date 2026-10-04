import assert from 'node:assert/strict';
import test from 'node:test';

import assertFixVerificationRegression from './fix-verification-regression.mjs';

test('accepts an incomplete decision for a regression caused by the current diff', () => {
  const output = `
## 結果: incomplete

今回の差分が export の既存契約を壊し、広いテストを失敗させたため実装不足です。修正が必要です。
src/export.js の JSON 出力形式が { summary } から { value } へ変わっています。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, true);
});

test('accepts a phase-one rejection for a regression caused by the current diff', () => {
  const output = `
## 結果: REJECT（修正未完了）

今回の差分が export の既存契約を壊し、広いテストを失敗させたため、元に戻す修正が必要です。
exportSummary の戻り値が { summary } ではなく { value } になっています。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, true);
});

test('accepts repair-incomplete wording with an existing-contract comparison', () => {
  const output = `
# 結果: 修正未完了（REJECT）

変更前証跡と現在コードを比較すると、変更対象外の既存契約が壊れているため、元に戻す必要があります。
src/export.js の JSON 出力形式は { summary } から { value } へ変わっています。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, true);
});

test('accepts an incomplete decision for a violated preserved condition', () => {
  const output = `
## Result: incomplete

The changed normalizeMode code violated the existing contract for a call without an argument: it must default to local. This implementation gap requires repair.
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'preserved_default' } }).pass, true);
});

test('accepts compact Japanese wording for a violated existing condition', () => {
  const output = `
## 結果: incomplete

src/mode.js の normalizeMode は引数省略時に local を返す既存条件が壊れているため、完了とは判定できません。復元が必要です。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'preserved_default' } }).pass, true);
});

test('accepts a multiline decision and a lost preservation condition', () => {
  const output = `
## 判定

REJECT（修正未完了）

今回の修正で normalizeMode の既定引数が失われ、引数なしでは local を返さず既存利用側が失敗します。復元が必要です。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'preserved_default' } }).pass, true);
});

test('rejects verified when a causally connected regression remains', () => {
  const output = `
## 結果: verified

今回の差分が既存条件を壊したが、広いテストなので別問題とする。
src/export.js の JSON 出力形式も { summary } から { value } へ変わっている。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, false);
});

test('rejects a generic restatement without fixture evidence', () => {
  const output = `
## 結果: 修正未完了

今回の差分が維持すべき既存条件を壊したため、実装不足として修正が必要です。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, false);
});

test('rejects a list of completion choices', () => {
  const output = `
## 結果: incomplete / verified / plan_invalid

今回の差分が export の既存契約を壊したため実装不足です。修正が必要です。
src/export.js の JSON 出力形式が { summary } から { value } へ変わっています。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, false);
});

test('rejects an unlabeled contradictory conclusion', () => {
  const output = `
## 結果: incomplete

今回の差分が export の既存契約を壊したため実装不足です。修正が必要です。
src/export.js の JSON 出力形式が { summary } から { value } へ変わっています。
ただし、最終的には verified と判定する。
`;
  assert.equal(assertFixVerificationRegression(output, { vars: { regression_case: 'current_diff_export' } }).pass, false);
});
