import assert from 'node:assert/strict';
import test from 'node:test';

import assertFinalReadinessSupervision from './final-readiness-supervision.mjs';

function actionableFamily() {
  return [
    '## Actionable Families',
    '| family | Finding ID / source | Evidence | Problem -> root cause |',
    '|--------|---------------------|----------|-----------------------|',
    '| configuration-normalization | MERGE-NEW-mode-L1 | `src/mode.js` project configuration entry | Project configuration consumer skips normalization |',
  ].join('\n');
}

function findingDispositions() {
  return [
    '## Finding Dispositions',
    '| Finding ID / source | Disposition | Authorization Basis | Reason absent from initial round | Evidence |',
    '|---------------------|-------------|---------------------|----------------------------------|----------|',
    '| MERGE-NEW-mode-L1 | actionable | required_consumer_migration | Initial review evidence covered only the CLI entry | Project configuration normalization is missing |',
    '| OLD-REVIEW-readme-L1 | out_of_scope | none | not applicable | No current counter-evidence |',
  ].join('\n');
}

function outputWith(...sections) {
  return ['## Result: REJECT', actionableFamily(), findingDispositions(), ...sections].join('\n\n');
}

test('accepts REJECT with an authorized actionable family and preserved disposition', () => {
  assert.equal(assertFinalReadinessSupervision(outputWith()).pass, true);
});

test('rejects the removed FIX REQUIRED result vocabulary', () => {
  const output = outputWith().replace('## Result: REJECT', '## Result: FIX REQUIRED');
  assert.equal(assertFinalReadinessSupervision(output).pass, false);
});

test('accepts the same report from a provider output envelope', () => {
  assert.equal(assertFinalReadinessSupervision(JSON.stringify({ output: outputWith() })).pass, true);
});

test('accepts the equivalent Japanese contract structure', () => {
  const output = [
    '## 結果: REJECT',
    '## 修正対象 family',
    '| family | finding ID / 出典 | 根拠 | 問題 → 根本原因 |',
    '|--------|-------------------|------|-------------------|',
    '| project-setting | VAL-NEW-mode-L1 | `src/mode.js` project設定 | project設定の正規化が不足 |',
    '## 指摘ごとの裁定',
    '| finding ID / 出典 | 裁定 | Authorization basis | 初回に含まれなかった理由 | 根拠 |',
    '|-------------------|------|---------------------|--------------------------|------|',
    '| VAL-NEW-mode-L1 | actionable | required_consumer_migration | 初回の確認は CLI 入口に限定 | project設定の正規化が不足 |',
    '| OLD-REVIEW-readme-L1 | out_of_scope | なし | 該当なし | 新しい反証なし |',
  ].join('\n');

  assert.equal(assertFinalReadinessSupervision(output).pass, true);
});

for (const [name, heading] of [
  ['actionable family', 'Actionable Families'],
  ['current finding', 'Current Iteration Findings (new)'],
]) {
  test(`rejects a previously excluded finding revived as ${name}`, () => {
    const revived = [
      `## ${heading}`,
      '| Finding ID / source | Issue |',
      '|---------------------|-------|',
      '| OLD-REVIEW-readme-L1 | requires work |',
    ].join('\n');

    const result = assertFinalReadinessSupervision(outputWith(revived));
    assert.equal(result.pass, false);
    assert.equal(result.reason.includes('old-finding-not-revived'), true);
  });
}

test('rejects omission of the prior finding disposition', () => {
  const output = ['## Result: REJECT', actionableFamily(), findingDispositions().split('\n').slice(0, 4).join('\n')].join('\n\n');
  const result = assertFinalReadinessSupervision(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('old-finding-disposition'), true);
});

test('rejects an authorization value outside the allowed values', () => {
  const output = outputWith().replace('required_consumer_migration', 'General quality improvement');
  const result = assertFinalReadinessSupervision(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('authorization-basis'), true);
});

test('rejects an omission reason without evidence for the initial review boundary', () => {
  const output = outputWith().replace(
    'Initial review evidence covered only the CLI entry',
    'Initial review finding',
  );
  const result = assertFinalReadinessSupervision(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-round-reason'), true);
});
