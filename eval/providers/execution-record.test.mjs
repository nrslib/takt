import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import CliReviewProvider from './cli-review.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-execution-record-'));
  const source = join(directory, 'source');
  const bin = join(directory, 'bin');
  const records = join(directory, 'records');
  mkdirSync(source);
  mkdirSync(bin);
  mkdirSync(join(source, '.takt/eval-snapshots'), { recursive: true });
  writeFileSync(join(source, '.takt/eval-snapshots/policies.md'), 'source policy');
  for (const cli of ['claude', 'codex']) {
    const path = join(bin, cli);
    writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'offline-session' }));
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'read source policy' } }));
  console.error('partial diagnostic');
  fs.mkdirSync('.takt/runs/eval/reports', { recursive: true });
  fs.writeFileSync('.takt/runs/eval/reports/report.md', prompt);
  fs.writeFileSync('generated.txt', prompt);
  if (prompt.includes('wait')) { setInterval(() => {}, 1000); return; }
  if (prompt.includes('fail')) { process.exitCode = 7; return; }
  const index = process.argv.indexOf('-o');
  if (index !== -1) fs.writeFileSync(process.argv[index + 1], 'answer: ' + prompt);
  console.log(JSON.stringify({ type: 'result', result: 'answer: ' + prompt }));
});
`);
    chmodSync(path, 0o755);
  }
  const previous = { path: process.env.PATH, records: process.env.TAKT_EVAL_RECORD_DIR };
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.TAKT_EVAL_RECORD_DIR = records;
  t.after(() => {
    process.env.PATH = previous.path;
    if (previous.records === undefined) delete process.env.TAKT_EVAL_RECORD_DIR;
    else process.env.TAKT_EVAL_RECORD_DIR = previous.records;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    records,
    directory,
    source,
    provider(cli, timeout_ms = 0) {
      return new CliReviewProvider({ config: { cli, model: 'offline', reasoning_effort: 'low', working_dir: source, isolate_working_dir: true, timeout_ms } });
    },
  };
}

const json = (directory, name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));

for (const cli of ['claude', 'codex']) {
  test(`${cli}: promptfoo rows link distinct language/repeat records and retain projects`, async (t) => {
    const fixture = setup(t);
    const configPath = join(fixture.directory, 'config.json');
    const resultPath = join(fixture.directory, 'results.json');
    writeFileSync(configPath, JSON.stringify({
      providers: [{ id: fileURLToPath(new URL('./cli-review.mjs', import.meta.url)), config: fixture.provider(cli).config }],
      prompts: [{ raw: '{{task}}', label: 'case-input' }],
      tests: ['ja', 'en'].map((lang) => ({ description: `case-${lang}`, vars: { lang, task: `task-${lang}` } })),
      evaluateOptions: { repeat: 2, maxConcurrency: 4 },
    }));
    const evaluation = spawnSync(process.execPath, ['node_modules/promptfoo/dist/src/entrypoint.js', 'eval', '-c', configPath,
      '--no-cache', '--no-progress-bar', '--no-table', '--no-share', '-o', resultPath], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PROMPTFOO_CONFIG_DIR: join(fixture.directory, 'promptfoo'), PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' },
    });
    assert.equal(evaluation.status, 0, evaluation.stderr + evaluation.stdout);
    const rows = json(fixture.directory, 'results.json').results.results;
    assert.equal(rows.length, 4);
    const directories = rows.map((row) => row.response.metadata.execution_record);
    assert.equal(new Set(directories).size, 4);
    const identities = directories.map((directory) => json(directory, 'identity.json'));
    assert.deepEqual(identities.map(({ vars, repeatIndex }) => `${vars.lang}:${repeatIndex}`).sort(), ['en:0', 'en:1', 'ja:0', 'ja:1']);
    for (const row of rows) {
      assert.equal(row.success, true);
      const directory = row.response.metadata.execution_record;
      const identity = json(directory, 'identity.json');
      assert.equal(identity.promptLabel, 'case-input');
      const invocation = json(directory, 'process-1.json');
      const project = json(directory, 'project-1.json');
      assert.equal(project.cwd, invocation.cwd);
      assert.equal(existsSync(invocation.cwd), false);
      assert.equal(invocation.code, 0);
      assert.equal(invocation.timedOut, false);
      assert.equal(invocation.aborted, false);
      assert.equal(invocation.status, 'finished');
      assert.match(readFileSync(join(directory, 'process-1.stdout'), 'utf8'), /command_execution/);
      assert.equal(readFileSync(join(directory, 'process-1.stderr'), 'utf8'), 'partial diagnostic\n');
      assert.equal(readFileSync(join(project.snapshotDirectory, 'generated.txt'), 'utf8'), identity.vars.task);
      assert.equal(readFileSync(join(project.snapshotDirectory, '.takt/runs/eval/reports/report.md'), 'utf8'), identity.vars.task);
      assert.equal(readFileSync(join(project.snapshotDirectory, '.takt/eval-snapshots/policies.md'), 'utf8'), 'source policy');
      assert.equal(json(directory, 'result.json').response.output, row.response.output);
    }
    assert.equal(existsSync(join(fixture.source, 'generated.txt')), false);
  });

  test(`${cli}: timeout retains streamed events, partial output and exit information`, { timeout: 10000 }, async (t) => {
    const fixture = setup(t);
    const response = await fixture.provider(cli, 600).callApi('wait', {
      prompt: { label: 'timeout-ja' }, vars: { lang: 'ja' }, repeatIndex: 2,
    });
    assert.ok(response.error);
    const directory = response.metadata.execution_record;
    const invocation = json(directory, 'process-1.json');
    assert.equal(invocation.status, 'finished');
    assert.equal(invocation.timedOut, true);
    assert.equal(invocation.aborted, false);
    assert.ok(invocation.signal || invocation.code !== null);
    assert.equal(json(directory, 'identity.json').repeatIndex, 2);
    assert.match(readFileSync(join(directory, 'process-1.stdout'), 'utf8'), /item.started/);
    assert.equal(readFileSync(join(directory, 'process-1.stderr'), 'utf8'), 'partial diagnostic\n');
    assert.equal(existsSync(invocation.cwd), false);
    assert.equal(readFileSync(join(json(directory, 'project-1.json').snapshotDirectory, 'generated.txt'), 'utf8'), 'wait');
    assert.equal(json(directory, 'result.json').status, 'failed');
  });
}

test('streams records before completion and records the explicit abort reason', { timeout: 10000 }, async (t) => {
  const fixture = setup(t);
  const controller = new AbortController();
  const pending = fixture.provider('claude').callApi('wait', { prompt: { label: 'abort' } }, { abortSignal: controller.signal });
  const deadline = Date.now() + 5000;
  let directory;
  while (true) {
    const names = existsSync(fixture.records) ? readdirSync(fixture.records) : [];
    directory = names.length > 0 ? join(fixture.records, names[0]) : undefined;
    if (directory && existsSync(join(directory, 'process-1.stdout')) && readFileSync(join(directory, 'process-1.stdout'), 'utf8').includes('item.started')) break;
    assert.ok(Date.now() < deadline, 'no live process output recorded');
    await delay(20);
  }
  assert.equal(json(directory, 'process-1.json').status, 'running');
  const project = json(directory, 'project-1.json');
  assert.equal(existsSync(project.cwd), true);
  assert.equal(existsSync(project.snapshotDirectory), false);
  controller.abort(new Error('offline test cancellation'));
  const response = await pending;
  assert.ok(response.error);
  assert.equal(response.metadata.execution_record, directory);
  const invocation = json(directory, 'process-1.json');
  assert.equal(invocation.aborted, true);
  assert.equal(invocation.timedOut, false);
  assert.equal(invocation.abortReason, 'Error: offline test cancellation');
  assert.equal(existsSync(project.cwd), false);
  assert.equal(readFileSync(join(project.snapshotDirectory, 'generated.txt'), 'utf8'), 'wait');
});

test('nonzero exit retains its code and partial events', async (t) => {
  const fixture = setup(t);
  const response = await fixture.provider('claude').callApi('fail', { prompt: { label: 'failure' } });
  assert.ok(response.error);
  const directory = response.metadata.execution_record;
  assert.equal(json(directory, 'process-1.json').code, 7);
  assert.equal(json(directory, 'result.json').status, 'failed');
  assert.match(readFileSync(join(directory, 'process-1.stdout'), 'utf8'), /item.started/);
});
