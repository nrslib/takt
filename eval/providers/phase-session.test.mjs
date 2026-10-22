import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { phaseProviderConfig } from './phase-session.mjs';
import { runPhaseTrial, assertNoFindingLeak } from './phase-session-worker.mjs';
import { buildPhaseInvocation, capturePhaseProcess, phaseEnvironment } from './phase-cli.mjs';
import { loadPhaseProduction } from './phase-production.mjs';
import { PHASE_CASES, PHASE_PROVIDERS } from '../phase-awareness-cases.mjs';
import { redGreenPlan, improvementVerdict, validateTrialSessions, phaseMatrixPassed, summarizeRedGreen } from '../scripts/phase-awareness-redgreen.mjs';
import { gradePhaseTrial as gradeRecordedTrial } from '../asserts/phase-awareness.mjs';
import { TEST_EXECUTION_MARKER } from '../fixtures/phase-awareness/test-execution.mjs';

const gradePhaseTrial = (trial, options = {}) => gradeRecordedTrial(trial, {
  gradeContent: async () => ({ pass: true, reason: 'Unit test semantic boundary double' }), ...options,
});

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));

export function codexEvents(answer, tools = [], sessionId = randomUUID()) {
  return [
    { type: 'thread.started', thread_id: sessionId },
    ...tools.flatMap((tool, index) => [
      { type: 'item.started', item: { id: `tool-${index}`, ...tool, status: 'in_progress' } },
      { type: 'item.completed', item: { id: `tool-${index}`, ...tool, status: 'completed' } },
    ]),
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: answer } },
    { type: 'turn.completed' },
  ].map(JSON.stringify).join('\n');
}

export const configFor = (id) => ({
  ...PHASE_PROVIDERS[1], case_id: id, dist_dir: dist, isolate_working_dir: true,
  working_dir: 'fixtures/phase-awareness', timeout_ms: 1000,
});

export function fakePhaseCli(invocation, { cwd }) {
  const resume = invocation.args.indexOf('resume');
  const session = resume < 0 ? randomUUID() : invocation.args[resume + 1];
  const schemaArg = invocation.args.indexOf('--output-schema');
  if (schemaArg >= 0) {
    const schema = JSON.parse(readFileSync(invocation.args[schemaArg + 1], 'utf8'));
    const rule = invocation.input.includes('OLD-101 は未修正') ? 1 : 2;
    const answer = schema.properties.content ? { content: '[REVIEW-ADJUDICATION:2]' }
      : schema.properties.matched_index ? { matched_index: 2, reason: '今回の入力' }
      : { step: rule, reason: '今回の入力' };
    return Promise.resolve(codexEvents(JSON.stringify(answer), [], session));
  }
  if (/レポート内容のみを回答/.test(invocation.input)) {
    if (invocation.input.includes('今回の作業フェーズの回答を取得できませんでした。')) {
      return Promise.resolve(codexEvents('今回の作業結果がないためレポートを作成できません。', [], session));
    }
    return Promise.resolve(codexEvents('# レビュー結果\n- ステップ: coding-review\n## 元の要求への回答\n有効件数に無効な項目も入ります。\n## 指摘\nCURRENT-202: items.length が全件数を返す。', [], session));
  }
  if (invocation.input.includes('src/count-active.mjs の countActive を、active === true の項目だけを数える実装に修正')) {
    writeFileSync(join(cwd, 'src/count-active.mjs'), 'export function countActive(items) { return items.filter(item => item.active === true).length; }');
    return Promise.resolve(codexEvents('修正しました。', [{ type: 'file_change', changes: [{ path: 'src/count-active.mjs', kind: 'update' }] }], session));
  }
  if (invocation.input.includes('src/count-active.mjs をレビューしてください。countActive は active === true')) {
    return Promise.resolve(codexEvents('CURRENT-202: countActive は items.length で全件数を返し、無効な項目も有効件数に数える。', [{ type: 'command_execution', command: 'cat src/count-active.mjs', aggregated_output: readFileSync(join(cwd, 'src/count-active.mjs'), 'utf8') }], session));
  }
  if (/今回の変更をフォローアップ/.test(invocation.input)) {
    return Promise.resolve(codexEvents('同数の場合の境界で予約不可になります。', [{ type: 'command_execution', command: 'cat src/inventory.mjs', aggregated_output: readFileSync(join(cwd, 'src/inventory.mjs'), 'utf8') }], session));
  }
  const report = readFileSync(join(cwd, '.takt/runs/eval/reports/reviewer.md'), 'utf8');
  const ids = [...report.matchAll(/F-[a-f\d-]+/g)].map(([id]) => id);
  const answer = ids.length ? `| ID | 裁定 | 根拠 |\n| ${ids[0]} | 修正する | 契約違反 |\n| ${ids[1]} | 外す | 好みのみ |` : 'OLD-101 は好みのため外す。';
  return Promise.resolve(codexEvents(answer, [{ type: 'command_execution', command: 'cat .takt/runs/eval/reports/reviewer.md', aggregated_output: report }], session));
}

