import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Codex } from '@openai/codex-sdk';
import { assertions, loadApiProvider } from 'promptfoo';
import { parse } from 'yaml';
import Provider from './frontend-mediator-review.mjs';
import CoderProvider from './frontend-mediator-coder.mjs';

const evalDirectory = fileURLToPath(new URL('../', import.meta.url));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'takt-mediator-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  const home = join(root, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex/auth.json'), '{}');
  writeFileSync(join(home, '.codex/config.toml'), 'model = "poison"');
  writeFileSync(join(home, '.codex/AGENTS.md'), 'Do not inherit');
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.UNRELATED_SECRET = 'do-not-inherit';
  return { root, home };
}

function seed(root, variant) {
  const directory = join(root, variant);
  cpSync(join(evalDirectory, 'fixtures/frontend-mediator-review', variant), directory, { recursive: true });
  mkdirSync(join(directory, '.takt/eval-snapshots'), { recursive: true });
  writeFileSync(join(directory, '.takt/eval-snapshots/knowledge.md'), 'fixture snapshot');
  return directory;
}

test('YAML providers and grader load and grade twice without changing the parent cwd or invoking a CLI', async t => {
  const { root } = setup(t);
  const directory = seed(root, 'good');
  const configPath = join(evalDirectory, 'agents/frontend-review/frontend-mediator-review.yaml');
  const suite = parse(readFileSync(configPath, 'utf8'));
  const basePath = dirname(configPath);
  const initialCwd = process.cwd();
  const review = JSON.stringify({ verdict: 'APPROVE', findings: [] });
  const calls = [];
  t.mock.method(CoderProvider.prototype, 'runAgent', async function (prompt, cwd) {
    assert.equal(process.cwd(), initialCwd);
    assert.ok(existsSync(cwd));
    assert.notEqual(cwd, directory);
    calls.push({ config: this.config, prompt, cwd });
    return { output: this.config.model === suite.defaultTest.options.provider.config.model
      ? JSON.stringify({ pass: true, score: 1, reason: 'mock grade' }) : review };
  });
  const graderOptions = suite.defaultTest.options.provider;
  const grader = await loadApiProvider(graderOptions.id, { options: graderOptions, basePath });
  assert.ok(grader instanceof Provider);
  for (const providerOptions of suite.providers) {
    const provider = await loadApiProvider(providerOptions.id, { options: providerOptions, basePath });
    assert.ok(provider instanceof Provider);
    for (let iteration = 0; iteration < 2; iteration++) {
      const response = await provider.callApi(`review ${directory}`, { prompt: { config: {
        ...suite.prompts[0].config,
        working_dir: directory,
        required_snapshots: ['.takt/eval-snapshots/knowledge.md'],
      } } });
      assert.equal(process.cwd(), initialCwd);
      assert.equal(response.error, undefined);
      assert.equal(response.output, review);
      const result = await assertions.runAssertion({
        assertion: {
          ...suite.tests[0].assert[0],
          value: `file://${join(evalDirectory, 'asserts/frontend-mediator-review.mjs')}`,
        },
        prompt: 'review', provider,
        test: { options: suite.defaultTest.options },
        providerResponse: response,
      });
      assert.equal(result.pass, true, result.reason);
      assert.equal(process.cwd(), initialCwd);
      assert.equal(suite.defaultTest.options.provider, graderOptions);
    }
  }
  assert.equal(calls.length, 8);
  assert.equal(calls.filter(call => call.config.model === graderOptions.config.model).length, 4);
  assert.ok(calls.every(call => !existsSync(call.cwd)));
});

