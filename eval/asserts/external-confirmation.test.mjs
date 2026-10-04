import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { mergeCliReviewConfig } from '../providers/cli-review.mjs';
import { promptEvalPrepareTargets, selectPromptEvalSuites } from '../suite-registry.mjs';

const evalDir = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(evalDir, '..');
const suites = selectPromptEvalSuites({ names: [
  'review-external-confirmation',
  'supervise-external-confirmation',
  'replan-external-confirmation',
] });

test('external-confirmation cases bind exactly one prompt to its own task and isolated evidence', () => {
  for (const suite of suites) {
    const file = join(evalDir, suite.config);
    const config = parse(readFileSync(file, 'utf8'));
    const targets = promptEvalPrepareTargets([suite]);
    assert.deepEqual(config.prompts.map(({ label }) => label), targets);
    assert.equal(config.tests.length, targets.length);
    assert.equal(suite.execution.defaultEligible, false);
    assert.deepEqual(config.providers.map(({ config: provider }) => [
      provider.cli, provider.model, provider.reasoning_effort,
    ]), [
      ['codex', 'gpt-6-sol', 'low'],
      ['claude', 'claude-opus-5', undefined],
      ['codex', 'gpt-6-luna', 'max'],
    ]);

    for (const [index, prompt] of config.prompts.entries()) {
      const testcase = config.tests[index];
      assert.deepEqual(testcase.prompts, [prompt.label]);
      assert.equal(prompt.raw, `file://../../prompts/${prompt.label}.phase1.j2`);
      assert.equal(testcase.vars.task, `file://../../cases/${prompt.label}-task.md`);
      const fixture = join(evalDir, prompt.config.working_dir);
      assert.equal(dirname(fixture), join(evalDir, 'fixtures', suite.name));
      for (const provider of config.providers) {
        assert.equal(provider.id, 'file://../../providers/cli-review.mjs');
        assert.equal(provider.config.isolate_working_dir, true);
        assert.equal(provider.config.working_dir, undefined);
        const merged = mergeCliReviewConfig(provider.config, { prompt });
        assert.equal(merged.working_dir, prompt.config.working_dir);
      }
    }
  }
});

test('all external-confirmation fixture evidence hashes match the actual current or explicitly recorded previous code', () => {
  for (const suite of suites) {
    const directory = join(evalDir, 'fixtures', suite.name);
    const cases = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.ok(cases.length > 0, suite.name);
    for (const entry of cases) {
      const fixture = join(directory, entry.name);
      const state = JSON.parse(readFileSync(join(fixture, 'code-state.json'), 'utf8'));
      const hash = createHash('sha256')
        .update(readFileSync(join(fixture, 'app.mjs')))
        .update(readFileSync(join(fixture, 'app.test.mjs')))
        .digest('hex');
      assert.equal(state.sha256_app_and_test, hash, fixture);
      const reports = join(fixture, 'reports-seed');
      const documents = [
        ...readdirSync(fixture).filter(name => name.endsWith('.md')).map(name => join(fixture, name)),
        ...readdirSync(reports, { recursive: true }).filter(name => name.endsWith('.md'))
          .map(name => join(reports, name)),
      ];
      for (const document of documents) {
        const hashes = [...readFileSync(document, 'utf8').matchAll(/\b[0-9a-f]{64}\b/g)]
          .map(match => match[0]);
        if (suite.name === 'review-external-confirmation' && entry.name === 'stale-success'
          && document === join(reports, 'fix-verification.md')) {
          const previousHash = createHash('sha256')
            .update(readFileSync(join(fixture, 'app.previous.txt')))
            .update(readFileSync(join(fixture, 'test.previous.txt')))
            .digest('hex');
          assert.deepEqual(hashes, [previousHash, hash], document);
        } else {
          for (const recordedHash of hashes) {
            assert.equal(recordedHash, hash, document);
          }
        }
      }
    }
  }
});

test('prepared adjudication exposes its complete core criterion before the inline policy limit', () => {
  execFileSync(process.execPath, [
    'eval/scripts/prepare.mjs', ...promptEvalPrepareTargets(suites),
  ], { cwd: repoRoot });
  const id = 'review-external-confirmation-runtime';
  const prompt = readFileSync(join(evalDir, 'prompts', `${id}.phase1.j2`), 'utf8');
  const snapshot = readFileSync(join(evalDir, 'fixtures/review-external-confirmation/runtime',
    '.takt/eval-snapshots', `${id}-policies.md`), 'utf8');
  for (const language of ['ja', 'en']) {
    const policy = readFileSync(join(repoRoot, `builtins/${language}/facets/policies/review-adjudication.md`), 'utf8');
    const orderHeading = language === 'ja' ? '## 判定の順序' : '## Decision Order';
    const criteriaHeading = language === 'ja' ? '## 判断基準' : '## Decision Criteria';
    const order = policy.slice(policy.indexOf(orderHeading), policy.indexOf(criteriaHeading)).trim();
    const criterion = policy.split('\n').filter((line) => line.startsWith('|'))[2];
    assert.ok(criterion);
    assert.ok(policy.indexOf(criterion) + criterion.length <= 2000);
    assert.ok(policy.indexOf(order) + order.length <= 2000);
    if (language === 'ja') {
      assert.ok(snapshot.includes(order));
      assert.ok(prompt.includes(order), 'decision order must survive actual prompt truncation');
      assert.ok(prompt.includes(criterion), 'the core decision row must survive actual prompt truncation');
    }
  }
});