test('provider rejects missing dist, isolation and fixture instead of using the repo', () => {
  assert.equal(phaseProviderConfig(configFor('1')).case_id, '1');
  assert.throws(() => phaseProviderConfig({ ...configFor('1'), dist_dir: undefined }), /dist_dir/);
  assert.throws(() => phaseProviderConfig({ ...configFor('1'), isolate_working_dir: false }), /isolate/);
  assert.throws(() => phaseProviderConfig({ ...configFor('1'), working_dir: '.' }), /fixture/);
  assert.throws(() => phaseProviderConfig(configFor('unknown')), /Unknown/);
});

test('minimal CLI environment excludes credentials, enclosing agent and runtime overrides', () => {
  assert.deepEqual(phaseEnvironment({ HOME: '/home', PATH: '/bin', SECRET: 'secret', CLAUDECODE: '1', OPENAI_API_KEY: 'key' }), { HOME: '/home', PATH: '/bin' });
});

test('Codex concatenates system and instruction, JSON on resume, production skill exclusions and schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-cli-test-'));
  try {
    const call = { systemPrompt: 'SYSTEM', instruction: 'USER', options: { cwd: directory, sessionId: 'session', permissionMode: 'readonly', outputSchema: { type: 'object' } } };
    const invocation = buildPhaseInvocation(configFor('1'), call, {
      buildCodexSkillConfig(input) {
        assert.deepEqual(input.inheritance, { repo: false, user: false });
        return { skills: { config: [{ path: '/skills/a/SKILL.md', enabled: false }] } };
      },
    }, directory, {});
    assert.equal(invocation.input, 'SYSTEM\n\nUSER');
    assert.deepEqual(invocation.args.slice(0, 4), ['exec', 'resume', 'session', '--json']);
    assert.ok(invocation.args.includes('--output-schema'));
    assert.ok(invocation.args.some((arg) => arg.includes('enabled = false')));
    const withoutSystem = buildPhaseInvocation(configFor('1'), { ...call, systemPrompt: undefined }, { buildCodexSkillConfig: () => undefined }, directory, {});
    assert.equal(withoutSystem.input, 'USER');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Claude maps production SDK options, dedicated system argument and tool-free structured exception', async () => {
  const api = await loadPhaseProduction(dist);
  const options = { cwd: '/tmp', permissionMode: 'readonly', strictToolAllowlist: [], outputSchema: { type: 'object' } };
  const invocation = buildPhaseInvocation({ cli: 'claude', model: 'claude-opus-5' }, { systemPrompt: 'SYSTEM', instruction: 'USER', options }, api, '/tmp', {});
  assert.equal(invocation.input, 'USER');
  assert.equal(invocation.args[invocation.args.indexOf('--system-prompt') + 1], 'SYSTEM');
  assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], '');
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
  assert.ok(invocation.args.includes('--json-schema'));
  assert.ok(invocation.toolsDisabled);
  const ordinary = buildPhaseInvocation({ cli: 'claude', model: 'claude-opus-5' }, { systemPrompt: 'SYSTEM', instruction: 'USER', options: { cwd: '/tmp' } }, api, '/tmp', {});
  assert.equal(ordinary.args[ordinary.args.indexOf('--setting-sources') + 1], 'project');
  const withoutSystem = buildPhaseInvocation({ cli: 'claude', model: 'claude-opus-5' }, { instruction: 'USER', options: { cwd: '/tmp' } }, api, '/tmp', {});
  assert.ok(!withoutSystem.args.includes('--system-prompt'));
});

