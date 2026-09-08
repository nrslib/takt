import assert from 'node:assert/strict';
import test from 'node:test';
import assertRemediationResult from './remediation-evidence.mjs';
import buildRemediationEvidencePrompt from '../remediation-evidence-prompt.mjs';

for (const label of ['verified', 'incomplete', 'plan_invalid']) {
  test(`accepts a single ${label} decision`, () => {
    assert.equal(assertRemediationResult(`## 結果: ${label}\n\nDetails`, {
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
  ]) {
    assert.equal(assertRemediationResult(output, {
      vars: { expected_result: 'verified' },
    }).pass, false);
  }
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