test('Luna reviews each selected fixture in isolation with disposable HOME, read-only and explicit model/effort', async t => {
  const { root, home } = setup(t);
  const initialCwd = process.cwd();
  const observed = [];
  t.mock.method(Codex.prototype, 'startThread', function (thread) {
    observed.push({ sdk: this.options, thread });
    assert.deepEqual(readdirSync(this.options.env.CODEX_HOME), ['auth.json']);
    assert.equal(this.options.env.UNRELATED_SECRET, undefined);
    assert.equal(this.options.env.HOME === home, false);
    return { run: async prompt => {
      assert.equal(process.cwd(), initialCwd);
      assert.equal(prompt, `review ${thread.workingDirectory}`);
      assert.ok(existsSync(join(thread.workingDirectory, 'src/routes/order-edit.tsx')));
      assert.ok(!existsSync(join(thread.workingDirectory, '../good')));
      assert.ok(!existsSync(join(thread.workingDirectory, '../bad')));
      return { finalResponse: '{"verdict":"APPROVE","findings":[]}' };
    } };
  });
  const provider = new Provider({ config: {
    cli: 'codex', model: 'gpt-5.6-luna', reasoning_effort: 'max',
    isolate_working_dir: true, timeout_ms: 1000,
    working_dir: '/must-be-overridden',
  } });
  for (const variant of ['good', 'bad', 'bad2', 'good-hook', 'good']) {
    const directory = existsSync(join(root, variant)) ? join(root, variant) : seed(root, variant);
    const result = await provider.callApi(`review ${directory}`, { prompt: { config: {
      working_dir: directory, required_snapshots: ['.takt/eval-snapshots/knowledge.md'],
    } } });
    assert.equal(process.cwd(), initialCwd);
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(result.output), { verdict: 'APPROVE', findings: [] });
    const { thread, sdk } = observed.at(-1);
    assert.equal(thread.model, 'gpt-5.6-luna');
    assert.equal(thread.modelReasoningEffort, 'max');
    assert.equal(thread.sandboxMode, 'read-only');
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(thread.networkAccessEnabled, false);
    assert.equal(thread.webSearchMode, 'disabled');
    assert.notEqual(thread.workingDirectory, directory);
    assert.equal(existsSync(thread.workingDirectory), false);
    assert.equal(existsSync(sdk.env.HOME), false);
    assert.equal(existsSync(sdk.env.CODEX_HOME), false);
    assert.ok(existsSync(directory));
  }
  assert.equal(new Set(observed.map(value => value.thread.workingDirectory)).size, 5);
  assert.equal(new Set(observed.map(value => value.sdk.env.CODEX_HOME)).size, 5);
});

test('review failure cleans up HOME and working copy without saving artifacts in eval/.results', async t => {
  const { root } = setup(t);
  const initialCwd = process.cwd();
  const directory = seed(root, 'bad');
  let observed;
  t.mock.method(Codex.prototype, 'startThread', function (thread) {
    observed = { sdk: this.options, thread };
    return { run: async () => { throw new Error('mock review failure'); } };
  });
  const provider = new Provider({ config: {
    cli: 'codex', model: 'gpt-5.6-luna', reasoning_effort: 'max',
    isolate_working_dir: true, timeout_ms: 1000, working_dir: directory,
  } });
  const result = await provider.callApi('review', {});
  assert.equal(process.cwd(), initialCwd);
  assert.equal(result.error, 'mock review failure');
  assert.equal(result.metadata?.artifactDirectory, undefined);
  assert.equal(existsSync(observed.sdk.env.HOME), false);
  assert.equal(existsSync(observed.thread.workingDirectory), false);
});

test('review requires isolation and the selected snapshots before invoking the SDK', async t => {
  const { root } = setup(t);
  const directory = seed(root, 'good');
  const start = t.mock.method(Codex.prototype, 'startThread', () => assert.fail('SDK must not run'));
  for (const config of [
    { isolate_working_dir: false },
    { isolate_working_dir: true, required_snapshots: ['missing.md'] },
  ]) {
    const result = await new Provider({ config: {
      cli: 'codex', model: 'gpt-5.6-luna', working_dir: directory, ...config,
    } }).callApi('review', {});
    assert.match(result.error, /isolate_working_dir|snapshot.*missing/);
  }
  assert.equal(start.mock.callCount(), 0);
});

test('Opus uses safe mode, restricted tools, allowlisted environment and isolated cwd through a fake CLI', async t => {
  const { root, home } = setup(t);
  const directory = seed(root, 'bad2');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'claude');
  writeFileSync(executable, `#!${process.execPath}
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => console.log(JSON.stringify({
  args: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt,
})));
`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = '/poison/config';
  process.env.CLAUDE_ENV_FILE = '/poison/hooks';
  const result = await new Provider({ config: {
    cli: 'claude', model: 'claude-opus-5', timeout_ms: 1000,
    working_dir: directory, isolate_working_dir: true,
  } }).callApi(`review ${directory}`, {});
  assert.equal(result.error, undefined);
  const observed = JSON.parse(result.output);
  assert.equal(observed.args[observed.args.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(observed.args[observed.args.indexOf('--allowed-tools') + 1], 'Read,Glob,Grep');
  assert.equal(observed.args[observed.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(observed.args[observed.args.indexOf('--output-format') + 1], 'text');
  for (const flag of ['--safe-mode', '--disable-slash-commands', '--setting-sources=project', '--no-session-persistence']) {
    assert.ok(observed.args.includes(flag));
  }
  assert.equal(observed.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(observed.env.CLAUDE_ENV_FILE, undefined);
  assert.equal(observed.env.UNRELATED_SECRET, undefined);
  assert.equal(observed.env.HOME, home);
  assert.notEqual(observed.cwd, directory);
  assert.equal(observed.prompt, `review ${observed.cwd}`);
  assert.equal(existsSync(observed.cwd), false);
  assert.ok(existsSync(directory));
  assert.equal(result.metadata?.artifactDirectory, undefined);
});