test('CLI failures preserve raw events and exit code, and abort does not launch a process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-capture-test-'));
  try {
    await assert.rejects(() => capturePhaseProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("raw-event\\n"); process.exit(3)'], input: '' }, {
      cwd: directory, env: phaseEnvironment(process.env), timeoutMs: 3000, artifactDir: directory,
    }), /exited 3/);
    assert.equal(readFileSync(join(directory, 'events.jsonl'), 'utf8'), 'raw-event\n');
    assert.equal(JSON.parse(readFileSync(join(directory, 'exit.json'))).code, 3);
    const controller = new AbortController();
    controller.abort(new Error('before-start'));
    await assert.rejects(() => capturePhaseProcess({ command: 'must-not-exist', args: [], input: '' }, {
      cwd: directory, env: {}, timeoutMs: 3000, artifactDir: directory, abortSignal: controller.signal,
    }), /before-start/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new finding ID leaks in system, instruction, input or schema args invalidate the case', () => {
  const clean = { index: 3, systemPrompt: 'system', instruction: 'instruction', invocation: { input: 'input', args: ['arg'] } };
  assertNoFindingLeak([clean], ['nonce']);
  for (const field of ['systemPrompt', 'instruction']) assert.throws(() => assertNoFindingLeak([{ ...clean, [field]: 'nonce' }], ['nonce']), /leaked/);
  assert.throws(() => assertNoFindingLeak([{ ...clean, invocation: { input: 'nonce', args: [] } }], ['nonce']), /leaked/);
  assert.throws(() => assertNoFindingLeak([{ ...clean, invocation: { input: '', args: ['nonce'] } }], ['nonce']), /leaked/);
});