test('promptfoo calls the CLI in each case fixture and persists matching evidence without a model', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-external-confirmation-provider-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const cwd = process.cwd();
const prompt = fs.readFileSync(0, 'utf8');
const sha256 = Object.fromEntries(['app.mjs', 'app.test.mjs'].map(file => [file,
  fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]));
fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ cwd, sha256, promptUsesCwd: prompt.includes(cwd) }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-probe' }));
`);
  chmodSync(codex, 0o755);

  try {
    const configurations = [
      ...suites.map(suite => join(evalDir, suite.config)),
      join(evalDir, 'agents/frontend-review/frontend.yaml'),
      join(evalDir, 'agents/review-adjudication/review-adjudication.yaml'),
    ];
    execFileSync(process.execPath, ['eval/scripts/prepare.mjs',
      ...promptEvalPrepareTargets(suites), 'frontend-review', 'frontend-review-react', 'review-adjudication',
    ], { cwd: repoRoot });

    for (const [index, file] of configurations.entries()) {
      const suite = parse(readFileSync(file, 'utf8'));
      const base = dirname(file);
      const absolutize = value => typeof value === 'string' && value.startsWith('file://')
        ? `file://${resolve(base, value.slice(7))}` : value;
      const prompts = suite.prompts.map(prompt => typeof prompt === 'string'
        ? absolutize(prompt) : { ...prompt, raw: absolutize(prompt.raw) });
      const tests = (index < suites.length ? suite.tests : [suite.tests[0]]).map(testcase => ({
        ...testcase,
        assert: [],
        vars: Object.fromEntries(Object.entries(testcase.vars).map(([key, value]) => [key,
          typeof value === 'string' && value.startsWith('file://')
            ? readFileSync(resolve(base, value.slice(7)), 'utf8') : value,
        ])),
      }));
      const provider = { ...suite.providers[0], id: `file://${join(evalDir, 'providers/cli-review.mjs')}`,
        config: { ...suite.providers[0].config, cli: 'codex', model: 'gpt-6-sol', reasoning_effort: 'low' } };
      const config = join(directory, `suite-${index}.yaml`);
      const resultPath = join(directory, `result-${index}.json`);
      writeFileSync(config, stringify({ prompts, providers: [provider], tests,
        evaluateOptions: { maxConcurrency: 1 } }));
      const evaluation = spawnSync(process.execPath, [
        'node_modules/promptfoo/dist/src/entrypoint.js', 'eval', '-c', config,
        '--no-cache', '--no-progress-bar', '--no-table', '--no-share', '-o', resultPath,
      ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        PROMPTFOO_CONFIG_DIR: join(directory, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' } });
      const results = JSON.parse(readFileSync(resultPath, 'utf8')).results.results;
      assert.equal(evaluation.status, 0, JSON.stringify(results.map(result => result.response)));
      assert.equal(results.length, prompts.length);
      for (const result of results) {
        assert.equal(result.response.error, undefined);
        const observed = JSON.parse(result.response.output);
        const fixture = result.response.metadata.fixture;
        const prompt = prompts.find(prompt => prompt.label === fixture.prompt_label);
        const expected = prompt?.config?.working_dir ?? provider.config.working_dir;
        assert.equal(fixture.source_directory, resolve(evalDir, expected));
        assert.equal(observed.cwd, fixture.working_directory);
        assert.equal(observed.promptUsesCwd, true);
        assert.deepEqual(observed.sha256, fixture.sha256);
        for (const [name, hash] of Object.entries(fixture.sha256)) {
          const source = join(fixture.source_directory, name);
          assert.equal(hash, existsSync(source) ? createHash('sha256').update(readFileSync(source)).digest('hex') : null);
        }
        assert.equal(existsSync(fixture.working_directory), false, 'isolated copies must be cleaned up');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('payment fixtures separate completed behavior from actual incomplete-code controls', async () => {
  const cases = [
    ['review-external-confirmation/webhook', true],
    ['review-external-confirmation/service-outage', true],
    ['review-external-confirmation/partial-repair', false],
    ['review-external-confirmation/code-failure', false],
    ['supervise-external-confirmation/generic', true],
    ['supervise-external-confirmation/incomplete-verification', false],
  ];
  for (const [fixture, complete] of cases) {
    const { receive } = await import(pathToFileURL(join(evalDir, 'fixtures', fixture, 'app.mjs')));
    const event = { id: 'refund-control', signature: 'signed', type: 'refunded' };
    const seen = new Set();
    if (complete) {
      assert.deepEqual(receive(event, 'signed', seen), {
        accepted: true, duplicate: false, status: 'refunded',
      });
      assert.deepEqual(receive(event, 'signed', seen), { accepted: true, duplicate: true });
    } else {
      assert.throws(() => receive(event, 'signed', seen));
      assert.equal(seen.size, 0);
    }
  }
});

test('stale-success evidence identifies an actual older code state', () => {
  const fixture = join(evalDir, 'fixtures/review-external-confirmation/stale-success');
  const oldHash = createHash('sha256')
    .update(readFileSync(join(fixture, 'app.previous.txt')))
    .update(readFileSync(join(fixture, 'test.previous.txt')))
    .digest('hex');
  const currentHash = JSON.parse(readFileSync(join(fixture, 'code-state.json'), 'utf8'))
    .sha256_app_and_test;
  assert.notEqual(oldHash, currentHash);
  const report = readFileSync(join(fixture, 'reports-seed/fix-verification.md'), 'utf8');
  assert.ok(report.includes(oldHash));
});
