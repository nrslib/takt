import assert from 'node:assert/strict';
import test from 'node:test';
import assertRemediationResult from './remediation-evidence.mjs';
import buildRemediationEvidencePrompt from '../remediation-evidence-prompt.mjs';
import { assertBuiltinFacetIncluded } from './builtin-facet-assembly.mjs';

const unknownSection = '## 任意の実行記録がない未確認範囲（判定非ブロッキング）\nなし';

for (const label of ['verified', 'incomplete', 'plan_invalid']) {
  test(`accepts a single ${label} decision`, () => {
    assert.equal(assertRemediationResult(`## 結果: ${label}\n\nDetails\n\n${unknownSection}`, {
      vars: { expected_result: label },
    }).pass, true);
  });
}

test('rejects a template, contradictory decisions, and the wrong decision', () => {
  for (const output of [
    '## 結果: verified / incomplete / plan_invalid',
    '## 結果: verified\n\n## 結果: incomplete',
    '## Result: incomplete',
    'The expected label is verified.',
    '## 結果:\nverified',
  ]) {
    assert.equal(assertRemediationResult(`${output}\n\n${unknownSection}`, {
      vars: { expected_result: 'verified' },
    }).pass, false);
  }
});

test('requires one nonempty non-blocking unknown section in either language', () => {
  const context = { vars: { expected_result: 'verified' } };
  for (const section of [unknownSection, '## Unverified Scope Without Optional Execution Records (Non-blocking)\nNone']) {
    assert.equal(assertRemediationResult(`## Result: verified\n${section}`, context).pass, true);
    assert.equal(assertRemediationResult(`## Result: verified\n${section}\n${section}`, context).pass, false);
  }
  for (const section of ['', unknownSection.replace('なし', ''), unknownSection.replace('なし', '\n## 実行証跡\nCode inspected')]) {
    assert.equal(assertRemediationResult(`## 結果: verified\n${section}`, context).pass, false);
  }
});

test('selects each builtin language through facet expansion and preserves the default', () => {
  const vars = { task: 'Task', fix_plan: 'Plan', fix_report: 'Report' };
  for (const language of ['ja', 'en']) {
    const prompt = buildRemediationEvidencePrompt({ vars: { ...vars, language } });
    assertBuiltinFacetIncluded(prompt, language, 'policies/review.md');
    assertBuiltinFacetIncluded(prompt, language, 'output-contracts/fix-verification.md');
    assert.equal(prompt.includes('{{include:'), false);
  }
  assert.equal(buildRemediationEvidencePrompt({ vars }), buildRemediationEvidencePrompt({ vars: { ...vars, language: 'ja' } }));
});

test('rejects unsupported facet languages', () => {
  const vars = { task: 'Task', fix_plan: 'Plan', fix_report: 'Report' };
  assert.throws(() => buildRemediationEvidencePrompt({ vars: { ...vars, language: '../ja' } }), /Unknown facet language/);
});

test('assembles supplied reports without leaking the expected answer', () => {
  const prompt = buildRemediationEvidencePrompt({
    vars: {
      task: 'task-fixture-sentinel',
      fix_plan: 'plan-fixture-sentinel',
      fix_report: 'report-fixture-sentinel',
      expected_result: 'expected-answer-sentinel',
    },
  });
  for (const value of ['task-fixture-sentinel', 'plan-fixture-sentinel', 'report-fixture-sentinel']) {
    assert.ok(prompt.includes(value));
  }
  assert.equal(prompt.includes('expected-answer-sentinel'), false);
  assert.equal(prompt.includes('{report:'), false);
  assert.equal(prompt.includes('{{include:'), false);
});

test('rejects a missing report instead of silently omitting upstream context', () => {
  assert.throws(() => buildRemediationEvidencePrompt({
    vars: { task: 'Task', fix_plan: 'Plan' },
  }), /Missing report: fix-report.md/);
});
