import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import grade, { readFinalResult } from './merge-ci-recovery.mjs';
import { MERGE_CI_TARGETS, prepareMergeCiRecovery } from '../scripts/prepare-merge-ci-recovery.mjs';
import { assertRequiredSnapshots, createIsolatedWorkingDirectory, mergeCliReviewConfig } from '../providers/cli-review.mjs';
import { PROMPT_EVAL_SUITES } from '../suite-registry.mjs';
import { mergeCiResultPaths, normalizeMergeCiResults } from '../scripts/merge-ci-public-results.mjs';

test('investigation reads verdict and validates the production schema', () => {
  assert.equal(readFinalResult('{"verdict":"external","summary":"Runner provisioning failed before tests started"}', 'investigation'), 'external');
  assert.equal(grade('{"verdict":"insufficient_evidence","summary":"HTTP 403; external cause is not established"}',
    { vars: { kind: 'investigation', case: 'runner' } }).pass, false);
  assert.throws(() => readFinalResult('{"verdict":"external"}', 'investigation'));
});

test('review reads the final result instead of APPROVE in the explanation', () => {
  assert.equal(readFinalResult('{"result":"APPROVE"}', 'review'), 'APPROVE');
  assert.equal(grade('APPROVEできない\n```json\n{"result":"REJECT"}\n```',
    { vars: { kind: 'review', case: 'product-fix' } }).pass, false);
  assert.throws(() => readFinalResult('APPROVE', 'review'));
  assert.throws(() => readFinalResult('```json\n{"result":"APPROVE"}\n```\nactually REJECT', 'review'));
  assert.throws(() => readFinalResult('{"result":"APPROVE","verdict":"external"}', 'review'));
});

test('each evaluation selects its own prepared inputs through promptfoo test options', () => {
  for (const suite of MERGE_CI_TARGETS) {
    const config = parse(readFileSync(new URL(`../agents/merge-ci-recovery/${suite}.yaml`, import.meta.url), 'utf8'));
    assert.equal(resolve(config.outputPath), mergeCiResultPaths(suite, process.cwd()).raw);
    for (const entry of config.tests) {
      const prompt = config.prompts.find(({ label }) => entry.prompts.includes(label));
      const effective = mergeCliReviewConfig(config.providers[0].config, {
        prompt: { config: { ...config.defaultTest.options, ...entry.options } },
      });
      assert.equal(effective.working_dir, prompt.config.working_dir);
      assert.deepEqual(effective.required_snapshots, prompt.config.required_snapshots);
    }
  }
});

function resultFixture(repoRoot, suite = 'merge-ci-review') {
  const source = `${repoRoot}/eval/.work/merge-ci-recovery/${suite}-ja-product-fix`;
  const working = '/tmp/takt-prompt-eval-fixture-ABC123/project';
  return { evalId: 'eval-existing', results: { stats: { successes: 1, failures: 0 }, results: [{
    id: 'case-existing', testCase: { vars: { kind: 'review', case: 'product-fix' } },
    prompt: { raw: `Read ${source}/product.mjs` },
    response: { output: `Read ${working}/product.mjs:2; source_directoryを確認した。product.mjs:2のnull参照が原因である`,
      metadata: { fixture: { prompt_label: 'ja-product-fix', source_directory: source,
        working_directory: working, sha256: { 'product.mjs': 'unchanged' } } } },
    gradingResult: { pass: true, score: 1, componentResults: [{ prompt: `Grade ${working} and ${source}`, score: 1 }] },
  }] } };
}

function runnerResultFixture(repoRoot, suite, repeat, pattern) {
  const config = parse(readFileSync(new URL(`../agents/merge-ci-recovery/${suite}.yaml`, import.meta.url), 'utf8'));
  const value = resultFixture(repoRoot, suite);
  const row = value.results.results[0];
  value.config = config;
  value.runtimeOptions = { repeat };
  value.results.results = config.tests.filter(({ description }) => !pattern || pattern.test(description))
    .flatMap((entry) => Array.from({ length: repeat }, (_, index) => ({
      ...structuredClone(row), id: `${entry.description}-${index}`, success: true,
      testCase: entry, prompt: { ...row.prompt, label: entry.prompts[0] },
    })));
  value.results.stats = { successes: value.results.results.length, failures: 0 };
  return value;
}

