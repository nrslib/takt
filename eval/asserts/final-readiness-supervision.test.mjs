import assert from 'node:assert/strict';
import test from 'node:test';

import assertFinalReadinessSupervision from './final-readiness-supervision.mjs';

function newFindingTable() {
  return [
    '## Current Iteration Findings (new)',
    '| finding_id | Location | Issue | Authorization Basis | Reason Absent from Initial Round |',
    '|------------|----------|-------|---------------------|----------------------------------|',
    '| MERGE-NEW-mode-L1 | `src/mode.js` configuration entry | Missing normalization | required_consumer_migration | Initial evidence covered only another entry |',
  ].join('\n');
}

function priorDisposition() {
  return [
    '## Re-evaluation of Prior Findings',
    '| finding_id | Re-evaluation | Evidence |',
    '|------------|---------------|----------|',
    '| OLD-REVIEW-readme-L1 | out_of_scope | No current counter-evidence |',
  ].join('\n');
}

function outputWith(...sections) {
  return ['## Result: REJECT', newFindingTable(), priorDisposition(), ...sections].join('\n\n');
}

test('accepts an authorized new finding while preserving a non-actionable disposition', () => {
  assert.equal(assertFinalReadinessSupervision(outputWith()).pass, true);
});

test('accepts the equivalent Japanese lifecycle structure', () => {
  const output = [
    '## 結果: REJECT',
    '## 今回の指摘（new）',
    '| finding_id | 項目 | 理由 | Authorization basis | 初回に含まれなかった理由 |',
    '|------------|------|------|---------------------|--------------------------|',
    '| VAL-NEW-mode-L1 | project設定 | 正規化が不足 | required_consumer_migration | 初回証跡はCLI入口だけに限定 |',
    '## 前段 finding の再評価',
    '| finding_id | 再評価 |',
    '|------------|--------|',
    '| OLD-REVIEW-readme-L1 | 対象外 |',
  ].join('\n');

  assert.equal(assertFinalReadinessSupervision(output).pass, true);
});

for (const [name, heading, id] of [
  ['new', 'Current Iteration Findings (new)', 'MERGE-NEW-readme-L1'],
  ['carry-over', 'Carry-over Findings (persists)', 'MERGE-PERSIST-mode-L1'],
  ['reopened', 'Reopened Findings (reopened)', 'MERGE-REOPENED-mode-L1'],
  ['actionable', 'Actionable Families', 'family-mode'],
]) {
  test(`rejects a previously non-actionable finding revived as ${name}`, () => {
    const revived = [
      `## ${heading}`,
      '| finding_id | Issue |',
      '|------------|-------|',
      `| OLD-REVIEW-readme-L1 | ${id} requires work |`,
    ].join('\n');

    const result = assertFinalReadinessSupervision(outputWith(revived));

    assert.equal(result.pass, false);
    assert.equal(result.reason.includes('old-finding-not-revived'), true);
  });
}

test('does not infer a prior disposition from explanatory prose', () => {
  const output = outputWith().replace(
    priorDisposition(),
    'The OLD-REVIEW-readme-L1 item was described as out_of_scope in earlier prose.',
  );

  const result = assertFinalReadinessSupervision(output);

  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('old-finding-disposition'), true);
});

test('does not revive a prior finding mentioned only in actionable prose', () => {
  const actionable = [
    '## Actionable Families',
    '| finding_id | Issue |',
    '|------------|-------|',
    '| MERGE-NEW-mode-L2 | This is distinct from OLD-REVIEW-readme-L1 |',
  ].join('\n');

  assert.equal(assertFinalReadinessSupervision(outputWith(actionable)).pass, true);
});

test('rejects omission of the prior non-actionable disposition', () => {
  const output = ['## Result: REJECT', newFindingTable()].join('\n\n');

  const result = assertFinalReadinessSupervision(output);

  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('old-finding-disposition'), true);
});

test('rejects an authorization label outside the allowed bases', () => {
  const output = outputWith().replace('required_consumer_migration', 'General quality improvement');

  const result = assertFinalReadinessSupervision(output);

  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('authorization-basis'), true);
});

test('rejects an omission label without evidence for why the initial review missed it', () => {
  const output = outputWith().replace(
    'Initial evidence covered only another entry',
    'Initial review finding',
  );

  const result = assertFinalReadinessSupervision(output);

  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-round-reason'), true);
});
