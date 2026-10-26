import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ManagerWorkSplitProvider, { buildCodexReplayConfigArgs, buildManagerReplayIsolationArgs } from './manager-work-split.mjs';
import { buildReplayCliArgs } from './interactive-topic-judge.mjs';

const providerUrl = new URL('./manager-work-split.mjs', import.meta.url).href;
const codexConfigs = [
  { cli: 'codex', model: 'gpt-6-sol', reasoning_effort: 'low', timeout_ms: 1000 },
  { cli: 'codex', model: 'gpt-6-luna', reasoning_effort: 'max', timeout_ms: 1000 },
];

function createReplayFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-manager-provider-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const temp = join(root, 'temp');
  const userHome = join(root, 'user');
  const sourceHome = join(root, 'custom-codex');
  const defaultHome = join(userHome, '.codex');
  for (const directory of [bin, temp, sourceHome, defaultHome]) mkdirSync(directory, { recursive: true });
  for (const home of [sourceHome, defaultHome]) {
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ testCredential: home }));
    writeFileSync(join(home, 'AGENTS.md'), 'UNWANTED_GLOBAL_INSTRUCTIONS');
    writeFileSync(join(home, 'AGENTS.override.md'), 'UNWANTED_GLOBAL_OVERRIDE');
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.ambient]\ncommand = "echo"\n');
    const skill = join(home, 'skills', 'ambient');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: ambient\ndescription: Ambient test skill\n---\nUnwanted rules.');
  }
  const capture = join(root, 'launches.jsonl');
  const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const home = process.env.CODEX_HOME;
  const record = {
    args, input, cwd: process.cwd(), codexHome: home,
    files: fs.readdirSync(home).sort(),
    auth: fs.existsSync(path.join(home, 'auth.json')) ? fs.readFileSync(path.join(home, 'auth.json'), 'utf8') : null,
  };
  fs.appendFileSync(process.env.TEST_CAPTURE, JSON.stringify(record) + '\\n');
  if (process.env.TEST_MODE === 'failure') process.exit(9);
  if (process.env.TEST_MODE === 'hang') { setInterval(() => {}, 1000); return; }
  if (path.basename(process.argv[1]) === 'claude') { process.stdout.write('fake response'); return; }
  if (args[0] !== 'exec') process.exit(11);
  fs.writeFileSync(args[args.indexOf('-o') + 1], 'fake response');
});
`;
  for (const cli of ['codex', 'claude']) {
    writeFileSync(join(bin, cli), fakeCli);
    chmodSync(join(bin, cli), 0o755);
  }
  return { root, bin, temp, userHome, sourceHome, defaultHome, capture };
}

function runFakeReplays(fixture, configs, { defaultHome = false, mode = 'success', abort = false } = {}) {
  const env = {
    ...process.env, HOME: fixture.userHome, CODEX_HOME: fixture.sourceHome,
    TMPDIR: fixture.temp, PATH: `${fixture.bin}:${process.env.PATH}`,
    TEST_CAPTURE: fixture.capture, TEST_MODE: mode,
  };
  if (defaultHome) delete env.CODEX_HOME;
  delete env.TAKT_INTERACTIVE_EVAL_OUTPUT_DIR;
  const script = `
    import { existsSync } from 'node:fs';
    import Provider from ${JSON.stringify(providerUrl)};
    const before = process.env.CODEX_HOME;
    const controller = new AbortController();
    const timer = ${abort} ? setInterval(() => {
      if (existsSync(process.env.TEST_CAPTURE)) controller.abort();
    }, 10) : undefined;
    const results = await Promise.all(${JSON.stringify(configs)}.map((config) =>
      new Provider({ config }).callApi('test prompt', { vars: { lang: 'en' } }, { abortSignal: controller.signal })
    ));
    if (timer !== undefined) clearInterval(timer);
    console.log(JSON.stringify({ results, envUnchanged: before === process.env.CODEX_HOME }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.envUnchanged, true);
  assert.deepEqual(readdirSync(fixture.temp), []);
  const launches = existsSync(fixture.capture)
    ? readFileSync(fixture.capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  for (const launch of launches) {
    assert.equal(existsSync(launch.cwd), false);
    if (configs[0].cli === 'codex') assert.equal(existsSync(launch.codexHome), false);
  }
  return { ...result, launches };
}

test('retains Codex replay restrictions without MCP discovery or per-server overrides', () => {
  const args = buildManagerReplayIsolationArgs('codex');
  assert.deepEqual(args, buildCodexReplayConfigArgs());
  const overrides = args.filter((_arg, index) => args[index - 1] === '-c');
  for (const feature of ['apps', 'plugins', 'hooks']) assert.ok(overrides.includes(`features.${feature}=false`));
  assert.ok(overrides.includes('approval_policy="never"'));
  assert.ok(overrides.includes('web_search="disabled"'));
  assert.ok(overrides.includes('notify=[]'));
  assert.ok(args.every((arg) => !arg.startsWith('mcp_servers=')));
  assert.throws(() => buildManagerReplayIsolationArgs('unknown'));
});

test('concurrent Codex exec launches use separate homes containing only auth.json and retain model, effort and sandbox', (t) => {
  const fixture = createReplayFixture(t);
  const { results, launches } = runFakeReplays(fixture, codexConfigs);
  assert.deepEqual(results, [{ output: 'fake response' }, { output: 'fake response' }]);
  assert.equal(launches.length, 2);
  assert.equal(new Set(launches.map(({ codexHome }) => codexHome)).size, 2);
  const auth = readFileSync(join(fixture.sourceHome, 'auth.json'), 'utf8');
  for (const launch of launches) {
    const { args, cwd, codexHome, files, input } = launch;
    assert.equal(codexHome, join(cwd, 'codex-home'));
    assert.notEqual(codexHome, fixture.sourceHome);
    assert.deepEqual(files, ['auth.json']);
    assert.equal(launch.auth, auth);
    assert.equal(input, 'test prompt');
    const config = codexConfigs.find(({ model }) => model === args[2]);
    assert.ok(config);
    const isolationArgs = buildManagerReplayIsolationArgs('codex');
    assert.deepEqual(args.slice(6, 6 + isolationArgs.length), isolationArgs);
    assert.deepEqual(args.slice(0, 6), ['exec', '-m', config.model, '-s', 'read-only', '--skip-git-repo-check']);
    assert.ok(args.includes(`model_reasoning_effort=${config.reasoning_effort}`));
    assert.ok(args.some((arg) => arg.startsWith('skills.config=[') && arg.includes('enabled = false')));
    assert.deepEqual(args.slice(-3), ['-o', join(cwd, 'response.txt'), '-']);
  }
  assert.equal(readFileSync(join(fixture.sourceHome, 'auth.json'), 'utf8'), auth);
});

test('uses auth.json from ~/.codex when CODEX_HOME is unset', (t) => {
  const fixture = createReplayFixture(t);
  const { results, launches } = runFakeReplays(fixture, [codexConfigs[0]], { defaultHome: true });
  assert.deepEqual(results, [{ output: 'fake response' }]);
  assert.deepEqual(launches[0].files, ['auth.json']);
  assert.equal(launches[0].auth, readFileSync(join(fixture.defaultHome, 'auth.json'), 'utf8'));
});

test('supports authentication without auth.json while still isolating global configuration', (t) => {
  const fixture = createReplayFixture(t);
  rmSync(join(fixture.sourceHome, 'auth.json'));
  const { results, launches } = runFakeReplays(fixture, [codexConfigs[0]]);
  assert.deepEqual(results, [{ output: 'fake response' }]);
  assert.deepEqual(launches[0].files, []);
});

for (const mode of ['failure', 'hang', 'abort']) {
  test(`removes the isolated Codex home after ${mode}`, (t) => {
    const fixture = createReplayFixture(t);
    const { results, launches } = runFakeReplays(fixture, [codexConfigs[0]], {
      mode: mode === 'abort' ? 'hang' : mode, abort: mode === 'abort',
    });
    assert.equal(launches.length, 1);
    assert.match(results[0].error, mode === 'failure' ? /exited with code 9/ : mode === 'hang' ? /timed out/ : /aborted/);
    assert.equal(existsSync(join(fixture.sourceHome, 'auth.json')), true);
  });
}

test('reports auth copy errors and cleans up without launching Codex', (t) => {
  const fixture = createReplayFixture(t);
  rmSync(join(fixture.sourceHome, 'auth.json'));
  mkdirSync(join(fixture.sourceHome, 'auth.json'));
  const { results, launches } = runFakeReplays(fixture, [codexConfigs[0]]);
  assert.ok(results[0].error);
  assert.deepEqual(launches, []);
});

test('Claude ignores ambient MCP configuration while retaining the existing replay restrictions', async (t) => {
  const fixture = createReplayFixture(t);
  const config = { cli: 'claude', model: 'claude-opus-5' };
  const provider = new ManagerWorkSplitProvider({ config });
  const isolationArgs = await provider.replayIsolationArgs(fixture.root, {});
  assert.deepEqual(buildReplayCliArgs(config, fixture.root, join(fixture.root, 'response.txt'), isolationArgs), [
    '-p', '--model', 'claude-opus-5', '--tools', '', '--disable-slash-commands', '--setting-sources=project',
    '--strict-mcp-config',
  ]);
  const { results, launches } = runFakeReplays(fixture, [config]);
  assert.deepEqual(results, [{ output: 'fake response' }]);
  assert.equal(launches[0].codexHome, fixture.sourceHome);
});
