import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const E12_OUTPUT = `
## 指摘カバレッジ

| finding ID / 出典 | 修正単位 |
|---|---|
| ARCH-NEW-picker-L520 | FP-PICKER-ORDER |

### 引き継ぎ元からの行

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 | 累積 \`incomplete\` 回数 | 別経路での再発が確認済みか | 強制点候補 |
|---|---|---|---|---|---|---|
| FP-PICKER-STATE | FAM-RETRY-PICKER | BW-2 | TaskRetryRestartTree の target 解決・visible projection | 3 | 確認済み | 単一 window setter への集約 |

## 実施順序

| 順序 | 修正単位 | 変更対象 |
|---|---|---|
| 1 | FP-PICKER-ORDER | picker order setter |
`;
const E12_JUDGEMENT = 'JUDGEMENT: bw2_inherited=継承; '
  + 'bw2_recurrence_confirmed=確認済み; bw2_cumulative=3; '
  + 'nonactionable_in_work=含まない';
const E12_CLAUDE_OPUS_OUTPUT = readFileSync(
  new URL('../fixtures/fix-loop-convergence/e12-claude-opus-output.md', import.meta.url),
  'utf8',
);
const E12_CODEX_SOL_OUTPUT = readFileSync(
  new URL('../fixtures/fix-loop-convergence/e12-codex-sol-output.md', import.meta.url),
  'utf8',
);
const FIX_PLAN_OUTPUT_CONTRACT = readFileSync(
  new URL('../../builtins/ja/facets/partials/output-contracts/base-fix-plan.md', import.meta.url),
  'utf8',
);
const INVARIANT_RECURRENCE_RULE = readFileSync(
  new URL('../../builtins/ja/workflows/rules/invariant-recurrence.md', import.meta.url),
  'utf8',
);
const FIX_LOOP_CONFIG = readFileSync(
  new URL('../promptfooconfig.fix-loop-convergence.yaml', import.meta.url),
  'utf8',
);

const E13A_OUTPUT = `
## 結果: verified

## 不変条件の再発記録

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 | 今回の検証回数 | 前回の検証回数 | 前回経路 | 今回経路 | 同一不変条件・再発判定 | 累積 \`incomplete\` 回数 | 別経路での再発が確認済みか | 強制点候補 | 記録の完全性 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FP-PICKER-STATE | FAM-RETRY-PICKER | BW-2 | TaskRetryRestartTree の target 解決と visible projection | 2 | 1 | なし（引え継ぎ行なし） | P3: prune 復帰漏れ | 同一・再発 | 2 | 確認済み | 単一 window setter への集約 | 完全 |

JUDGEMENT: result=verified; semantic_carry_forward=維持
`;

const E13B_OUTPUT = `
## 結果: incomplete

## 不変条件の再発記録

| 修正単位 | family ID | 不変条件の名前 | 担当箇所 | 今回の検証回数 | 前回の検証回数 | 前回経路 | 今回経路 | 同一不変条件・再発判定 | 累積 \`incomplete\` 回数 | 別経路での再発が確認済みか | 強制点候補 | 記録の完全性 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FP-PICKER-STATE | FAM-RETRY-PICKER | BW-2 | TaskRetryRestartTree の target 解決・visible projection | 2 | 1 | P2: 親 window 置換 | P3: prune 復帰漏れ | 同一・再発 | 2 | 確認済み | 単一 window setter への集約 | 理由付き成果物不足: fix-report が P3 を P4 に無断変更 |

## 不成立・未確認事項

- fix-report の今回経路は正本 P3 から P4 に無断変更され、裏付ける検証成果物が不足している。

JUDGEMENT: result=incomplete; semantic_carry_forward=不一致
`;

function run(output, scenario) {
  return assertFixLoopConvergence(output, { vars: { scenario } });
}

test('fix-plan prompt includes the expanded output contract', async () => {
  const prompt = await buildFixLoopConvergencePrompt({
    vars: { role: 'fix-plan', scenario: 'E12' },
  });

  assert.match(prompt, /--- OUTPUT CONTRACT（全文） ---/);
  assert.ok(prompt.includes(FIX_PLAN_OUTPUT_CONTRACT));
  assert.doesNotMatch(prompt, /\{\{include:output-contracts\/base-fix-plan\}\}/);
});