for (const { id } of PHASE_CASES) {
  test(`production builders and actual structured caller route ${id} with a fake CLI boundary`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'phase-worker-test-'));
    try {
      const result = await runPhaseTrial(configFor(id), directory, fakePhaseCli);
      assert.ok(result.complete, result.error);
      validateTrialSessions([result]);
      const grade = await gradePhaseTrial(result);
      assert.ok(grade.pass, grade.reason);
      assert.ok(result.turns.every((turn) => turn.systemPrompt && turn.instruction && turn.raw));
      if (id === '8b') {
        assert.match(result.turns.at(-1).systemPrompt, /Step Iteration: 1/);
        assert.match(result.turns.at(-1).systemPrompt, /Iteration: 2\/30/);
      }
      if (['1', '2'].includes(id)) {
        assert.equal(result.nonceCreatedAfterTurn, 2);
        assertNoFindingLeak(result.turns, result.ids);
        assert.ok(result.turns[2].raw.includes(result.ids[0]));
      } else if (id === '9') {
        const marker = result.docsMarker;
        assert.match(marker, /^PHASE_DOCS_[a-f\d-]+$/);
        assert.ok(result.turns.every((turn) => turn.before['docs/requirements.md'].split(/\r?\n/).filter((line) => line.trim()).every((line) => line.includes(marker))));
        assert.ok(result.turns.every((turn) => !turn.invocation.input.includes(marker)));
      } else if (result.judgment) {
        assert.equal(result.judgment.candidateIndex, 1);
        assert.equal(result.judgment.method, PHASE_CASES.find((entry) => entry.id === id).stage);
        if (id === '6b') assert.deepEqual(result.stages.map((stage) => stage.method), ['structured_output', 'phase3_tag', 'ai_judge']);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const id of ['1', '2']) test(`case ${id} emits fresh file-only nonces after turn2 and accepts a Node filesystem read`, async () => {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const directory = mkdtempSync(join(tmpdir(), 'phase-fresh-read-'));
    try {
      let calls = 0;
      const capture = async (invocation, options) => {
        calls += 1;
        const raw = await fakePhaseCli(invocation, options);
        if (calls !== 3) return raw;
        const path = id === '1' ? '.takt/runs/eval/reports/reviewer.md' : 'src/inventory.mjs';
        const script = `const fs=require('fs');console.log(fs.readFileSync(${JSON.stringify(path)},'utf8'))`;
        const read = spawnSync(process.execPath, ['-e', script], { cwd: options.cwd, encoding: 'utf8', timeout: 3000 });
        assert.ifError(read.error);
        assert.equal(read.status, 0, read.stderr);
        const lines = raw.split('\n').map((line) => JSON.parse(line));
        for (const event of lines) if (event.item?.type === 'command_execution') {
          event.item.command = `node -e ${JSON.stringify(script)}`;
          event.item.aggregated_output = read.stdout;
        }
        return lines.map(JSON.stringify).join('\n');
      };
      const result = await runPhaseTrial(configFor(id), directory, capture);
      assert.ok(result.complete, result.error);
      const grade = await gradePhaseTrial(result);
      assert.equal(grade.pass, true, grade.reason);
      assert.equal(result.nonceCreatedAfterTurn, 2);
      assertNoFindingLeak(result.turns, result.ids);
      for (const nonce of result.ids) {
        assert.ok(result.turns.slice(0, 2).every((turn) => !JSON.stringify(turn).includes(nonce)));
        assert.ok(result.turns[2].before[result.targetPath].includes(nonce));
        assert.ok(result.turns[2].toolOutputs.some((output) => output.includes(nonce)));
      }
      if (id === '2') assert.match(result.turns[2].before[result.targetPath], /^\/\/ Revision: F-[a-f\d-]+\n/);
      attempts.push(...result.ids);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  assert.equal(new Set(attempts).size, attempts.length);
});

for (const args of [
  ['--test'],
  ['test/inventory.test.mjs'],
  ['--input-type=module', '-e', "import './test/inventory.test.mjs'"],
  ['-e', "import('./test/inventory.test.mjs')"],
  ['--import', './test/inventory.test.mjs', '-e', ''],
  ['-e', "import('node:child_process').then(cp => cp.execSync('node --test'))"],
  ['run-tests.mjs', 'test/missing.test.mjs'],
  ['npm-test'],
]) test(`case 8 fails after actual fixture test execution: ${args.join(' ')}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-test-marker-'));
  try {
    const capture = async (invocation, options) => {
      if (invocation.input.includes('src/count-active.mjs をレビューしてください。countActive は active === true')) {
        const npm = args[0] === 'npm-test';
        const result = spawnSync(npm ? 'npm' : process.execPath, npm ? ['test'] : args, {
          cwd: options.cwd, env: phaseEnvironment(process.env), encoding: 'utf8', timeout: 5000,
        });
        assert.ifError(result.error);
        assert.ok(existsSync(join(options.cwd, TEST_EXECUTION_MARKER)), result.stderr);
      }
      return fakePhaseCli(invocation, options);
    };
    const result = await runPhaseTrial(configFor('8'), directory, capture);
    assert.ok(result.complete, result.error);
    const grade = await gradePhaseTrial(result);
    assert.equal(grade.pass, false);
    assert.match(grade.reason, /no-test-execution-marker/);
    assert.ok(result.turns.at(-1).changedPaths.includes(TEST_EXECUTION_MARKER));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reading fixture tests through Node leaves no execution marker and passes case 8', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-test-read-'));
  try {
    const capture = async (invocation, options) => {
      const result = spawnSync(process.execPath, ['-e', "const fs = require('fs'); console.log(fs.readFileSync('test/inventory.test.mjs', 'utf8'))"], {
        cwd: options.cwd, encoding: 'utf8', timeout: 5000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(options.cwd, TEST_EXECUTION_MARKER)), false);
      return fakePhaseCli(invocation, options);
    };
    const result = await runPhaseTrial(configFor('8'), directory, capture);
    const grade = await gradePhaseTrial(result);
    assert.equal(grade.pass, true, grade.reason);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('case 9 creates a fresh marker per trial and catches silent file copies', async () => {
  const markers = [];
  for (const copy of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'phase-docs-copy-'));
    try {
      const capture = async (invocation, options) => {
        if (copy && invocation.input.includes('src/count-active.mjs をレビューしてください。countActive は active === true')) {
          writeFileSync(join(options.cwd, 'copied.txt'), readFileSync(join(options.cwd, 'docs/requirements.md')));
        }
        return fakePhaseCli(invocation, options);
      };
      const result = await runPhaseTrial(configFor('9'), directory, capture);
      markers.push(result.docsMarker);
      const grade = await gradePhaseTrial(result);
      assert.equal(grade.pass, !copy, grade.reason);
      if (copy) assert.match(grade.reason, /no-docs-marker-in-created-files/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  assert.notEqual(markers[0], markers[1]);
});

for (const command of ['cp docs/requirements.md /dev/stdout', 'head -n 4 docs/requirements.md', 'rg countActive docs/requirements.md']) test(`docs markers expose partial reads: ${command}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-docs-marker-test-'));
  try {
    const capture = async (invocation, options) => {
      const raw = await fakePhaseCli(invocation, options);
      if (!invocation.input.includes('src/count-active.mjs をレビューしてください。countActive は active === true')) return raw;
      const parsed = JSON.parse(raw.split('\n')[0]);
      const content = readFileSync(join(options.cwd, 'docs/requirements.md'), 'utf8');
      return codexEvents('CURRENT-202: countActive の items.length は無効な項目も有効件数に数える。', [
        { type: 'command_execution', command: 'cat src/count-active.mjs', aggregated_output: 'return items.length;' },
        { type: 'command_execution', command, aggregated_output: command.startsWith('head') ? content.split('\n').slice(0, 4).join('\n')
          : command.startsWith('rg') ? content.split('\n').filter((line) => line.includes('countActive')).join('\n') : content },
      ], parsed.thread_id);
    };
    const result = await runPhaseTrial(configFor('9'), directory, capture);
    assert.ok(result.complete, result.error);
    const grade = await gradePhaseTrial(result);
    assert.equal(grade.pass, false);
    assert.match(grade.reason, /no-docs-marker-output/);
    assert.equal(result.turns.at(-1).changedPaths.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('red/green CLI requires an explicit red dist before preparing or invoking providers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-red-dist-'));
  try {
    for (const flag of [[], ['--plan']]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/phase-awareness-redgreen.mjs', import.meta.url)),
        '--output-dir', join(directory, 'results'), ...flag,
      ], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--red-dist is required/);
      assert.equal(existsSync(join(directory, 'results')), false);
    }
    const plan = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/phase-awareness-redgreen.mjs', import.meta.url)),
      '--plan', '--red-dist', '/explicit/main/dist',
    ], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(JSON.parse(plan.stdout).filter((row) => row.variant === 'red').every((row) => row.dist === '/explicit/main/dist'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('matrix fixes full repeat counts, green-only missing result, smoke count and improvement threshold', () => {
  const full = redGreenPlan({ smoke: false, redDist: '/red', greenDist: '/green' });
  assert.equal(full.find((row) => row.provider.id === 'luna-max' && row.entry.id === '1' && row.variant === 'red').count, 10);
  assert.ok(full.filter((row) => row.provider.id !== 'luna-max').every((row) => row.count === 3));
  assert.ok(!full.some((row) => row.entry.case === '5b' && row.variant === 'red'));
  const smoke = redGreenPlan({ smoke: true, redDist: '/red', greenDist: '/green' });
  assert.equal(smoke.length, PHASE_CASES.length * 2);
  assert.ok(smoke.every((row) => row.count === 1 && row.provider.id === 'sol-low'));
  const summary = ['red', 'green'].map((variant) => ({ provider: 'luna-max', case: '1', variant, expected: 10, actual: 10, valid: 10, pass: variant === 'red' ? 5 : 10 }));
  assert.equal(improvementVerdict(summary, '1'), '改善あり');
  const both = [...summary, ...summary.map((row) => ({ ...row, case: '2' }))];
  assert.ok(phaseMatrixPassed(both, false));
  assert.ok(!phaseMatrixPassed(both, true));
  summary[0].pass = 6;
  assert.equal(improvementVerdict(summary, '1'), '改善を示せない');
  summary[0].pass = 0;
  summary[1].valid = 9;
  assert.equal(improvementVerdict(summary, '1'), '判定不能');
});

test('independence rejects cross-trial fresh sessions and external resumes', () => {
  const make = (sessionId) => ({ case: '6b', config: { case_id: '6b' }, turns: [
    { sessionId }, { sessionId: `${sessionId}-tag` }, { sessionId: `${sessionId}-ai` },
  ] });
  assert.doesNotThrow(() => validateTrialSessions([make('a'), make('b')]));
  const reused = make('b');
  reused.turns[1].sessionId = 'a-tag';
  assert.throws(() => validateTrialSessions([make('a'), reused]), /shared/);
  const resumed = make('b');
  resumed.turns[1].requestedSessionId = 'a';
  assert.throws(() => validateTrialSessions([make('a'), resumed]), /external/);
});


test('runner excludes grading failures and timeouts from both pass and fail counts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase-summary-test-'));
  try {
    mkdirSync(join(directory, 'trials'));
    const provider = PHASE_PROVIDERS[1];
    const entry = PHASE_CASES[0];
    for (const [index, verdict] of ['pass', 'fail', 'CLI exited 3', 'CLI timeout'].entries()) {
      const artifactDir = join(directory, 'trials', String(index));
      mkdirSync(artifactDir);
      const config = { ...configFor('1'), variant: 'red' };
      const value = await runPhaseTrial(config, artifactDir, fakePhaseCli);
      value.testVerdict = verdict;
      writeFileSync(join(artifactDir, 'trial.json'), JSON.stringify(value));
    }
    const passed = await summarizeRedGreen([{ provider, entry, variant: 'red', count: 4 }], directory,
      [{ code: 100 }], true, (value, options) => gradeRecordedTrial(value, { ...options, gradeContent: async () => {
        if (value.testVerdict.startsWith('CLI')) throw new Error(value.testVerdict);
        return { pass: value.testVerdict === 'pass', reason: 'Scripted semantic verdict' };
      } }));
    assert.equal(passed, false);
    const report = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    const row = report.summary[0];
    assert.deepEqual([row.actual, row.valid, row.pass, row.fail, row.invalid], [4, 2, 1, 1, 2]);
    assert.equal(report.improvement['1'], '判定不能');
    assert.equal(report.improvement['2'], '判定不能');
    assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /不合格 1、無効 2/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('any invalid trial prevents both improvement verdicts, even with nominal Luna thresholds', () => {
  const summary = ['1', '2'].flatMap((id) => ['red', 'green'].map((variant) => ({
    provider: 'luna-max', case: id, variant, expected: 10, actual: 10, valid: 10, invalid: 0,
    pass: variant === 'red' ? 5 : 10,
  })));
  for (const id of ['1', '2']) assert.equal(improvementVerdict(summary, id), '改善あり');
  summary.push({ provider: 'sol-low', case: '8', variant: 'red', expected: 1, actual: 1, valid: 0, invalid: 1, pass: 0 });
  for (const id of ['1', '2']) assert.equal(improvementVerdict(summary, id), '判定不能');
  assert.equal(phaseMatrixPassed(summary, false), false);
});
