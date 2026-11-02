import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { resolveComparisonOutputDir } from './compare-facets.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const facet = 'builtins/ja/facets/personas/coder.md';
const added = 'builtins/ja/facets/personas/pe-test-only-added.md';
const baseline = execFileSync('git', ['show', `${revision}:${facet}`], { cwd: repo, encoding: 'utf8' });
const candidate = 'candidate\r\n文面\n';

for (const [name, paths, root] of [['POSIX', posix, '/repo'], ['Windows', win32, 'C:\\repo']]) {
  test(`${name}: accepts output directories beneath .tmp and eval/.results`, () => {
    for (const parent of ['.tmp', paths.join('eval', '.results')]) {
      const output = paths.join(parent, 'comparison');
      assert.equal(resolveComparisonOutputDir(root, output, paths), paths.join(root, output));
      assert.equal(resolveComparisonOutputDir(root, paths.join(root, output), paths), paths.join(root, output));
    }
  });

  test(`${name}: rejects output roots, sibling names and paths outside the repository`, () => {
    for (const output of [
      '.tmp', paths.join('eval', '.results'),
      paths.join('.tmp-other', 'comparison'), paths.join('eval', '.results-other', 'comparison'),
      paths.join('..', 'comparison'), paths.resolve(root, '..', '.tmp', 'comparison'),
      paths.join('.tmp', '..', 'comparison'),
      ...(paths === win32 ? ['D:\\repo\\.tmp\\comparison'] : []),
    ]) {
      assert.throws(() => resolveComparisonOutputDir(root, output, paths));
    }
  });
}

function setup(t, environment = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-compare-facets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scripts = join(directory, 'eval/scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(directory, 'eval/lib'), { recursive: true });
  copyFileSync(join(repo, 'eval/lib/process-tree.mjs'), join(directory, 'eval/lib/process-tree.mjs'));
  symlinkSync(join(repo, 'dist'), join(directory, 'dist'), 'junction');
  symlinkSync(join(repo, 'node_modules'), join(directory, 'node_modules'), 'junction');
  writeFileSync(join(directory, 'eval/new-case.md'), 'uncommitted eval case');
  mkdirSync(join(directory, dirname(facet)), { recursive: true });
  copyFileSync(join(repo, 'eval/scripts/compare-facets.mjs'), join(scripts, 'compare-facets.mjs'));
  writeFileSync(join(directory, facet), candidate);
  writeFileSync(join(directory, added), 'new facet\n');
  // The double observes the real runner's argv and working tree without invoking a provider.
  writeFileSync(join(scripts, 'run-evals.mjs'), `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const args = process.argv.slice(2);
    const text = readFileSync(${JSON.stringify(facet)}, 'utf8');
    const current = text === ${JSON.stringify(candidate)};
    appendFileSync('calls.jsonl', JSON.stringify({ args, text, added: existsSync(${JSON.stringify(added)}), raw: process.env.TAKT_EVAL_RECORD_DIR, newCase: readFileSync('eval/new-case.md', 'utf8') }) + '\\n');
    mkdirSync('eval/prompts', { recursive: true });
    writeFileSync('eval/prompts/sample.md', text);
    for (const path of ['eval/fixtures/sample/.takt/eval-snapshots', 'eval/.work/sample/.takt/runs/eval/reports']) mkdirSync(path, { recursive: true });
    writeFileSync('eval/fixtures/sample/.takt/eval-snapshots/policy.md', text);
    writeFileSync('eval/.work/sample/generated.txt', text);
    writeFileSync('eval/.work/sample/.takt/runs/eval/reports/report.md', text);
    if (process.env.TEST_WAIT === '1') {
      const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const intermediate = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', " + JSON.stringify(grandchild) + "], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync('ready', JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);";
      spawn(process.execPath, ['-e', intermediate], { detached: true, stdio: 'ignore' });
      setInterval(() => {}, 1000);
    } else {
      if (process.env.TEST_NO_RESULT !== '1') writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ output: text, reason: 'full grader reason' }));
      process.exitCode = !current && process.env.TEST_RED_FAIL === '1' ? 1 : 0;
    }
  `);
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: directory, ...environment };
  const args = ['eval/scripts/compare-facets.mjs', '--base', revision, '--suite', 'sample', '--facet', facet, '--output-dir', '.tmp/result'];
  return {
    directory, env, args,
    run(extra = []) {
      return spawnSync(process.execPath, [...args, ...extra], { cwd: directory, env, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    },
    manifest() { return JSON.parse(readFileSync(join(directory, '.tmp/result/manifest.json'), 'utf8')); },
    calls() { return this.manifest().runs.flatMap((run) => readFileSync(join(run.workspace, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))); },
  };
}

test('compares the baseline and candidate with uncached preparation, preserves full results, and never changes source bytes', (t) => {
  const fixture = setup(t);
  const result = fixture.run(['--suite', 'second', '--filter-providers', 'luna|opus']);
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.deepEqual(calls.map((call) => call.text), [baseline, baseline, candidate, candidate]);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 2), ['--prepare', call.args[1]]);
    assert.ok(call.args.includes('--no-cache'));
    assert.deepEqual(call.args.slice(-2), ['--filter-providers', 'luna|opus']);
    assert.ok(call.raw.endsWith('/raw'));
    assert.equal(call.newCase, 'uncommitted eval case');
  }
  const manifest = fixture.manifest();
  assert.equal(manifest.base, revision);
  assert.equal(manifest.runs.length, 4);
  assert.notEqual(manifest.files[0].baselineSha256, manifest.files[0].candidateSha256);
  assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
  for (const phase of ['red', 'green']) {
    const expected = phase === 'red' ? baseline : candidate;
    assert.equal(JSON.parse(readFileSync(join(fixture.directory, '.tmp/result', phase, 'sample/results.json'), 'utf8')).output, expected);
    const workspace = manifest.runs.find((run) => run.phase === phase && run.suite === 'sample').workspace;
    for (const path of ['eval/prompts/sample.md', 'eval/fixtures/sample/.takt/eval-snapshots/policy.md', 'eval/.work/sample/generated.txt', 'eval/.work/sample/.takt/runs/eval/reports/report.md']) {
      assert.equal(readFileSync(join(workspace, path), 'utf8'), expected);
    }
    assert.equal(readFileSync(join(fixture.directory, '.tmp/result/facets', phase, facet), 'utf8'), expected);
  }
});

