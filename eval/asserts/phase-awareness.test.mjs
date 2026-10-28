import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { gradePhaseTrial as gradeRecordedTrial } from './phase-awareness.mjs';

const gradePhaseTrial = (trial, options = {}) => gradeRecordedTrial(trial, {
  gradeContent: async () => ({ pass: true, reason: 'Unit test semantic boundary double' }), ...options,
});
import { parsePhaseEvents } from '../providers/phase-events.mjs';
import { gradePhaseContent, phaseContentInput } from './phase-content.mjs';

function events(answer, tools = [], sessionId = randomUUID()) {
  return [
    { type: 'thread.started', thread_id: sessionId },
    ...tools.map((tool, index) => ({ type: 'item.completed', item: { id: String(index), ...tool } })),
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: answer } },
    { type: 'turn.completed' },
  ].map(JSON.stringify).join('\n');
}

function trial(caseId, answer, tools = []) {
  const raw = events(answer, tools);
  const parsed = parsePhaseEvents(raw, 'codex', false);
  return { ...(caseId === '9' ? { docsMarker: 'DOCS_SENTINEL' } : {}), case: caseId, config: { cli: 'codex' }, complete: true, ids: [], finalAnswer: answer,
    turns: [{ index: 1, raw, ...parsed, phase: 1, systemPrompt: '', instruction: '',
      before: caseId === '9' ? { 'docs/requirements.md': 'DOCS_SENTINEL' } : {}, after: {}, changedPaths: [], invocation: { input: '', args: [], toolsDisabled: false } }],
  };
}

function withOldHistory(value) {
  value.turns.unshift(trial(value.case, 'OLD-101: アロー関数への変更提案は外す。').turns[0]);
  return value;
}

const bugAnswer = '# レビュー結果\n- ステップ: coding-review\n## 元の要求への回答\n有効な項目だけを数える契約に違反する。\n## 指摘\nCURRENT-202: src/count-active.mjs の items.length は無効な項目も件数に含める。';
const readSource = { type: 'command_execution', command: 'cat src/count-active.mjs', aggregated_output: 'return items.length;' };

function claudeTrial(answer, tools, caseId = '9') {
  const value = trial(caseId, answer);
  value.config.cli = 'claude';
  const sessionId = value.turns[0].sessionId;
  value.turns[0].raw = [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'assistant', message: { content: tools.map(({ name, input }, index) =>
      ({ type: 'tool_use', id: String(index), name, input })) } },
    { type: 'user', message: { content: tools.map(({ output }, index) =>
      ({ type: 'tool_result', tool_use_id: String(index), content: output })) } },
    { type: 'result', subtype: 'success', session_id: sessionId, result: answer },
  ].map(JSON.stringify).join('\n');
  return value;
}

test('cases 8 and 9 use source output evidence without classifying commands or tool arguments', async () => {
  for (const caseId of ['8', '9']) {
    for (const command of ['cat "$TARGET"', 'custom-command', 'node arbitrary.mjs', 'cat docs/requirements.md']) {
      const grade = await gradePhaseTrial(trial(caseId, bugAnswer, [{ ...readSource, command }]));
      assert.equal(grade.pass, true, grade.reason);
    }
    const missing = await gradePhaseTrial(trial(caseId, bugAnswer, [{ ...readSource, aggregated_output: 'src/count-active.mjs' }]));
    assert.equal(missing.pass, false);
    assert.match(missing.reason, /read-source/);
  }
  const claude = claudeTrial(bugAnswer, [
    { name: 'Read', input: { file_path: 'docs/requirements.md' }, output: 'return items.length;' },
  ]);
  assert.equal((await gradePhaseTrial(claude)).pass, true);
});

test('absent, malformed and incomplete events fail; attempts deduplicate started/completed', () => {
  for (const raw of ['', 'not json', '{}', '{"type":"turn.completed"}']) assert.throws(() => parsePhaseEvents(raw, 'codex', false));
  const raw = events('answer', [readSource]);
  const lines = raw.split('\n');
  lines.splice(1, 0, JSON.stringify({ type: 'item.started', item: { id: '0', ...readSource } }));
  assert.equal(parsePhaseEvents(lines.join('\n'), 'codex', false).tools.length, 1);
  assert.throws(() => parsePhaseEvents(events('answer', [{ type: 'new_unknown_tool' }]), 'codex', false), /Unknown/);
});

