import assert from 'node:assert/strict';

export function assertManagerInputPartition({ replay, execution }) {
  const key = ({ case: caseId, lang }) => `${caseId}/${lang}`;
  const expectedExecution = [
    'stopped-background-execution/ja', 'stopped-background-execution/en',
    'integrated-task-execution/ja', 'integrated-task-execution/en',
    'two-goal-pr-execution/ja', 'two-goal-pr-execution/en',
    'finite-check-external-execution/ja', 'finite-check-external-execution/en',
  ];
  assert.deepEqual(execution.map(key).sort(), expectedExecution.sort());
  assert.equal(new Set(execution.map(({ case: caseId }) => caseId)).size, 4);
  assert.equal(replay.length, 142);
  assert.equal(new Set(replay.map(({ case: caseId }) => caseId)).size, 71);
  const inputs = [...replay, ...execution];
  assert.equal(inputs.length, 150);
  assert.equal(new Set(inputs.map(key)).size, 150);
  const cases = new Set(inputs.map(({ case: caseId }) => caseId));
  assert.equal(cases.size, 75);
  for (const caseId of cases) {
    assert.deepEqual(inputs.filter((input) => input.case === caseId).map(({ lang }) => lang).sort(), ['en', 'ja']);
  }
}