test('comparison records run fixtures outside the checkout and copy their artifacts after execution', (t) => {
  const fixture = setup(t);
  execFileSync('git', ['init', fixture.directory], { stdio: 'pipe' });
  const checkout = realpathSync(fixture.directory);
  assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, encoding: 'utf8' }).trim(), checkout);
  const providers = join(fixture.directory, 'eval/providers');
  mkdirSync(providers);
  for (const name of ['cli-review.mjs', 'execution-record.mjs']) {
    copyFileSync(join(repo, 'eval/providers', name), join(providers, name));
  }
  const bin = join(fixture.directory, 'fake-bin');
  mkdirSync(bin);
  const cli = join(bin, 'claude');
  writeFileSync(cli, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const observed = { cwd: process.cwd(), gitCode: git.status, gitRoot: git.stdout.trim(), input };
  writeFileSync('observed.json', JSON.stringify(observed));
  console.log(JSON.stringify({ type: 'result', result: JSON.stringify(observed) }));
});
`);
  chmodSync(cli, 0o755);
  fixture.env.PATH = `${bin}:${process.env.PATH}`;
  writeFileSync(join(fixture.directory, 'eval/scripts/run-evals.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import CliReviewProvider from '../providers/cli-review.mjs';
const source = resolve('eval/fixtures/sample');
mkdirSync(source, { recursive: true });
writeFileSync(source + '/policy.md', readFileSync(${JSON.stringify(facet)}));
const provider = new CliReviewProvider({ config: {
  cli: 'claude', model: 'offline', working_dir: source, isolate_working_dir: true, timeout_ms: 2000,
} });
const response = await provider.callApi('read ' + source + '/policy.md', {
  prompt: { label: 'isolated-fixture' }, vars: { lang: 'ja' }, repeatIndex: 0,
});
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ results: { results: [{ response }] } }));
if (response.error) throw new Error(response.error);
`);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const runs = fixture.manifest().runs;
  assert.deepEqual(runs.map((run) => run.phase), ['red', 'green']);
  for (const run of runs) {
    const row = JSON.parse(readFileSync(run.resultFile, 'utf8')).results.results[0];
    const directory = row.response.metadata.execution_record;
    assert.ok(directory.startsWith(run.rawDirectory + '/'));
    const invocation = JSON.parse(readFileSync(join(directory, 'process-1.json'), 'utf8'));
    const observed = JSON.parse(row.response.output);
    assert.equal(observed.cwd, invocation.cwd);
    assert.equal(observed.cwd.startsWith(checkout + '/'), false);
    assert.equal(observed.cwd.startsWith(realpathSync(repo) + '/'), false);
    if (observed.gitCode === 0) assert.equal(observed.gitRoot, observed.cwd);
    else {
      assert.equal(observed.gitCode, 128);
      assert.equal(observed.gitRoot, '');
    }
    const project = JSON.parse(readFileSync(join(directory, 'project-1.json'), 'utf8'));
    assert.equal(project.cwd, invocation.cwd);
    assert.deepEqual(JSON.parse(readFileSync(join(project.snapshotDirectory, 'observed.json'), 'utf8')), observed);
    assert.equal(existsSync(observed.cwd), false);
    assert.equal(readFileSync(join(project.snapshotDirectory, 'policy.md'), 'utf8'), run.phase === 'red' ? baseline : candidate);
    assert.equal(readFileSync(join(directory, 'prompt.md'), 'utf8'), 'read ' + join(run.workspace, 'eval/fixtures/sample/policy.md'));
    assert.equal(observed.input, 'read ' + join(observed.cwd, 'policy.md'));
  }
});