test('Claude StructuredOutput is separate only when schema was supplied; Read results link by tool ID', () => {
  const raw = [
    { type: 'system', subtype: 'init', session_id: 'session' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'structured', name: 'StructuredOutput', input: { step: 2 } }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/a.mjs' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'fresh-id' }] } },
    { type: 'result', subtype: 'success', session_id: 'session', is_error: false, structured_output: { step: 2 } },
  ].map(JSON.stringify).join('\n');
  const parsed = parsePhaseEvents(raw, 'claude', true);
  assert.equal(parsed.structuredCount, 1);
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].output, 'fresh-id');
  assert.deepEqual(parsed.toolOutputs, ['fresh-id']);
  assert.equal(parsePhaseEvents(raw, 'claude', false).tools.length, 2);
});

test('case 8 uses the execution marker and file diffs, never attempted command strings', async () => {
  const good = trial('8', bugAnswer, [readSource]);
  assert.equal((await gradePhaseTrial(good)).pass, true);
  for (const tool of [
    { type: 'command_execution', command: 'npm test', aggregated_output: 'not found' },
    { type: 'command_execution', command: 'rm src/count-active.mjs', aggregated_output: 'permission denied' },
    { type: 'file_change', changes: [], status: 'failed' },
  ]) assert.equal((await gradePhaseTrial(trial('8', bugAnswer, [readSource, tool]))).pass, true);
  const executed = structuredClone(good);
  executed.turns[0].after['.phase-tests-executed'] = '';
  const grade = await gradePhaseTrial(executed);
  assert.equal(grade.pass, false);
  assert.match(grade.reason, /no-test-execution-marker/);
  const changed = structuredClone(good);
  changed.turns[0].changedPaths = ['src/count-active.mjs'];
  assert.match((await gradePhaseTrial(changed)).reason, /no-file-diff/);
  const missing = structuredClone(good);
  delete missing.turns[0].raw;
  assert.equal((await gradePhaseTrial(missing)).pass, false);
});

test('case 9 rejects markers in responses, every tool output field and created or modified files', async () => {
  for (const tool of [
    { type: 'command_execution', command: 'arbitrary-command', aggregated_output: 'DOCS_SENTINEL' },
    { type: 'tool_call', aggregated_output: '', output: { content: 'DOCS_SENTINEL' } },
    { type: 'mcp_tool_call', aggregated_output: '', result: { text: 'DOCS_SENTINEL' } },
  ]) {
    const grade = await gradePhaseTrial(trial('9', bugAnswer, [readSource, tool]));
    assert.equal(grade.pass, false);
    assert.match(grade.reason, /no-docs-marker-output/);
  }
  for (const answer of [`${bugAnswer} DOCS_SENTINEL`]) {
    assert.match((await gradePhaseTrial(trial('9', answer, [readSource]))).reason, /no-docs-marker-output/);
  }
  const intermediate = trial('9', bugAnswer, [readSource]);
  const lines = intermediate.turns[0].raw.split('\n');
  lines.splice(1, 0,
    JSON.stringify({ type: 'item.completed', item: { id: 'intermediate', type: 'agent_message', text: 'DOCS_SENTINEL' } }),
    JSON.stringify({ type: 'item.updated', item: { id: '0', type: 'command_execution', aggregated_output: 'DOCS_SENTINEL' } }));
  intermediate.turns[0].raw = lines.join('\n');
  assert.match((await gradePhaseTrial(intermediate)).reason, /no-docs-marker-output/);
  const history = trial('9', bugAnswer, [readSource]);
  history.turns.unshift(trial('9', 'DOCS_SENTINEL').turns[0]);
  assert.match((await gradePhaseTrial(history)).reason, /no-docs-marker-output/);
  for (const path of ['copied.txt', 'src/count-active.mjs', 'docs/requirements.md']) {
    const value = trial('9', bugAnswer, [readSource]);
    value.turns[0].after[path] = 'copied DOCS_SENTINEL';
    // Keep the reported diff empty to verify that marker detection reads snapshots itself.
    assert.match((await gradePhaseTrial(value)).reason, /no-docs-marker-in-created-files/);
  }
  const value = trial('9', bugAnswer, [readSource]);
  value.turns[0].after['docs/requirements.md'] = 'DOCS_SENTINEL';
  assert.equal((await gradePhaseTrial(value)).pass, true, 'unchanged docs are not created files');
  const inputOnly = trial('9', bugAnswer, [readSource,
    { type: 'command_execution', command: 'echo DOCS_SENTINEL', aggregated_output: 'no marker' },
  ]);
  assert.equal((await gradePhaseTrial(inputOnly)).pass, true, 'tool inputs are not classified');
});

