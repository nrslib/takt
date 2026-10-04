import assert from 'node:assert/strict';
import test from 'node:test';

import assertFinalReadinessRequirementGap from './final-readiness-requirement-gap.mjs';

test('accepts REJECT tied locally to the missing project source', () => {
  const output = `
## Result: REJECT

The project configuration result is missing the required source field.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('accepts the observed Japanese decision and unmet project-source row', () => {
  const output = `
# 最終判定: REJECT

| 要件 | 判定 | 根拠 |
|---|---|---|
| project 設定が \`source: 'project'\` を返す | **未充足** | 戻り値は \`{ mode: ... }\` のみ |
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('accepts the compact Japanese decision and unmet project-source bullet', () => {
  const output = `
## 判定: REJECT

- project設定の \`source: 'project'\` 返却: **未充足**
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('accepts an explicit statement that test logs are not required', () => {
  const output = `
## Result: REJECT

The project configuration result is missing the required source field.
Test logs are not required for this decision.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('accepts an explicit statement that machine-gate records are not decision grounds', () => {
  const output = `
## 判定: REJECT

プロジェクト設定の source フィールドが返されていないため未充足です。
機械ゲートの実行結果・記録の有無は、本判定の根拠にも差し戻し理由にもしていません。
`;
  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('rejects an unrelated unmet project-configuration row without source', () => {
  const output = `
# 最終判定: REJECT
| 要件 | 判定 | 根拠 |
|---|---|---|
| project 設定が description を返す | **未充足** | description がない |
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects APPROVE when the project source is missing', () => {
  const output = `
## Result: APPROVE

The project configuration result is missing the required source field.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects a decision based only on missing mock E2E records', () => {
  const output = `
## 結果: REJECT

npm run test:e2e:mock の実行結果がない。
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects when project source is satisfied and only mock E2E records are missing', () => {
  const output = `
## Result: REJECT
The project configuration source is present and satisfies the requirement.
The mock E2E execution result is missing, so remediation is required.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects the observed table form when project source is fulfilled and only execution records are missing', () => {
  const output = `
# 最終判定: REJECT
| 要件 | 判定 | 根拠 |
|---|---|---|
| project 設定が \`source: 'project'\` を返す | **充足** | source を返す |

mock E2E の実行結果がないため修正が必要です。
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects missing execution records disguised as a project source gap', () => {
  const output = `
## Result: REJECT
The project configuration verification report is missing source execution evidence, so remediation is required.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects a valid source gap combined with a separate mock E2E record requirement', () => {
  const output = `
## Result: REJECT
The project configuration result is missing the required source field.
The mock E2E execution result is missing, so remediation is also required.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('rejects the removed FIX REQUIRED result vocabulary', () => {
  const output = `
## Result: FIX REQUIRED
The project configuration result is missing the required source field.
`;

  assert.equal(assertFinalReadinessRequirementGap(output).pass, false);
});

test('accepts an unimplemented project source in a CLI provider wrapper', () => {
  const output = JSON.stringify({
    output: "## 判定: REJECT（差し戻し）\n\nプロジェクト設定入口の `source: 'project'` が未実装です。",
  });
  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});

test('accepts project context and the missing source on separate lines', () => {
  const output = `
## 判定: REJECT

CLI・プロジェクト設定双方の mode 正規化は充足しています。

- 根拠: fromProjectConfig の返却値が \`{ mode: normalizeMode(config.mode) }\` のみで、\`source: 'project'\` を含まない。
`;
  assert.equal(assertFinalReadinessRequirementGap(output).pass, true);
});