function preparationErrors(context, suite, repoRoot) {
  const config = parse(readFileSync(new URL(`../agents/merge-ci-recovery/${suite}.yaml`, import.meta.url), 'utf8'));
  const required = config.tests[0].options.required_snapshots;
  mkdirSync(join(repoRoot, 'eval/.results'), { recursive: true });
  const source = mkdtempSync(join(repoRoot, 'eval/.results/merge-ci-preparation-'));
  context.after(() => rmSync(source, { recursive: true, force: true }));
  for (const snapshot of required) {
    mkdirSync(dirname(join(source, snapshot)), { recursive: true });
    writeFileSync(join(source, snapshot), '{}');
  }
  const diagnostics = {};
  for (const state of ['present', 'missing', 'directory', 'copy-failure', 'realpath-failure']) {
    let destination;
    let isolated;
    try {
      isolated = createIsolatedWorkingDirectory(source, (from, to, options) => {
        destination = to;
        if (state === 'copy-failure') writeFileSync(to, 'blocked');
        if (state === 'realpath-failure') return;
        cpSync(from, to, options);
        if (state === 'missing' || state === 'directory') rmSync(join(to, required[0]));
        if (state === 'directory') mkdirSync(join(to, required[0]));
      });
      assertRequiredSnapshots(isolated.cwd, required);
      assert.equal(state, 'present');
    } catch (error) {
      if (state === 'present') throw error;
      const working = isolated?.cwd ?? destination;
      assert.ok(error.message.includes(working));
      const canonicalWorking = working.replace(tmpdir(), realpathSync(tmpdir()));
      const reportedWorking = error.message.includes(canonicalWorking) ? canonicalWorking : working;
      diagnostics[state] = { error: error.message,
        expected: error.message.replaceAll(reportedWorking, './project').replaceAll(repoRoot, '.') };
    } finally {
      isolated?.cleanup();
    }
  }
  assert.deepEqual(Object.keys(diagnostics), ['missing', 'directory', 'copy-failure', 'realpath-failure']);
  return diagnostics;
}

function preparationFailureFixture(repoRoot, suite, error) {
  const value = resultFixture(repoRoot, suite);
  value.results.stats = { successes: 0, failures: 1, errors: 1 };
  const row = value.results.results[0];
  row.testCase.vars = suite === 'merge-ci-investigation'
    ? { kind: 'investigation', case: 'clock' } : { kind: 'review', case: 'product-fix' };
  row.response = { error };
  row.gradingResult = { pass: false, score: 0, reason: 'Provider preparation failed' };
  return value;
}

test('SCN-1-P1 normalizes real preparation errors without metadata and preserves failed results', (context) => {
  for (const suite of MERGE_CI_TARGETS) {
    for (const { error, expected } of Object.values(preparationErrors(context, suite, process.cwd()))) {
      const raw = preparationFailureFixture(process.cwd(), suite, error);
      const before = structuredClone(raw);
      const published = normalizeMergeCiResults(raw, process.cwd());
      assert.deepEqual(published.results.results[0].response, { error: expected });
      assert.deepEqual(published.results.results[0].gradingResult, before.results.results[0].gradingResult);
      assert.deepEqual(published.results.results[0].testCase, before.results.results[0].testCase);
      assert.deepEqual(published.results.stats, before.results.stats);
      assert.equal(published.evalId, before.evalId);
      assert.equal(published.results.results[0].id, before.results.results[0].id);
      assert.deepEqual(raw, before);
      assert.deepEqual(normalizeMergeCiResults(published, process.cwd()), published);
    }
  }
  const sourceError = { response: { error: `Required snapshot ".takt/facets.json" missing in ${process.cwd()}/eval/.work/merge-ci-recovery/source` } };
  assert.deepEqual(normalizeMergeCiResults(sourceError, process.cwd()), {
    response: { error: 'Required snapshot ".takt/facets.json" missing in ./eval/.work/merge-ci-recovery/source' },
  });
});