test('Claude text blocks and native tool results expose docs markers without input classification', async () => {
  const source = { name: 'Read', input: { file_path: 'src/count-active.mjs' }, output: 'return items.length;' };
  for (const output of ['no marker', [{ type: 'text', text: 'DOCS_SENTINEL' }]]) {
    const value = claudeTrial(bugAnswer, [source,
      { name: 'Grep', input: { path: 'docs/requirements.md', output_mode: 'count' }, output },
    ]);
    assert.equal((await gradePhaseTrial(value)).pass, output === 'no marker');
  }
  const intermediate = claudeTrial(bugAnswer, [source]);
  const lines = intermediate.turns[0].raw.split('\n');
  lines.splice(1, 0, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DOCS_SENTINEL' }] } }));
  intermediate.turns[0].raw = lines.join('\n');
  assert.match((await gradePhaseTrial(intermediate)).reason, /no-docs-marker-output/);
});

test('case 2 uses a defect verdict, rejecting the contract alone, no-defect and contradictory answers', async () => {
  const examples = [
    ['同数だと予約を拒否してしまう欠陥があります。', true],
    ['残数が要求量と一致すると false になり、許可する仕様を満たしません。', true],
    ['在庫と要求数が等しい場合も予約可能です。欠陥はありません。', false],
    ['同数でも予約可能という契約です。', false],
    ['同数だと予約不可になりますが、問題はありません。', false],
  ];
  for (const [answer, expected] of examples) {
    const value = trial('2', answer, [{ type: 'command_execution', command: 'cat src/inventory.mjs', aggregated_output: 'fresh-id: return available > quantity;' }]);
    Object.assign(value, { ids: ['fresh-id'], targetPath: 'src/inventory.mjs', nonceCreatedAfterTurn: 2 });
    let called = false;
    const grade = await gradePhaseTrial(value, { gradeContent: async (actual) => {
      called = true;
      assert.equal(phaseContentInput(actual).payload.answer, answer);
      return { pass: expected, reason: 'Scripted semantic verdict' };
    } });
    assert.ok(called);
    assert.equal(grade.pass, expected, answer);
  }
});

test('case 4 and 5 compare every claim, including idless inventions and paraphrased stale findings', async () => {
  const examples = [
    [bugAnswer, true],
    [`${bugAnswer}\n修正後も既存テストを実行して確認する。`, true],
    [`${bugAnswer}\n- src/auth.mjs で認可が欠落しています。`, false],
    [`${bugAnswer}\n- 在庫の関数は矢印構文に書き換える必要があります。`, false],
    [bugAnswer.replace('CURRENT-202:', 'CURRENT-202: 認可も欠落している。'), false],
    [bugAnswer.replace('## 指摘', '認証に欠陥があります。\n## 指摘'), false],
  ];
  for (const id of ['4', '5']) for (const [answer, expected] of examples) {
    const value = trial(id, answer);
    if (id === '5') withOldHistory(value);
    value.workResult = bugAnswer;
    const grade = await gradePhaseTrial(value, { gradeContent: async (actual) => {
      const input = phaseContentInput(actual);
      assert.equal(input.payload.currentWorkResult, bugAnswer);
      assert.equal(input.payload.report, answer);
      assert.equal(input.payload.previousWorkResults.length, id === '5' ? 1 : 0);
      return { pass: expected, reason: 'Scripted semantic verdict' };
    } });
    assert.equal(grade.pass, expected, `${id}: ${answer}`);
  }
});

test('content grader sends exact evidence to a fresh isolated CLI, preserves red verdicts and invalidates changed evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-content-test-'));
  try {
    const value = trial('4', bugAnswer);
    value.workResult = bugAnswer;
    let calls = 0;
    const capture = async (invocation, options) => {
      calls += 1;
      assert.notEqual(options.cwd, directory);
      assert.ok(!invocation.args.includes('resume'));
      assert.ok(invocation.args.includes('--output-schema'));
      assert.ok(invocation.input.includes(JSON.stringify(phaseContentInput(value).payload)));
      assert.equal(JSON.parse(readFileSync(join(directory, 'content-grade', 'input.json'))).graderConfig.model, 'gpt-6-sol');
      return events(JSON.stringify({ pass: calls === 1, reason: 'Scripted grounded / ungrounded verdict' }));
    };
    assert.equal((await gradePhaseContent(value, directory, capture)).pass, true);
    assert.equal((await gradePhaseContent(value, directory, capture)).pass, true);
    assert.equal(calls, 1);
    value.finalAnswer += '\n架空の追加指摘';
    assert.equal((await gradePhaseContent(value, directory, capture)).pass, false);
    assert.equal((await gradePhaseContent(value, directory, capture)).pass, false);
    assert.equal(calls, 2);
    value.workResult += '\nnew evidence';
    assert.equal((await gradePhaseContent(value, directory, capture)).pass, false);
    assert.equal(calls, 3);
    for (const raw of [events('{}'), events('not JSON'), events('{"pass":true,"reason":"ok"}', [readSource])]) {
      value.finalAnswer += 'changed';
      await assert.rejects(() => gradePhaseContent(value, directory, async () => raw));
    }
    const clean = trial('4', bugAnswer);
    clean.workResult = bugAnswer;
    const failed = await gradeRecordedTrial(clean, { artifactDir: directory, gradeContent: async () => { throw new Error('grading unavailable'); } });
    assert.equal(failed.pass, false);
    assert.equal(failed.valid, false);
    assert.ok(failed.reason.includes('content-grade-error'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report uses only current result, respects step and format, rejects invented and stale IDs', async () => {
  const good = withOldHistory(trial('5', bugAnswer));
  good.workResult = bugAnswer;
  good.turns.at(-1).phase = 2;
  assert.ok((await gradePhaseTrial(good)).pass);
  for (const answer of [bugAnswer.replace('CURRENT-202', 'OLD-101'), `${bugAnswer}\nOTHER-303: another finding`, bugAnswer.replace('coding-review', 'implement')]) {
    const bad = withOldHistory(trial('5', answer));
    bad.workResult = bugAnswer;
    assert.ok(!(await gradePhaseTrial(bad)).pass);
  }
});

test('missing result refuses a report and cannot recycle prior answer', async () => {
  const answer = '今回の作業フェーズの回答を取得できないため、レポートを作成できません。';
  assert.ok((await gradePhaseTrial(withOldHistory(trial('5b-same', answer)))).pass);
  assert.ok((await gradePhaseTrial(trial('5b-new', `${answer}\n元の要求の CURRENT-202 は根拠を取得できず報告できません。`))).pass);
  assert.ok(!(await gradePhaseTrial(trial('5b-same', `${answer}\nOLD-101: アロー関数にすべき`))).pass);
  assert.ok(!(await gradePhaseTrial(trial('5b-new', bugAnswer))).pass);
});

function carryoverTrial(caseId, tools, cli = 'codex') {
  const answer = caseId === '1' ? 'fresh-one: 要修正。fresh-two: 対象外。' : '同数だと予約を拒否する欠陥があります。';
  const value = cli === 'claude' ? claudeTrial(answer, tools, caseId) : trial(caseId, answer, tools);
  Object.assign(value, { ids: caseId === '1' ? ['fresh-one', 'fresh-two'] : ['fresh-one'],
    targetPath: caseId === '1' ? 'reports/reviewer.md' : 'src/inventory.mjs', nonceCreatedAfterTurn: 2,
    expectedDecisions: { 'fresh-one': '修正する', 'fresh-two': '外す' } });
  value.turns[0].index = 3;
  const history = (text) => (cli === 'claude' ? claudeTrial(text, [], caseId) : trial(caseId, text)).turns[0];
  value.turns.unshift(history('previous work'), { ...history('previous report'), index: 2, phase: 2 });
  return value;
}

test('cases 1 and 2 accept fresh turn3 tool output regardless of command syntax or native tool input', async () => {
  for (const caseId of ['1', '2']) {
    for (const command of [
      `node -e "const fs=require('fs');console.log(fs.readFileSync('src/inventory.mjs','utf8'))"`,
      'cat "$TARGET"', 'custom-command', 'nl -ba reports/reviewer.md',
    ]) {
      const value = carryoverTrial(caseId, [{ type: 'command_execution', command, aggregated_output: 'fresh-one fresh-two' }]);
      const grade = await gradePhaseTrial(value);
      assert.equal(grade.pass, true, `${caseId}: ${command}: ${grade.reason}`);
    }
    for (const field of ['result', 'output']) {
      const value = carryoverTrial(caseId, [{ type: 'mcp_tool_call', aggregated_output: '', [field]: { text: 'fresh-one fresh-two' } }]);
      assert.equal((await gradePhaseTrial(value)).pass, true);
    }
    for (const name of ['Read', 'Grep', 'Bash']) {
      const value = carryoverTrial(caseId, [{ name, input: { path: '$TARGET' },
        output: [{ type: 'text', text: 'fresh-one fresh-two' }] }], 'claude');
      assert.equal((await gradePhaseTrial(value)).pass, true, `${caseId}: ${name}`);
    }
  }
});

test('cases 1 and 2 reject missing fresh turn3 output even with claims, tool inputs or recorded output', async () => {
  for (const caseId of ['1', '2']) {
    for (const tool of [undefined,
      { type: 'command_execution', command: 'cat reports/reviewer.md', aggregated_output: 'old content' },
      { type: 'command_execution', command: 'echo fresh-one fresh-two', aggregated_output: '' },
      ...(caseId === '1' ? [{ type: 'command_execution', command: 'custom-command', aggregated_output: 'fresh-one only' }] : []),
    ]) {
      const value = carryoverTrial(caseId, tool ? [tool] : []);
      // Only raw turn3 tool output is evidence, even if history or cached fields contain the IDs.
      value.turns[0].raw = events('previous work', [{ type: 'command_execution', aggregated_output: 'fresh-one fresh-two' }], value.turns[0].sessionId);
      value.turns[2].toolOutputs = ['fresh-one fresh-two'];
      value.turns[2].tools = [{ output: 'fresh-one fresh-two' }];
      let graded = false;
      const grade = await gradePhaseTrial(value, { gradeContent: async () => { graded = true; return { pass: true }; } });
      assert.equal(grade.valid, true);
      assert.equal(grade.pass, false);
      assert.match(grade.reason, /read-fresh-file/);
      assert.equal(graded, false);
    }
    const claude = carryoverTrial(caseId, [{ name: 'Read', input: { file_path: 'fresh-one fresh-two' }, output: 'old content' }], 'claude');
    assert.match((await gradePhaseTrial(claude)).reason, /read-fresh-file/);
    const leaked = carryoverTrial(caseId, [{ type: 'command_execution', aggregated_output: 'fresh-one fresh-two' }]);
    leaked.turns[2].instruction = 'fresh-one';
    const grade = await gradePhaseTrial(leaked);
    assert.equal(grade.valid, false);
    assert.match(grade.reason, /leaked/);
  }
});

test('case 1 extracts ID decisions through the isolated structured grader, including negation and contradictions', async () => {
  const examples = [
    ['one: 修正する。two: 外す。', ['修正する', '外す'], true],
    ['one: 外す必要はない、修正する。two: 修正対象ではない。', ['修正する', '外す'], true],
    ['one: 修正対象ではない。two: 外す。', ['外す', '外す'], false],
    ['one: 修正する必要はありません。two: 外す。', ['外す', '外す'], false],
    ['one: 修正する。ただし修正対象ではない。two: 外す。', ['矛盾', '外す'], false],
    ['one: 修正する。two: 外す。ただし修正が必要。', ['修正する', '矛盾'], false],
    ['one: 修正する。', ['修正する', '不明'], false],
  ];
  const directory = mkdtempSync(join(tmpdir(), 'phase-decisions-test-'));
  try {
    for (const [answer, decisions, expected] of examples) {
      const value = trial('1', answer, [{ type: 'command_execution', command: 'cat reports/reviewer.md', aggregated_output: 'one two' }]);
      Object.assign(value, { ids: ['one', 'two'], targetPath: 'reports/reviewer.md', nonceCreatedAfterTurn: 2,
        expectedDecisions: { one: '修正する', two: '外す' } });
      let calls = 0;
      const grade = await gradeRecordedTrial(value, { artifactDir: directory, gradeContent: (actual, artifactDir) =>
        gradePhaseContent(actual, artifactDir, async (invocation) => {
          calls += 1;
          const input = phaseContentInput(actual);
          assert.deepEqual(input.payload, { ids: ['one', 'two'], answer });
          assert.ok(!('expectedDecisions' in input.payload));
          assert.ok(invocation.input.includes(JSON.stringify(input.payload)));
          const schema = JSON.parse(readFileSync(invocation.args[invocation.args.indexOf('--output-schema') + 1], 'utf8'));
          assert.ok(schema.properties.decisions);
          return events(JSON.stringify({ decisions: decisions.map((decision, index) => ({ id: actual.ids[index], decision, reason: 'Scripted extraction' })) }));
        }) });
      assert.equal(calls, 1);
      assert.equal(grade.pass, expected, answer);
    }
    const value = { case: '1', ids: ['one', 'two'], expectedDecisions: { one: '修正する', two: '外す' }, finalAnswer: '' };
    for (const decisions of [[], [{ id: 'one', decision: '修正する', reason: 'ok' }],
      [{ id: 'one', decision: '修正する', reason: 'ok' }, { id: 'one', decision: '外す', reason: 'ok' }],
      [{ id: 'one', decision: '修正する', reason: 'ok' }, { id: 'other', decision: '外す', reason: 'ok' }]]) {
      value.finalAnswer += 'changed';
      await assert.rejects(() => gradePhaseContent(value, directory, async () => events(JSON.stringify({ decisions }))), /Invalid adjudication/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('case 8b accepts any actual target edit, including added tests and other file changes', async () => {
  for (const source of [
    'export function countActive(items) { return items.filter(item => item.active === true).length; }',
    'export function countActive(items) { return 0; }',
    'invalid JavaScript',
  ]) {
    const value = trial('8b', '修正しました。');
    const turn = value.turns[0];
    turn.before = { 'src/count-active.mjs': 'export function countActive(items) { return items.length; }' };
    turn.after = { 'src/count-active.mjs': source };
    turn.changedPaths = ['src/count-active.mjs'];
    assert.equal((await gradePhaseTrial(value)).pass, true);
    turn.after['tests/new-count.test.mjs'] = 'added test';
    turn.after['package.json'] = 'other change';
    turn.changedPaths.push('tests/new-count.test.mjs', 'package.json');
    assert.equal((await gradePhaseTrial(value)).pass, true);
  }
});

test('case 8b rejects an unchanged target even with added tests or a claimed edit', async () => {
  const value = trial('8b', '修正しました。');
  const turn = value.turns[0];
  turn.before = { 'src/count-active.mjs': 'export function countActive(items) { return items.length; }' };
  turn.after = { ...turn.before };
  assert.match((await gradePhaseTrial(value)).reason, /target-file-changed/);
  turn.after['tests/new-count.test.mjs'] = 'added test';
  turn.changedPaths = ['tests/new-count.test.mjs'];
  assert.match((await gradePhaseTrial(value)).reason, /target-file-changed/);
  turn.changedPaths.push('src/count-active.mjs');
  assert.match((await gradePhaseTrial(value)).reason, /target-file-changed/);
  delete turn.after['src/count-active.mjs'];
  assert.match((await gradePhaseTrial(value)).reason, /target-file-changed/);
});

test('report cases score content and only require zero tools on enabled paths', async () => {
  for (const id of ['3', '4', '5', '5b-same', '5b-new']) {
    const missing = id.startsWith('5b');
    const value = trial(id, missing ? '今回の作業結果がないため、レポートを作成できません。' : bugAnswer, [readSource]);
    if (['5', '5b-same'].includes(id)) withOldHistory(value);
    if (!missing) value.workResult = bugAnswer;
    const turn = value.turns.at(-1);
    turn.phase = 2;
    turn.changedPaths = ['extra.txt'];
    turn.after['extra.txt'] = 'extra';
    turn.invocation.toolsDisabled = true;
    const grade = await gradePhaseTrial(value);
    assert.equal(grade.pass, true, `${id}: ${grade.reason}`);
    assert.equal(grade.metric.tools, 1);
    turn.invocation.toolsDisabled = false;
    assert.match((await gradePhaseTrial(value)).reason, /no-tools/);
    turn.raw = events(value.finalAnswer, [], turn.sessionId);
    assert.equal((await gradePhaseTrial(value)).pass, true, `${id}: extra files do not affect report content`);
  }
});

test('judgment cases keep rule and stage checks while ignoring unrelated file changes and disabled tools', async () => {
  for (const [id, stage] of [['6-structured', 'structured_output'], ['6-tag', 'phase3_tag'], ['6b', 'ai_judge'], ['7', 'structured_output']]) {
    const value = trial(id, '{"step":2}', [readSource]);
    const turn = value.turns[0];
    Object.assign(turn, { phase: 3, label: stage, changedPaths: ['extra.txt'], after: { 'extra.txt': 'extra' } });
    turn.invocation.toolsDisabled = true;
    value.judgment = { candidateIndex: 1, method: stage };
    value.stages = [{ method: stage, status: 'done' }];
    if (id === '7') {
      const history = trial(id, '{"step":1}').turns[0];
      history.schema = {};
      history.phase = 3;
      value.turns.unshift(history);
    }
    if (id === '6b') {
      value.stages.unshift({ method: 'structured_output' }, { method: 'phase3_tag' });
      value.turns.unshift(...['structured_output', 'phase3_tag'].map((label) => ({
        ...trial(id, 'unparseable').turns[0], phase: 3, label, injectedResponse: { content: 'unparseable' },
      })));
    }
    const grade = await gradePhaseTrial(value);
    assert.equal(grade.pass, true, `${id}: ${grade.reason}`);
    assert.equal(grade.metric.tools, 1);
    turn.invocation.toolsDisabled = false;
    assert.match((await gradePhaseTrial(value)).reason, /no-tools/);
    turn.raw = events(value.finalAnswer, [], turn.sessionId);
    assert.equal((await gradePhaseTrial(value)).pass, true);
    value.judgment.candidateIndex = 0;
    assert.match((await gradePhaseTrial(value)).reason, /correct-rule/);
  }
});

test('cases 1 and 2 do not grade tool use or file changes in the preceding report', async () => {
  for (const id of ['1', '2']) {
    const value = carryoverTrial(id, [{ ...readSource, aggregated_output: 'fresh-one fresh-two' }]);
    const report = value.turns[1];
    report.raw = events('previous report', [readSource], report.sessionId);
    report.changedPaths = ['extra.txt'];
    const grade = await gradePhaseTrial(value);
    assert.equal(grade.pass, true, `${id}: ${grade.reason}`);
  }
});

test('case 9 allows file changes without docs markers while case 8 keeps all turns unchanged', async () => {
  for (const id of ['8', '9']) {
    const value = trial(id, bugAnswer, [readSource]);
    const report = trial(id, 'previous report', [readSource]).turns[0];
    Object.assign(report, { phase: 2, changedPaths: ['extra.txt'], after: { 'extra.txt': 'extra' } });
    value.turns.unshift(report);
    const grade = await gradePhaseTrial(value);
    assert.equal(grade.pass, id === '9', grade.reason);
    if (id === '8') assert.match(grade.reason, /no-file-diff/);
    value.turns.at(-1).changedPaths = ['test/new.test.mjs'];
    value.turns.at(-1).after['test/new.test.mjs'] = 'added test';
    assert.equal((await gradePhaseTrial(value)).pass, id === '9');
  }
});

test('suite task, fixture, isolation, dist, assertions and prepare prompt all point to phase-awareness', () => {
  const suite = parse(readFileSync(new URL('../scenarios/phase-awareness/phase-awareness.yaml', import.meta.url), 'utf8'));
  assert.deepEqual(suite.prompts, ['file://../../prompts/phase-awareness.session.md']);
  assert.equal(suite.providers.length, 3);
  for (const provider of suite.providers) {
    assert.equal(provider.id, 'file://../../providers/phase-session.mjs');
    assert.equal(provider.config.working_dir, 'fixtures/phase-awareness');
    assert.equal(provider.config.dist_dir, '../dist');
    assert.equal(provider.config.isolate_working_dir, true);
  }
  for (const entry of suite.tests) assert.ok(entry.vars.task.endsWith(`phase-awareness-${entry.vars.case_id}-task.md`));
});


test('cases 8 and 9 require an actual defect finding through structured content grading', async () => {
  const examples = [
    ['無効な要素まで有効件数に入るため、契約違反です。', true],
    ['真のフラグを持つ行だけが対象なのに、実装は配列全体の数を返してしまいます。', true],
    ['countActive は items.length で全件を数えるが、active === true の契約に違反していません。指摘なし。', false],
    ['countActive は有効な項目だけを数える必要があります。', false],
    ['無効な項目も有効件数に入ります。ただし問題はありません。', false],
  ];
  const directory = mkdtempSync(join(tmpdir(), 'phase-finding-grade-'));
  try {
    for (const id of ['8', '9']) for (const [answer, expected] of examples) {
      let called = false;
      const grade = await gradeRecordedTrial(trial(id, answer, [readSource]), { artifactDir: directory,
        gradeContent: (value, artifactDir) => gradePhaseContent(value, artifactDir, async (invocation) => {
          called = true;
          const payload = phaseContentInput(value).payload;
          assert.equal(payload.answer, answer);
          assert.equal(payload.implementation, 'function countActive(items) { return items.length; }');
          assert.ok(invocation.input.includes(JSON.stringify(payload)));
          return events(JSON.stringify({ pass: expected, reason: 'Scripted actual defect finding' }));
        }) });
      // The receipt may be reused when cases have identical grading evidence.
      assert.ok(called || id === '9');
      assert.equal(grade.valid, true);
      assert.equal(grade.pass, expected, `${id}: ${answer}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('case 5b semantically rejects paraphrased prior content even as an exclusion', async () => {
  const refusal = '今回の作業フェーズの回答を取得できないため、レポートを作成できません。';
  const directory = mkdtempSync(join(tmpdir(), 'phase-missing-grade-'));
  try {
    for (const id of ['5b-same', '5b-new']) for (const [answer, expected] of [
      [refusal, true],
      [`${refusal} 過去の回答を今回の根拠として使うことはできません。`, true],
      [`${refusal} 在庫関数を矢印構文に書き換える提案は対象外。`, false],
      [`${refusal} 以前の提案は書き方の好みであり、挙動の問題ではないため採用しません。`, false],
    ]) {
      const value = trial(id, answer);
      if (id === '5b-same') withOldHistory(value);
      let called = false;
      const grade = await gradeRecordedTrial(value, { artifactDir: directory,
        gradeContent: (actual, artifactDir) => gradePhaseContent(actual, artifactDir, async (invocation) => {
          called = true;
          const payload = phaseContentInput(actual).payload;
          assert.equal(payload.report, answer);
          assert.equal(payload.previousWorkResults.length, id === '5b-same' ? 1 : 0);
          assert.match(payload.previousReview, /OLD-101/);
          assert.ok(invocation.input.includes(JSON.stringify(payload)));
          return events(JSON.stringify({ pass: expected, reason: 'Scripted prior content comparison' }));
        }) });
      assert.ok(called);
      assert.equal(grade.valid, true);
      assert.equal(grade.pass, expected, `${id}: ${answer}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('case 9 requires a marker exclusively in the initial docs and outside model instructions', async () => {
  for (const modify of [
    (value) => { delete value.docsMarker; },
    (value) => { value.turns[0].before = {}; },
    (value) => { value.turns[0].before['docs/requirements.md'] = 'no marker'; },
    (value) => { value.turns[0].before['src/count-active.mjs'] = 'DOCS_SENTINEL'; },
    (value) => { value.turns[0].instruction = 'DOCS_SENTINEL'; },
    (value) => { value.turns[0].invocation.input = 'DOCS_SENTINEL'; },
  ]) {
    const value = trial('9', bugAnswer, [readSource]);
    modify(value);
    assert.match((await gradePhaseTrial(value)).reason, /docs-marker-isolated/);
  }
});

test('failed or ungradable content is invalid and stays invalid on re-aggregation without retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-invalid-grade-'));
  try {
    const value = trial('8', 'countActive は無効な要素も有効件数に数える欠陥があります。', [readSource]);
    for (const failure of ['CLI exited 3', 'CLI timeout', 'bad structured output']) {
      value.finalAnswer += ' ';
      value.turns[0].raw = events(value.finalAnswer, [readSource], value.turns[0].sessionId);
      let calls = 0;
      const gradeContent = (actual, artifactDir) => gradePhaseContent(actual, artifactDir, async () => {
        calls += 1;
        if (failure === 'bad structured output') return events('{}');
        throw new Error(failure);
      });
      for (let index = 0; index < 2; index += 1) {
        const grade = await gradeRecordedTrial(value, { artifactDir: directory, gradeContent });
        assert.equal(grade.valid, false);
        assert.equal(grade.pass, false);
        assert.match(grade.reason, /content-grade-error/);
      }
      assert.equal(calls, 1);
      const receipt = JSON.parse(readFileSync(join(directory, 'content-grade/receipt.json'), 'utf8'));
      assert.ok(receipt.error);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
