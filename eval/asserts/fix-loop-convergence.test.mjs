import assert from 'node:assert/strict';
import test from 'node:test';

import buildFixLoopConvergencePrompt from '../fix-loop-convergence-prompt.mjs';
import assertFixLoopConvergence from './fix-loop-convergence.mjs';

const E06_OUTPUT = `
## 不変条件の再発記録

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 |
|---|---|---|---|
| FP-PICKER-STATE | FAM-RETRY-PICKER | INV-RESUME-DEFAULT | TaskRetryRestartTree |
| FP-PICKER-STATE | FAM-RETRY-PICKER | INV-BUDGET-50 | TaskRetryRestartTree |
`;

const E13A_OUTPUT = `
## 結果: verified

## 不変条件の再発記録

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 | 今回の検証回数 | 前回の検証回数 | 前回経路 | 今回経路 | 同一不変条件・再発判定 | 累積 \`incomplete\` 回数 | 別経路での再発が確認済みか | 強制点候補 | 記録の完全性 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FP-PICKER-STATE | FAM-RETRY-PICKER | BW-2 | TaskRetryRestartTree の target 解決と visible projection | 2 | 1 | なし（引え継ぎ行なし） | P3: prune 復帰漏れ | 同一・再発 | 2 | 確認済み | 単一 window setter への集約 | 完全 |

JUDGEMENT: result=verified; semantic_carry_forward=維持
`;

function run(output, scenario) {
  return assertFixLoopConvergence(output, { vars: { scenario } });
}

test('fix-loop prompt orders scenario, instruction, and output contract', async () => {
  const prompt = await buildFixLoopConvergencePrompt({
    vars: { role: 'verifier', scenario: 'E13a' },
  });

  const scenarioIndex = prompt.indexOf('### fix-plan.md（抜粋）');
  const instructionIndex = prompt.indexOf('--- INSTRUCTION（全文） ---');
  const outputContractIndex = prompt.indexOf('--- OUTPUT CONTRACT（全文） ---');

  assert.ok(scenarioIndex >= 0);
  assert.ok(scenarioIndex < instructionIndex);
  assert.ok(instructionIndex < outputContractIndex);
});

test('E06 accepts each planned invariant exactly once in recurrence-record rows', () => {
  assert.equal(run(E06_OUTPUT, 'E06').pass, true);
});

test('E06 accepts a provider output envelope', () => {
  assert.equal(run(JSON.stringify({ output: E06_OUTPUT }), 'E06').pass, true);
});

test('E06 accepts recurrence rows under a child heading', () => {
  const nestedRows = E06_OUTPUT.replace(
    '## 不変条件の再発記録\n\n',
    '## 不変条件の再発記録\n\n### 詳細\n\n',
  );

  assert.equal(run(nestedRows, 'E06').pass, true);
});

test('E06 rejects a missing or duplicate planned invariant row', () => {
  assert.equal(run(E06_OUTPUT.replace(/.*INV-BUDGET-50.*\n/, ''), 'E06').pass, false);
  assert.equal(run(`${E06_OUTPUT}| FP-PICKER-STATE | FAM-RETRY-PICKER | INV-BUDGET-50 | Other |\n`, 'E06').pass, false);
});

test('E06 rejects planned invariant names placed outside the invariant-name column', () => {
  const wrongNameColumn = `
## 不変条件の再発記録

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 |
|---|---|---|---|
| INV-RESUME-DEFAULT | FAM-RETRY-PICKER | WRONG-A | TaskRetryRestartTree |
| INV-BUDGET-50 | FAM-RETRY-PICKER | WRONG-B | TaskRetryRestartTree |
`;

  assert.equal(run(wrongNameColumn, 'E06').pass, false);
});

test('E13a accepts semantic-equivalent prose while preserving mechanical recurrence state', () => {
  // Given
  const mutations = [
    ['| 2 | 1 | なし（引え継ぎ行なし） |', '| 2 | 9 | なし（引え継ぎ行なし） |'],
    ['なし（引え継ぎ行なし）', 'P2: 親 window 置換'],
    ['| 同一・再発 | 2 |', '| 維持 | 2 |'],
  ];
  const output = E13A_OUTPUT;

  // When
  const result = run(output, 'E13a');
  const mutationResults = mutations.map(([before, after]) =>
    run(output.replace(before, after), 'E13a').pass);

  // Then
  assert.equal(result.pass, true);
  assert.deepEqual(mutationResults, [false, false, false]);
});

test('E13 accepts the normalized English recurrence-judgement header', () => {
  // Given
  const output = E13A_OUTPUT.replace(
    '同一不変条件・再発判定',
    'Same-Invariant / Recurrence Judgment',
  );

  // When
  const result = run(output, 'E13a');

  // Then
  assert.equal(result.pass, true);
});

test('E13 JavaScript assertion leaves human-cell semantics to the rubric', () => {
  // Given
  const japaneseParaphrases = [
    E13A_OUTPUT
      .replace(
        'TaskRetryRestartTree の target 解決と visible projection',
        'TaskRetryRestartTree における target の解決および表示投影',
      )
      .replace('単一 window setter への集約', '一つの window setter に処理を集約する'),
    E13A_OUTPUT
      .replace(
        'TaskRetryRestartTree の target 解決と visible projection',
        '対象解決と画面に見える投影は TaskRetryRestartTree が受け持つ',
      )
      .replace('単一 window setter への集約', 'window の更新入口を一か所へまとめる'),
  ];
  const semanticContradiction = E13A_OUTPUT
    .replace(
      'TaskRetryRestartTree の target 解決と visible projection',
      'TaskRetryRestartTree は target 解決と visible projection を担当せず UI 層へ移譲する',
    )
    .replace('単一 window setter への集約', 'window setter は強制点ではない');

  // When
  const paraphraseResults = japaneseParaphrases.map((output) => run(output, 'E13a').pass);
  const contradictionResult = run(semanticContradiction, 'E13a');

  // Then
  assert.deepEqual(paraphraseResults, [true, true]);
  assert.equal(contradictionResult.pass, true);
});