test('fix-loop prompt orders scenario, isolated workflow rule, instruction, and output contract', async () => {
  const prompt = await buildFixLoopConvergencePrompt({
    vars: { role: 'verifier', scenario: 'E13a' },
  });

  const scenarioIndex = prompt.indexOf('### fix-plan.md（抜粋）');
  const ruleIndex = prompt.indexOf('--- EVALUATION WORKFLOW RULE（invariant-recurrence のみ） ---');
  const instructionIndex = prompt.indexOf('--- INSTRUCTION（全文） ---');
  const outputContractIndex = prompt.indexOf('--- OUTPUT CONTRACT（全文） ---');

  assert.ok(scenarioIndex >= 0);
  assert.ok(scenarioIndex < ruleIndex);
  assert.ok(ruleIndex < instructionIndex);
  assert.ok(instructionIndex < outputContractIndex);
  assert.ok(prompt.includes(INVARIANT_RECURRENCE_RULE));
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

test('E12 accepts unchanged BW-2 fields, a separate actionable row, and bounded work', () => {
  assert.equal(run(E12_OUTPUT, 'E12').pass, true);
});

test('E12 accepts explanatory mentions of the non-actionable invariant', () => {
  assert.equal(run(E12_CLAUDE_OPUS_OUTPUT, 'E12').pass, true);
});

test('E12 accepts explanatory mentions of the actionable finding', () => {
  assert.equal(run(E12_CODEX_SOL_OUTPUT, 'E12').pass, true);
});

test('E12 accepts a report wrapped once in an outer fenced code block', () => {
  const withLanguage = '```markdown\n' + E12_OUTPUT + '```';
  const withoutLanguage = '~~~\n' + E12_OUTPUT + '~~~';

  assert.equal(run(withLanguage, 'E12').pass, true);
  assert.equal(run(withoutLanguage, 'E12').pass, true);
  assert.equal(run(JSON.stringify({ output: withLanguage }), 'E12').pass, true);
});

test('E12 accepts a final JUDGEMENT line after the outer fenced report', () => {
  const output = '```markdown\n' + E12_OUTPUT + '```\n\n' + E12_JUDGEMENT;

  assert.equal(run(output, 'E12').pass, true);
  assert.equal(run(JSON.stringify({ output }), 'E12').pass, true);
});

test('E12 rejects a changed carried value or an actionable finding merged into the BW-2 row', () => {
  const actionableFindingMergedIntoBw2 = E12_OUTPUT
    .replace(
      '| 修正単位 | family ID | 不変条件の名前 | 担当箇所 |',
      '| finding ID / 出典 | family ID | 不変条件の名前 | 担当箇所 |',
    )
    .replace(
      '| FP-PICKER-STATE | FAM-RETRY-PICKER | BW-2 |',
      '| ARCH-NEW-picker-L520 | FAM-RETRY-PICKER | BW-2 |',
    );

  assert.equal(run(E12_OUTPUT.replace('| 3 | 確認済み |', '| 2 | 確認済み |'), 'E12').pass, false);
  assert.equal(run(actionableFindingMergedIntoBw2, 'E12').pass, false);
});

test('E12 rejects the actionable finding as execution work or a key outside planning sections', () => {
  const executionWork = E12_OUTPUT.replace('picker order setter', 'ARCH-NEW-picker-L520');
  const keyOutsidePlanning = `${E12_OUTPUT}
## 制約適合性

| finding ID / 出典 | 根拠 |
|---|---|
| ARCH-NEW-picker-L520 | 説明 |
`;

  assert.equal(run(executionWork, 'E12').pass, false);
  assert.equal(run(keyOutsidePlanning, 'E12').pass, false);
});

test('E12 rejects the non-actionable invariant in execution or code-change-target sections', () => {
  assert.equal(run(E12_OUTPUT.replace('picker order setter', 'INV-EMPTY-TERM'), 'E12').pass, false);
  assert.equal(run(`${E12_OUTPUT}\n## コード変更対象\n\nINV-EMPTY-TERM\n`, 'E12').pass, false);
});

test('E12 rejects the non-actionable invariant in finding coverage', () => {
  const nonActionableCoverage = E12_OUTPUT.replace(
    '| ARCH-NEW-picker-L520 | FP-PICKER-ORDER |',
    '| ARCH-NEW-picker-L520 | FP-PICKER-ORDER |\n| INV-EMPTY-TERM | FP-EMPTY |',
  );

  assert.equal(run(nonActionableCoverage, 'E12').pass, false);
});

test('E12 rejects the non-actionable invariant under a child heading in finding coverage', () => {
  const nestedNonActionableCoverage = E12_OUTPUT.replace(
    '| ARCH-NEW-picker-L520 | FP-PICKER-ORDER |',
    `| ARCH-NEW-picker-L520 | FP-PICKER-ORDER |

### 補足

| finding ID / 出典 | 修正単位 |
|---|---|
| INV-EMPTY-TERM | FP-EMPTY |`,
  );

  assert.equal(run(nestedNonActionableCoverage, 'E12').pass, false);
});

test('E12 keeps apparent headings inside fenced code blocks in their parent work section', () => {
  const fencedOutputs = [
    E12_OUTPUT + '\n```text\n## 補足\n```\nINV-EMPTY-TERM\n',
    E12_OUTPUT + '\n~~~text\n## 補足\n~~~\nINV-EMPTY-TERM\n',
    E12_OUTPUT + '\n```text\n## 補足\nINV-EMPTY-TERM\n',
  ];

  for (const output of fencedOutputs) {
    assert.equal(run(output, 'E12').pass, false);
  }
});

test('E12 recognizes ATX headings with up to three leading spaces but not four', () => {
  const threeSpaceHeading = E12_OUTPUT.replace('## 実施順序', '   ## 実施順序');
  const indentedHeading = E12_OUTPUT + '\n    ## 補足\nINV-EMPTY-TERM\n';

  assert.equal(run(threeSpaceHeading, 'E12').pass, true);
  assert.equal(run(indentedHeading, 'E12').pass, false);
});

test('E12 rejects BW-2 and the actionable finding outside their allowed sections', () => {
  assert.equal(run(E12_OUTPUT.replace('### 引き継ぎ元からの行', '### サマリー'), 'E12').pass, false);
  assert.equal(run(E12_OUTPUT.replace('## 指摘カバレッジ', '## サマリー'), 'E12').pass, false);
});

test('E13a accepts semantic-equivalent prose while preserving mechanical recurrence state', () => {
  assert.equal(run(E13A_OUTPUT, 'E13a').pass, true);
  const mutations = [
    ['| 2 | 1 | なし（引え継ぎ行なし） |', '| 2 | 9 | なし（引え継ぎ行なし） |'],
    ['なし（引え継ぎ行なし）', 'P2: 親 window 置換'],
    ['| 同一・再発 | 2 |', '| 維持 | 2 |'],
  ];
  for (const [before, after] of mutations) {
    assert.equal(run(E13A_OUTPUT.replace(before, after), 'E13a').pass, false);
  }
});

test('E13 JavaScript assertion leaves human-cell semantics to the rubric', () => {
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

  for (const output of japaneseParaphrases) {
    assert.equal(run(output, 'E13a').pass, true);
  }
  assert.equal(run(semanticContradiction, 'E13a').pass, true);
  assert.match(FIX_LOOP_CONFIG, /キーワードを残していても責務を否定/);
  assert.match(FIX_LOOP_CONFIG, /UI 層へ移譲/);
  assert.match(FIX_LOOP_CONFIG, /強制点を否定/);
});

test('E13b requires incomplete and reconstructs the canonical P3 row', () => {
  assert.equal(run(E13B_OUTPUT, 'E13b').pass, true);
  const shortRow = E13B_OUTPUT.replace(
    /\| 修正単位 \| family ID[\s\S]*?理由付き成果物不足: fix-report が P3 を P4 に無断変更 \|/,
    '| 修正単位 | family ID |\n|---|---|\n| FP-PICKER-STATE | FAM-RETRY-PICKER |',
  );
  assert.equal(run(shortRow, 'E13b').pass, false);
  assert.equal(
    run(E13B_OUTPUT.replace('P3: prune 復帰漏れ', 'P4: restore 復帰漏れ'), 'E13b').pass,
    false,
  );
  assert.equal(
    run(E13B_OUTPUT.replaceAll('incomplete', 'verified').replace('不一致', '維持'), 'E13b').pass,
    false,
  );
});