test('a failing baseline still runs green, records failure, and preserves the source candidate', (t) => {
  const fixture = setup(t, { TEST_RED_FAIL: '1' });
  assert.equal(fixture.run().status, 1);
  assert.deepEqual(fixture.manifest().runs.map((run) => run.code), [1, 0]);
  assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
});

test('an added facet is absent for red and present for green', (t) => {
  const fixture = setup(t);
  const result = fixture.run(['--facet', added]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls().map((call) => call.added), [false, true]);
  assert.equal(fixture.manifest().files[1].baselineSha256, null);
  assert.equal(readFileSync(join(fixture.directory, added), 'utf8'), 'new facet\n');
});

test('a deleted facet exists only in red and remains deleted after comparison', (t) => {
  const fixture = setup(t);
  const deleted = 'builtins/en/facets/personas/coder.md';
  const result = fixture.run(['--facet', deleted]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.manifest().files[1].candidateSha256, null);
  assert.equal(existsSync(join(fixture.directory, deleted)), false);
  assert.ok(existsSync(join(fixture.directory, '.tmp/result/facets/red', deleted)));
});

test('red-only and green-only runs keep the candidate intact', (t) => {
  for (const mode of ['red', 'green']) {
    const fixture = setup(t);
    const result = fixture.run(['--mode', mode]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.calls().map((call) => call.text), [mode === 'red' ? baseline : candidate]);
    assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
  }
});

test('a runner that writes no result is a failed measurement even with exit zero', (t) => {
  const fixture = setup(t, { TEST_NO_RESULT: '1' });
  assert.equal(fixture.run().status, 1);
  assert.ok(fixture.manifest().runs.every((run) => run.code === 0 && !run.resultExists));
});

test('validates all paths and the baseline before starting measurement', (t) => {
  for (const extra of [
    ['--facet', 'src/index.ts'],
    ['--facet', 'builtins/ja/facets/../outside.md'],
    ['--facet', 'builtins/ja/facets/missing-test-file.md'],
    ['--base', 'refs/heads/pe-no-such-ref'],
    ['--mode', 'invalid'],
    ['--facet', facet],
    ['--suite', 'sample'],
    ['--output-dir', 'builtins/result'],
    ['--output-dir', '.tmp-other/result'],
    ['--output-dir', '../comparison'],
    ['--filter-providers'],
  ]) {
    const fixture = setup(t);
    assert.equal(fixture.run(extra).status, 1, JSON.stringify(extra));
    assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
    assert.equal(existsSync(join(fixture.directory, 'calls.jsonl')), false);
  }
});

test('refuses symlink facets without altering files', (t) => {
  const linked = setup(t);
  rmSync(join(linked.directory, added));
  symlinkSync(join(linked.directory, facet), join(linked.directory, added));
  assert.equal(linked.run(['--facet', added]).status, 1);
  rmSync(join(linked.directory, added));
  symlinkSync(join(linked.directory, 'missing'), join(linked.directory, added));
  assert.equal(linked.run(['--facet', added]).status, 1);
});

test('fails before starting a runner when process discovery is unavailable', (t) => {
  const fixture = setup(t);
  const bin = join(fixture.directory, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 9\n');
  chmodSync(join(bin, 'ps'), 0o755);
  fixture.env.PATH = `${bin}:${process.env.PATH}`;
  assert.equal(fixture.run().status, 1);
  assert.equal(existsSync(join(fixture.directory, '.tmp/result')), false);
  assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
});

test('never overwrites an existing result directory', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const before = readFileSync(join(fixture.directory, '.tmp/result/manifest.json'));
  assert.equal(fixture.run().status, 1);
  assert.deepEqual(readFileSync(join(fixture.directory, '.tmp/result/manifest.json')), before);
  assert.equal(fixture.calls().length, 2);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops detached children and grandchildren and preserves the interrupted measurement`, { timeout: 15000 }, async (t) => {
    const fixture = setup(t, { TEST_WAIT: '1' });
    const child = spawn(process.execPath, fixture.args, { cwd: fixture.directory, env: fixture.env, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const closed = new Promise((resolveClose) => child.once('close', (code) => resolveClose(code)));
    const ready = join(fixture.directory, '.tmp/result/red/sample/workspace/ready');
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline, 'runner did not start');
      await setTimeout(20);
    }
    const pids = JSON.parse(readFileSync(ready, 'utf8'));
    t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } });
    assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
    child.kill(signal);
    assert.equal(await closed, signal === 'SIGINT' ? 130 : 143);
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    assert.equal(readFileSync(join(fixture.directory, facet), 'utf8'), candidate);
    assert.equal(fixture.manifest().interrupted, signal);
    assert.equal(fixture.manifest().runs.length, 1);
  });
}