test('SCN-1-N1 preserves prefix mentions, unrelated temporary paths and path-free errors', () => {
  const value = { response: {
    output: 'takt-prompt-eval-fixture-という接頭辞を確認した。product.mjs:2が原因である',
    error: 'copy failed; inspect /tmp/other-fixture/project and takt-prompt-eval-fixture-ABC123',
  }, case: 'product-fix', score: 1, verdict: 'defect' };
  assert.deepEqual(normalizeMergeCiResults(value, process.cwd()), value);
});

test('SCN-2-P1 and SCN-2-N1 normalize known fixture paths throughout JSON and preserve evaluation data', () => {
  const repoRoot = '/home/alice/takt';
  const raw = resultFixture(repoRoot);
  const before = structuredClone(raw);
  const published = normalizeMergeCiResults(raw, repoRoot);
  const relative = 'eval/.work/merge-ci-recovery/merge-ci-review-ja-product-fix';
  const row = published.results.results[0];
  assert.deepEqual(row.response.metadata.fixture, { prompt_label: 'ja-product-fix', source_directory: relative,
    working_directory: relative, sha256: { 'product.mjs': 'unchanged' } });
  assert.equal(row.prompt.raw, `Read ${relative}/product.mjs`);
  assert.equal(row.response.output, `Read ${relative}/product.mjs:2; source_directoryを確認した。product.mjs:2のnull参照が原因である`);
  assert.equal(row.gradingResult.componentResults[0].prompt, `Grade ${relative} and ${relative}`);
  assert.deepEqual(row.gradingResult.componentResults.map(({ score }) => score), [1]);
  assert.deepEqual(row.testCase, before.results.results[0].testCase);
  assert.deepEqual(published.results.stats, before.results.stats);
  assert.equal(published.evalId, before.evalId);
  assert.equal(row.id, before.results.results[0].id);
  assert.deepEqual(raw, before);
  assert.deepEqual(normalizeMergeCiResults(published, repoRoot), published);
  const text = { response: { output: 'source_directoryを確認した。product.mjs:2のnull参照が原因である' },
    case: 'product-fix', score: 1, reference: 'https://github.com/org/repo/actions/runs/10' };
  assert.deepEqual(normalizeMergeCiResults(text, repoRoot), text);
});

