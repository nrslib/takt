import assert from 'node:assert/strict';
import test from 'node:test';
import buildInput from '../implementation-report-handoff-prompt.mjs';
import assertReportHandoff from '../asserts/implementation-report-handoff.mjs';
import Provider, {
  buildReportHandoffPrompt,
  loadReportHandoffStep,
  resolveReportHandoffRoute,
} from './implementation-report-handoff.mjs';

const input = {
  language: 'ja',
  workflow: 'development-implement-dynamic',
  task: 'Keep the assigned contract meaning.',
  reports: [{ reference: 'plan.md', scope: 'parent-run-readonly', content: 'SOURCE-ID: preserve case' }],
  workResult: 'LATEST-WORK: case-preservation test passed',
};

test('only supplied inputs reach the scenario, without expected outcomes', () => {
  assert.deepEqual(JSON.parse(buildInput({ vars: {
    task: input.task, reports: input.reports, work_result: input.workResult,
    expected_route: 'SECRET-EXPECTED-ROUTE', expected_ids: ['SECRET-EXPECTED-ID'],
  } })), input);
});

test('report input carries exact upstream content and current result in both languages and all implementation variants', () => {
  for (const language of ['ja', 'en']) {
    for (const workflow of ['development-implement', 'development-implement-dynamic', 'development-implement-team']) {
      const step = loadReportHandoffStep(language, workflow);
      const prompt = buildReportHandoffPrompt(step, { ...input, language }, '/eval/project');
      const records = prompt.split('\n').filter(line => line.startsWith('{"reference":')).map(JSON.parse);
      assert.deepEqual(records, input.reports);
      assert.ok(prompt.includes(input.workResult));
      for (const contract of step.outputContracts) {
        assert.ok(prompt.includes(contract.format));
        assert.ok(prompt.includes(contract.order));
      }
    }
  }
});

test('judgment consumes the generated report, not the supplied implementation claim', async () => {
  const calls = [];
  let cleaned = false;
  const report = '| SOURCE-ID | preserve case | observed MixedCase |';
  const provider = new Provider({}, {
    prepare: () => ({ cwd: '/eval/project', cleanup: () => { cleaned = true; } }),
    run: async (_config, prompt) => {
      calls.push(prompt);
      return calls.length === 1 ? report : '[IMPLEMENT:1]';
    },
  });
  const result = await provider.callApi(JSON.stringify(input));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(input.workResult));
  assert.ok(calls[1].includes(report));
  assert.ok(!calls[1].includes(input.workResult));
  assert.equal(JSON.parse(result.output).report, report);
  assert.equal(cleaned, true);
});

test('a report generation failure stops before judgment and releases the fixture', async () => {
  let calls = 0;
  let cleaned = false;
  const provider = new Provider({}, {
    prepare: () => ({ cwd: '/eval/project', cleanup: () => { cleaned = true; } }),
    run: async () => { calls += 1; throw new Error('provider unavailable'); },
  });
  const result = await provider.callApi(JSON.stringify(input));
  assert.equal(calls, 1);
  assert.equal(typeof result.error, 'string');
  assert.equal(cleaned, true);
});

test('missing, duplicate, and out-of-range judgment tags cannot count as success', () => {
  const step = { rules: [{ next: 'COMPLETE' }, { returnValue: 'need_replan' }, { next: 'ABORT' }] };
  assert.equal(resolveReportHandoffRoute(step, '[IMPLEMENT:2]'), 'need_replan');
  for (const value of ['', '[IMPLEMENT:0]', '[IMPLEMENT:4]', '[IMPLEMENT:1]\n[IMPLEMENT:3]']) {
    assert.throws(() => resolveReportHandoffRoute(step, value));
  }
});

test('assertion requires a route and separate contract rows rather than an ID mentioned in prose', () => {
  const context = { vars: { expected_route: 'COMPLETE', expected_ids: ['C-1', 'C-2'] } };
  const outcome = report => JSON.stringify({ route: 'COMPLETE', report: `| 契約ID | 義務 | 状態 |\n|---|---|---|\n${report}` });
  const validRows = '| C-1 | first | 確認済み |\n| `C-2` | second | 確認済み |';
  assert.equal(assertReportHandoff(outcome(validRows), context).pass, true);
  for (const output of ['', outcome('C-1 and C-2 complete'), outcome('| C-1 | first | 確認済み |'), outcome(''), outcome('| C-1 | first |\n| C-2 | second |')]) {
    assert.equal(assertReportHandoff(output, context).pass, false);
  }
  assert.equal(assertReportHandoff(outcome(validRows), { vars: {} }).pass, false);
  assert.equal(assertReportHandoff(outcome(validRows.replace('first', 'see C-3')), context).pass, false);
  assert.equal(assertReportHandoff(outcome(`${validRows}\nSee NEW-ID-01.`), context).pass, false);
});

test('assertion checks completion rows rather than IDs appearing only in the impact table', () => {
  const report = '| Contract ID | Obligation | Status |\n|---|---|---|\n| C-1 | first | Verified |\n\n'
    + '| Contract ID | Impact |\n|---|---|\n| C-2 | second |';
  const output = JSON.stringify({ route: 'COMPLETE', report });
  assert.equal(assertReportHandoff(output, { vars: { expected_route: 'COMPLETE', expected_ids: ['C-1'] } }).pass, false);
  assert.equal(assertReportHandoff(output, { vars: { expected_route: 'COMPLETE', expected_ids: ['C-1', 'C-2'] } }).pass, false);
});

test('assertion supports English and ID-less rows but rejects unknown or omitted statuses', () => {
  const context = { vars: { expected_route: 'COMPLETE', expected_ids: [] } };
  const outcome = status => JSON.stringify({ route: 'COMPLETE', report: `| Contract ID | Obligation | Status |\n|---|---|---|\n| No ID | first | ${status} |` });
  assert.equal(assertReportHandoff(outcome('Verified'), context).pass, true);
  for (const status of ['', 'Maybe', 'Verified / Incomplete']) {
    assert.equal(assertReportHandoff(outcome(status), context).pass, false);
  }
});