test('both suites publish only current normalized output and retain failure aggregation and other suite output', (context) => {
  mkdirSync(resolve('eval/.results'), { recursive: true });
  const repoRoot = mkdtempSync(resolve('eval/.results/merge-ci-publication-'));
  context.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  function write(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
  for (const path of ['scripts/run-evals.mjs', 'scripts/merge-ci-public-results.mjs', 'suite-registry.mjs',
    ...PROMPT_EVAL_SUITES.map(({ config }) => config)]) {
    const destination = join(repoRoot, 'eval', path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve('eval', path), destination);
  }
  const arch = PROMPT_EVAL_SUITES.find(({ name }) => name === 'arch');
  write(join(repoRoot, 'eval', arch.config), 'outputPath: eval/results/arch.json\n');
  const binary = join(repoRoot, 'bin', 'npx');
  write(binary, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const config = args[args.indexOf('-c') + 1];
const suite = path.basename(config, '.yaml');
const output = /^outputPath: (.+)$/m.exec(fs.readFileSync(config, 'utf8'))[1];
const outputPath = path.resolve(output);
fs.appendFileSync('calls.jsonl', JSON.stringify({ suite, args, existed: fs.existsSync(outputPath) }) + '\\n');
const raw = JSON.parse(fs.readFileSync('input.json', 'utf8'));
if (suite === 'arch' || !['missing', 'missing-success'].includes(process.env.PUBLICATION_MODE)) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, suite !== 'arch' && process.env.PUBLICATION_MODE === 'invalid-json' ? '{' :
    JSON.stringify(raw[suite]));
}
process.exit(suite === 'arch' ? process.env.PUBLICATION_MODE === 'arch-failure' ? 1 : 0
  : ['failed-exit', 'failed-eval', 'missing', 'invalid-json', 'invalid-metadata'].includes(process.env.PUBLICATION_MODE)
    || process.env.PUBLICATION_MODE.startsWith('preparation-') ? 1 : 0);
`);
  chmodSync(binary, 0o755);
  const suites = [...MERGE_CI_TARGETS, 'arch'];
  const preparation = Object.fromEntries(MERGE_CI_TARGETS.map((suite) => [suite, preparationErrors(context, suite, repoRoot)]));
  const firstLabels = { 'merge-ci-investigation': 'ja-clock', 'merge-ci-review': 'ja-product-fix' };
  const filteredLabels = { 'merge-ci-investigation': 'en-clock', 'merge-ci-review': 'en-clock-fix' };
  const selectionCases = [
    ...[['--filter-first-n', '1'], ['--filter-first-n=1'], ['-n', '1']].flatMap((flags) =>
      ['selected', 'selected-missing', 'selected-extra'].map((mode) => ({ mode, flags, labels: firstLabels }))),
    ...[
      ['--filter-pattern', '^en-clock', '--filter-first-n', '1'],
      ['--filter-first-n', '1', '--filter-pattern', '^en-clock'],
    ].flatMap((flags) => ['selected', 'selected-wrong-label'].map((mode) => ({ mode, flags, labels: filteredLabels }))),
    ...['12', '13'].flatMap((count) => ['selected', 'selected-missing'].map((mode) =>
      ({ mode, flags: ['--filter-first-n', count] }))),
    { mode: 'unselected', labels: firstLabels },
    { mode: 'failed-exit', flags: ['--filter-first-n', '1'], labels: firstLabels },
    ...['empty-selected', 'empty-unexpected', 'failed-exit'].map((mode) => ({
      mode, flags: ['--filter-pattern', '^no-such-case$', '--filter-first-n', '1'], labels: firstLabels, empty: true,
    })),
    { mode: 'empty-missing-investigation', flags: ['--filter-pattern', '^ja-clock$', '--filter-first-n', '1'],
      labels: firstLabels, empty: true },
    { mode: 'empty-missing-review', flags: ['--filter-pattern', '^ja-product-fix$', '--filter-first-n', '1'],
      labels: firstLabels, empty: true },
  ];
  const passingModes = ['success', 'repeat-two', 'partial', 'selected', 'empty-selected'];
  const cases = ['success', 'failed-exit', 'failed-eval', 'preparation-missing', 'preparation-directory', 'preparation-copy-failure',
    'preparation-realpath-failure', 'missing', 'missing-success', 'invalid-json', 'invalid-metadata', 'arch-failure',
    'missing-clock', 'missing-investigation', 'biased-labels', 'missing-review', 'repeat-two', 'repeat-two-missing',
    'partial', 'partial-missing'].map((mode) => ({ mode }));
  for (const { mode, flags: selectionFlags, labels, empty } of [...cases, ...selectionCases]) {
    const repeat = mode.startsWith('repeat-two') ? 2 : 3;
    const partial = mode.startsWith('partial');
    const flags = ['--repeat', String(repeat), ...(selectionFlags ?? (partial ? ['--filter-pattern', '^ja-clock'] : []))];
    const raw = Object.fromEntries(MERGE_CI_TARGETS.map((suite) => [suite,
      runnerResultFixture(repoRoot, suite, repeat, partial ? /^ja-clock/ : undefined)]));
    for (const suite of MERGE_CI_TARGETS) {
      const value = raw[suite];
      if (labels) {
        value.results.results = value.results.results.filter(({ prompt }) => prompt.label === labels[suite]);
        assert.equal(value.results.results.length, repeat);
        value.results.stats.successes = repeat;
      }
      const rows = value.results.results;
      if (empty) {
        rows.splice(mode === 'empty-unexpected' ? 1 : 0);
        value.results.stats.successes = rows.length;
      }
      if (mode === 'selected-missing' || mode === 'repeat-two-missing') rows.shift();
      if (mode === 'selected-extra') rows.push(structuredClone(rows[0]));
      if (mode === 'selected-wrong-label') {
        rows[0].prompt.label = suite === 'merge-ci-investigation' ? 'en-clock-main' : 'en-clock-relax';
      }
    }
    raw.arch = { response: { output: preparation[MERGE_CI_TARGETS[0]].missing.error } };
    if (mode === 'missing-clock') {
      raw['merge-ci-investigation'].results.results = raw['merge-ci-investigation'].results.results
        .filter(({ prompt }) => !['ja-clock', 'ja-clock-main'].includes(prompt.label));
    }
    if (mode === 'biased-labels') {
      for (const suite of MERGE_CI_TARGETS) {
        const rows = raw[suite].results.results;
        rows[0].prompt.label = rows.find(({ prompt }) => prompt.label.startsWith('en-')).prompt.label;
      }
    }
    if (mode === 'missing-investigation') raw['merge-ci-investigation'].results.results.shift();
    if (mode === 'missing-review') raw['merge-ci-review'].results.results.splice(0, 1);
    if (mode === 'partial-missing') {
      for (const suite of MERGE_CI_TARGETS) raw[suite].results.results.pop();
    }
    if (mode.startsWith('preparation-')) {
      for (const suite of MERGE_CI_TARGETS) {
        raw[suite] = preparationFailureFixture(repoRoot, suite, preparation[suite][mode.slice('preparation-'.length)].error);
      }
    }
    if (mode === 'failed-eval') {
      for (const suite of MERGE_CI_TARGETS) {
        const value = raw[suite];
        value.results.stats = { successes: value.results.results.length - 1, failures: 1, errors: 1 };
        const row = value.results.results[0];
        row.success = false;
        delete row.response.output;
        row.response.error = `${row.response.metadata.fixture.working_directory}/product.mjs: permission denied`;
        row.gradingResult.pass = false;
        row.gradingResult.score = 0;
        row.gradingResult.componentResults[0].score = 0;
      }
    }
    if (mode === 'invalid-metadata') {
      for (const suite of MERGE_CI_TARGETS) raw[suite].results.results[0].response.metadata.fixture.source_directory = '/outside/project';
    }
    write(join(repoRoot, 'input.json'), JSON.stringify(raw));
    write(join(repoRoot, 'calls.jsonl'), '');
    for (const suite of MERGE_CI_TARGETS) {
      const paths = mergeCiResultPaths(suite, repoRoot);
      write(paths.raw, JSON.stringify({ stale: true }));
      write(paths.published, JSON.stringify({ previous: true }));
    }
    const execution = spawnSync(process.execPath, ['eval/scripts/run-evals.mjs', ...suites, ...flags], {
      cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: join(repoRoot, 'bin') + delimiter + process.env.PATH, PUBLICATION_MODE: mode },
    });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, passingModes.includes(mode) ? 0 : 1, execution.stdout + execution.stderr);
    const calls = readFileSync(join(repoRoot, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map(({ suite }) => suite), suites);
    assert.ok(calls.every(({ args }) => JSON.stringify(args.slice(-flags.length)) === JSON.stringify(flags)));
    assert.ok(calls.filter(({ suite }) => suite !== 'arch').every(({ existed }) => !existed));
    assert.ok(execution.stdout.includes(`${mode === 'arch-failure' ? 'FAIL' : 'PASS'}  arch`));
    for (const suite of MERGE_CI_TARGETS) {
      const published = JSON.parse(readFileSync(mergeCiResultPaths(suite, repoRoot).published, 'utf8'));
      assert.deepEqual(published, !['missing', 'missing-success', 'invalid-json', 'invalid-metadata'].includes(mode)
        ? normalizeMergeCiResults(raw[suite], repoRoot) : { previous: true });
      if (mode.startsWith('preparation-')) {
        const expected = preparationFailureFixture(repoRoot, suite,
          preparation[suite][mode.slice('preparation-'.length)].expected);
        expected.results.results[0].prompt.raw = expected.results.results[0].prompt.raw.replaceAll(repoRoot, '.');
        assert.deepEqual(published, expected);
      }
      if (mode === 'failed-eval') {
        assert.equal(published.results.results[0].response.error,
          `eval/.work/merge-ci-recovery/${suite}-ja-product-fix/product.mjs: permission denied`);
        assert.deepEqual(published.results.stats, { successes: published.results.results.length - 1, failures: 1, errors: 1 });
        assert.equal(published.results.results[0].success, false);
        assert.equal(published.results.results[0].gradingResult.pass, false);
      }
      const passed = passingModes.includes(mode) || mode === 'arch-failure'
        || ['missing-clock', 'missing-investigation'].includes(mode) && suite === 'merge-ci-review'
        || mode === 'missing-review' && suite === 'merge-ci-investigation'
        || mode === 'empty-missing-investigation' && suite === 'merge-ci-review'
        || mode === 'empty-missing-review' && suite === 'merge-ci-investigation';
      assert.ok(execution.stdout.includes(`${passed ? 'PASS' : 'FAIL'}  ${suite}`), execution.stdout + execution.stderr);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(repoRoot, 'eval/results/arch.json'), 'utf8')),
      raw.arch);
    assert.equal(mergeCiResultPaths('arch', repoRoot), undefined);
  }
});

test('production preparation supplies state and reports without exposing unavailable logs or grading labels', async (context) => {
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;
  context.after(() => {
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
  });
  process.env.TAKT_CONFIG_DIR = resolve('eval/config');
  const staleCase = resolve('eval/.work/merge-ci-recovery/merge-ci-investigation-ja-clock');
  const staleReport = join(staleCase, '.takt/runs/eval/reports/stale.md');
  mkdirSync(dirname(staleReport), { recursive: true });
  writeFileSync(join(staleCase, 'stale.txt'), 'stale log');
  writeFileSync(staleReport, 'stale report');
  await prepareMergeCiRecovery(MERGE_CI_TARGETS);
  assert.equal(existsSync(join(staleCase, 'stale.txt')), false);
  assert.equal(existsSync(staleReport), false);
  for (const language of ['ja', 'en']) {
    const directory = (suite, id) => resolve(`eval/.work/merge-ci-recovery/${suite}-${language}-${id}`);
    const evidence = (id) => JSON.parse(readFileSync(`${directory('merge-ci-investigation', id)}/failure-evidence.json`, 'utf8'));
    for (const id of ['runner-403', 'secret-empty']) {
      const failure = evidence(id);
      assert.equal(failure.complete, false);
      assert.equal(failure.checks[0].jobs[0].log, undefined);
      assert.ok(!readdirSync(directory('merge-ci-investigation', id)).some((name) => name.endsWith('.txt')));
    }
    const failedLog = evidence('clock').checks[0].jobs[0].log;
    const prompt = readFileSync(resolve(`eval/prompts/merge-ci-investigation-${language}-clock.phase1.md`), 'utf8');
    assert.ok(prompt.includes(failedLog.split('\n')[0]));
    for (const group of [['product-fix', 'product-delete', 'gate-removal'], ['clock-fix', 'clock-relax']]) {
      const verification = group.map((id) => readFileSync(`${directory('merge-ci-review', id)}/verification.md`, 'utf8'));
      assert.ok(verification.every((value) => value === verification[0]));
      for (const id of group) assert.ok(existsSync(`${directory('merge-ci-review', id)}/.takt/runs/eval/reports/ci-investigation.md`));
    }
    for (const suite of MERGE_CI_TARGETS) {
      const id = suite === 'merge-ci-review' ? 'product-fix' : 'clock';
      const snapshot = JSON.parse(readFileSync(`${directory(suite, id)}/.takt/facets.json`, 'utf8'));
      assert.ok(snapshot.persona.length > 0 && snapshot.policy.length > 0);
      const input = readFileSync(resolve(`eval/prompts/${suite}-${language}-${id}.phase1.md`), 'utf8');
      assert.ok(!input.includes('Structured result: expected'));
    }
  }
});
