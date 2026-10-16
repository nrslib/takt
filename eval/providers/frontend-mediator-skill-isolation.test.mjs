import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Codex } from '@openai/codex-sdk';
import { parse } from 'yaml';
import FrontendMediatorCoderProvider, { buildFrontendCodexOptions } from './frontend-mediator-coder.mjs';

const artifactRoots = [];
test.afterEach(() => {
  for (const root of artifactRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestCoderProvider extends FrontendMediatorCoderProvider {
  constructor(options) {
    const artifactRoot = join(tmpdir(), `takt-coder-test-results-${randomUUID()}`);
    super({ ...options, artifactRoot });
    artifactRoots.push(artifactRoot);
  }
}

const evalDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const suite = parse(readFileSync(join(evalDirectory, 'agents/implement/frontend-mediator-coder.yaml'), 'utf8'));

function temporaryDirectory(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'frontend-mediator-isolation-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeSkill(path) {
  mkdirSync(path, { recursive: true });
  const file = join(path, 'SKILL.md');
  writeFileSync(file, '---\nname: external-coding\ndescription: External rules\n---\nDo not inherit.\n');
  return realpathSync(file);
}

function writeCodexHome(home) {
  writeSkill(join(home, 'skills/external-coding'));
  writeSkill(join(home, 'skills/.system/system-coding'));
  writeFileSync(join(home, 'auth.json'), '{"access_token":"fixture-auth"}');
  writeFileSync(join(home, 'config.toml'), 'model = "poison"');
  writeFileSync(join(home, 'AGENTS.md'), 'External user instructions');
  writeFileSync(join(home, 'history.jsonl'), 'External history');
}

for (const explicitHome of [true, false]) {
  test(`Codex copies only auth.json from ${explicitHome ? 'CODEX_HOME' : 'HOME/.codex'} into a disposable home`, t => {
    const directory = temporaryDirectory(t);
    const project = join(directory, 'project');
    mkdirSync(project);
    const sourceHome = join(directory, explicitHome ? 'custom-codex' : '.codex');
    writeCodexHome(sourceHome);
    writeSkill(join(directory, '.agents/skills/external-coding'));
    const repoSkill = writeSkill(join(project, '.agents/skills/project-coding'));
    const sourceEnv = {
      HOME: directory, PATH: '/fixture/bin', LANG: 'C', LC_ALL: 'C',
      NODE_OPTIONS: '--require=/external/hook.js', OPENAI_API_KEY: 'external-key',
      CODEX_API_KEY: 'external-key', OPENAI_BASE_URL: 'https://external.invalid',
      UNRELATED_SECRET: 'do-not-inherit',
      ...(explicitHome ? { CODEX_HOME: sourceHome } : {}),
    };
    const isolated = buildFrontendCodexOptions(project, sourceEnv);
    t.after(isolated.cleanup);
    const { options } = isolated;
    assert.deepEqual(readdirSync(options.env.CODEX_HOME), ['auth.json']);
    assert.equal(readFileSync(join(options.env.CODEX_HOME, 'auth.json'), 'utf8'),
      readFileSync(join(sourceHome, 'auth.json'), 'utf8'));
    assert.deepEqual(readdirSync(options.env.HOME), ['.codex']);
    assert.notEqual(options.env.HOME, directory);
    assert.notEqual(options.env.CODEX_HOME, sourceHome);
    assert.deepEqual(Object.keys(options.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
    assert.deepEqual(options.config.skills.config.map(entry => entry.path), [repoSkill]);
    assert.ok(options.config.skills.config.every(entry => entry.enabled === false));
    isolated.cleanup();
    assert.equal(existsSync(options.env.HOME), false);
    assert.ok(existsSync(join(sourceHome, 'auth.json')));
  });
}

test('Codex missing auth.json fails before SDK execution and removes its temporary home', async t => {
  const directory = temporaryDirectory(t);
  setEnvironment(t, { HOME: directory, CODEX_HOME: join(directory, '.codex'), TMPDIR: directory });
  const start = t.mock.method(Codex.prototype, 'startThread', () => {
    throw new Error('SDK must not execute without auth.json');
  });
  const before = readdirSync(directory);
  for (const config of [suite.providers[0].config, suite.defaultTest.options.provider.config]) {
    const provider = new TestCoderProvider({ config });
    await assert.rejects(provider.runAgent('missing auth', directory, {}, {}), /authentication requires auth\.json/);
    assert.deepEqual(readdirSync(directory), before);
  }
  assert.equal(start.mock.callCount(), 0);
});

test('implementation and rubric both execute Codex with skills disabled outside the repository', async t => {
  const directory = temporaryDirectory(t);
  const source = join(directory, 'source');
  cpSync(join(evalDirectory, 'fixtures/frontend-mediator'), source, { recursive: true });
  writeCodexHome(join(directory, '.codex'));
  const repoSkill = writeSkill(join(source, '.agents/skills/project-coding'));
  setEnvironment(t, {
    HOME: directory, CODEX_HOME: join(directory, '.codex'),
    NODE_OPTIONS: '--no-warnings', OPENAI_API_KEY: 'external-key', CODEX_API_KEY: 'external-key',
  });
  const observed = [];
  let fail = false;
  // Intercept the SDK execution boundary, so neither implementation nor rubric uses an API.
  t.mock.method(Codex.prototype, 'startThread', function (threadOptions) {
    assert.deepEqual(readdirSync(this.options.env.CODEX_HOME), ['auth.json']);
    assert.notEqual(this.options.env.HOME, directory);
    assert.notEqual(this.options.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(this.options.env.NODE_OPTIONS, undefined);
    assert.equal(this.options.env.OPENAI_API_KEY, undefined);
    assert.equal(this.options.env.CODEX_API_KEY, undefined);
    observed.push({ sdk: this.options, thread: threadOptions });
    return { id: 'fake-thread', run: async () => {
      if (fail) throw new Error('simulated SDK failure');
      return { finalResponse: 'isolated result' };
    } };
  });
  assert.equal(suite.defaultTest.options.provider.id, 'file://../../providers/frontend-mediator-coder.mjs');
  assert.equal(suite.defaultTest.options.provider.config.role, 'rubric');
  assert.equal(suite.defaultTest.options.provider.config.working_dir, '.work/frontend-mediator-implement');
  const ids = [];
  for (const shouldFail of [false, true]) {
    fail = shouldFail;
    for (const config of [suite.providers[0].config, suite.defaultTest.options.provider.config]) {
      const provider = new TestCoderProvider({ config: {
        ...config, working_dir: relative(evalDirectory, source),
      } });
      ids.push(provider.id());
      const result = await provider.callApi('check isolation', {});
      if (result.metadata?.artifactDirectory) {
        t.after(() => rmSync(result.metadata.artifactDirectory, { recursive: true, force: true }));
      }
      assert.equal(result.error, shouldFail ? 'simulated SDK failure' : undefined);
      if (config.role !== 'rubric') {
        assert.ok(existsSync(join(result.metadata.artifactDirectory, 'project/src/routes/order-edit.tsx')));
        const saved = JSON.parse(readFileSync(join(result.metadata.artifactDirectory, 'result.json'), 'utf8'));
        assert.equal(saved.error, result.error);
      }
      const { sdk, thread } = observed.at(-1);
      assert.deepEqual(sdk.config.skills.config, [{
        path: join(thread.workingDirectory, relative(source, repoSkill)), enabled: false,
      }]);
      assert.equal(thread.model, 'gpt-6-sol');
      assert.equal(thread.modelReasoningEffort, 'low');
      assert.equal(thread.sandboxMode, config.role === 'rubric' ? 'read-only' : 'workspace-write');
      assert.equal(thread.approvalPolicy, 'never');
      assert.equal(thread.networkAccessEnabled, false);
      assert.equal(thread.webSearchMode, 'disabled');
      assert.ok(!thread.workingDirectory.startsWith(repositoryDirectory));
      assert.notEqual(thread.workingDirectory, source);
      assert.equal(existsSync(thread.workingDirectory), false);
      assert.equal(existsSync(sdk.env.CODEX_HOME), false);
      assert.equal(existsSync(sdk.env.HOME), false);
      if (!shouldFail && config.role === 'rubric') assert.equal(result.output, 'isolated result');
    }
  }
  assert.equal(observed.length, 4);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(new Set(observed.map(entry => entry.thread.workingDirectory)).size, 4);
  assert.equal(new Set(observed.map(entry => entry.sdk.env.CODEX_HOME)).size, 4);
});

for (const config of [suite.providers[0].config, suite.defaultTest.options.provider.config]) {
  const role = config.role ?? 'implement';

  test(`Codex ${role} rejects missing or invalid timeout_ms before SDK execution`, async t => {
    const directory = temporaryDirectory(t);
    setEnvironment(t, { HOME: directory, CODEX_HOME: join(directory, '.codex'), TMPDIR: directory });
    const start = t.mock.method(Codex.prototype, 'startThread', () => {
      throw new Error('SDK must not execute with an invalid timeout');
    });
    const before = readdirSync(directory);
    assert.equal(config.timeout_ms, role === 'rubric' ? 300_000 : 900_000);
    for (const timeoutMs of [undefined, 0, -1, 1.5, NaN, Infinity, 2_147_483_648, '100', null]) {
      const provider = new TestCoderProvider({ config: { ...config, timeout_ms: timeoutMs } });
      await assert.rejects(provider.runAgent('invalid timeout', directory, {}, {}), /timeout_ms/);
      assert.deepEqual(readdirSync(directory), before);
    }
    assert.equal(start.mock.callCount(), 0);
  });

  test(`Codex ${role} timeout aborts a pending SDK call and removes disposable directories`, { timeout: 5_000 }, async t => {
    const directory = temporaryDirectory(t);
    const source = join(directory, 'source');
    cpSync(join(evalDirectory, 'fixtures/frontend-mediator'), source, { recursive: true });
    writeCodexHome(join(directory, '.codex'));
    setEnvironment(t, { HOME: directory, CODEX_HOME: join(directory, '.codex'), TMPDIR: directory });
    let observed;
    t.mock.method(Codex.prototype, 'startThread', function (threadOptions) {
      return { run: (_prompt, { signal }) => new Promise((_resolve, reject) => {
        observed = { env: this.options.env, cwd: threadOptions.workingDirectory, signal, aborted: false };
        assert.ok(existsSync(observed.env.HOME));
        assert.ok(existsSync(observed.env.CODEX_HOME));
        signal.addEventListener('abort', () => {
          observed.aborted = true;
          reject(new Error('SDK abort failure'));
        }, { once: true });
      }) };
    });
    const provider = new TestCoderProvider({ config: {
      ...config, working_dir: relative(evalDirectory, source), timeout_ms: 30,
    } });
    const result = await provider.callApi('timeout test', {});
    if (result.metadata?.artifactDirectory) {
      t.after(() => rmSync(result.metadata.artifactDirectory, { recursive: true, force: true }));
    }
    assert.match(result.error, /Codex timed out after 30ms/);
    assert.equal(observed.aborted, true);
    assert.equal(observed.signal.aborted, true);
    assert.equal(existsSync(observed.env.HOME), false);
    assert.equal(existsSync(observed.env.CODEX_HOME), false);
    assert.equal(existsSync(observed.cwd), false);
    assert.ok(existsSync(join(directory, '.codex/auth.json')));
  });

  test(`Codex ${role} forwards external abort and removes its disposable home`, async t => {
    const directory = temporaryDirectory(t);
    writeCodexHome(join(directory, '.codex'));
    setEnvironment(t, { HOME: directory, CODEX_HOME: join(directory, '.codex'), TMPDIR: directory });
    const external = new AbortController();
    const reason = new Error('evaluation cancelled');
    let observed;
    const start = t.mock.method(Codex.prototype, 'startThread', function () {
      return { run: (_prompt, { signal }) => new Promise((_resolve, reject) => {
        observed = { env: this.options.env, signal };
        signal.addEventListener('abort', () => reject(new Error('SDK abort failure')), { once: true });
        external.abort(reason);
      }) };
    });
    const provider = new TestCoderProvider({ config });
    await assert.rejects(provider.runAgent('external abort', directory, {}, { abortSignal: external.signal }), error => {
      assert.match(error.message, /Codex aborted/);
      assert.equal(error.cause, reason);
      return true;
    });
    assert.notEqual(observed.signal, external.signal);
    assert.equal(observed.signal.aborted, true);
    assert.equal(existsSync(observed.env.HOME), false);
    assert.equal(existsSync(observed.env.CODEX_HOME), false);
    const before = readdirSync(directory);
    await assert.rejects(provider.runAgent('already aborted', directory, {}, { abortSignal: external.signal }), /aborted before starting/);
    assert.equal(start.mock.callCount(), 1);
    assert.deepEqual(readdirSync(directory), before);
  });
}

test('Opus preserves login HOME and USER while safe mode disables customizations with an allowlisted environment', async t => {
  const directory = temporaryDirectory(t);
  const bin = join(directory, 'bin');
  const project = join(directory, 'project');
  mkdirSync(bin);
  cpSync(join(evalDirectory, 'fixtures/frontend-mediator'), project, { recursive: true });
  writeSkill(join(directory, '.claude/skills/external-coding'));
  writeFileSync(join(directory, '.claude/CLAUDE.md'), 'External user instructions');
  writeFileSync(join(directory, '.claude/settings.json'), '{"model":"poison"}');
  const executable = join(bin, 'claude');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({
  args: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt,
  userInstructions: fs.existsSync(process.env.HOME + '/.claude/CLAUDE.md'),
}) })));
`);
  chmodSync(executable, 0o755);
  setEnvironment(t, {
    PATH: `${bin}:${process.env.PATH}`, HOME: directory, USER: 'fixture-user',
    CLAUDE_CONFIG_DIR: '/external/claude-config', CLAUDE_ENV_FILE: '/external/hook.sh',
    NODE_OPTIONS: '--no-warnings', UNRELATED_SECRET: 'do-not-inherit',
    ANTHROPIC_API_KEY: 'test-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
  });
  const provider = new TestCoderProvider({ config: {
    ...suite.providers[1].config, working_dir: relative(evalDirectory, project),
  } });
  const response = await provider.callApi('isolated prompt', {});
  if (response.metadata?.artifactDirectory) {
    t.after(() => rmSync(response.metadata.artifactDirectory, { recursive: true, force: true }));
  }
  assert.equal(response.error, undefined);
  const stream = JSON.parse(readFileSync(join(response.metadata.artifactDirectory, 'claude.stdout.log'), 'utf8'));
  assert.equal(stream.type, 'result');
  assert.equal(stream.result, JSON.parse(response.output).response);
  assert.equal(readFileSync(join(response.metadata.artifactDirectory, 'claude.stderr.log'), 'utf8'), '');
  const observed = JSON.parse(JSON.parse(response.output).response);
  assert.equal(observed.prompt, 'isolated prompt');
  assert.ok(!observed.cwd.startsWith(repositoryDirectory));
  assert.notEqual(observed.cwd, project);
  assert.equal(existsSync(observed.cwd), false);
  assert.equal(observed.env.HOME, directory);
  assert.equal(observed.env.USER, 'fixture-user');
  assert.equal(observed.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(observed.userInstructions, true);
  assert.equal(observed.env.ANTHROPIC_API_KEY, 'test-api-key');
  assert.equal(observed.env.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth-token');
  const allowed = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'HOME', 'USER',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  // macOS may insert this locale variable during process startup, after execFile's env is applied.
  if (process.platform === 'darwin') allowed.add('__CF_USER_TEXT_ENCODING');
  assert.deepEqual(Object.keys(observed.env).filter(key => !allowed.has(key)), []);
  for (const flag of ['--disable-slash-commands', '--safe-mode', '--setting-sources=project',
    '--no-session-persistence', '--verbose', '--include-partial-messages']) {
    assert.ok(observed.args.includes(flag), flag);
  }
  assert.equal(observed.args[observed.args.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(observed.args[observed.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(existsSync(observed.env.HOME), true);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const loginResponse = await provider.runAgent('login without auth env', project, {}, {});
  const login = JSON.parse(loginResponse.output);
  assert.equal(login.env.HOME, directory);
  assert.equal(login.env.USER, 'fixture-user');
  assert.equal(login.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(login.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('Opus timeout preserves project and streamed logs and kills the CLI and its descendants', async t => {
  const directory = temporaryDirectory(t);
  const source = join(directory, 'source');
  cpSync(join(evalDirectory, 'fixtures/frontend-mediator'), source, { recursive: true });
  const executable = join(directory, 'claude');
  const descendantScript = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 6000); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync('descendants.json', JSON.stringify([process.pid, grandchild.pid]));
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 6000);
setInterval(() => {}, 1000);
`;
  writeFileSync(executable, `#!${process.execPath}
require('node:fs').writeFileSync('parent-pid.txt', String(process.pid));
require('node:fs').writeFileSync('src/partial.ts', 'export const partial = true;');
process.stdout.write('{"type":"stream_event","event":{"type":"message_start"}}\\n');
process.stderr.write('partial diagnostic\\n');
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 6000);
setInterval(() => {}, 1000);
`);
  chmodSync(executable, 0o755);
  setEnvironment(t, { PATH: `${directory}:${process.env.PATH}` });
  const provider = new TestCoderProvider({ config: {
    ...suite.providers[1].config, working_dir: relative(evalDirectory, source), timeout_ms: 2_000,
  } });
  assert.equal(suite.providers[1].config.timeout_ms, 1_800_000);
  let artifact;
  const runAgent = provider.runAgent;
  t.mock.method(provider, 'runAgent', function (...args) {
    artifact ??= args[3].artifactDirectory;
    return runAgent.apply(this, args);
  });
  let finished = false;
  const pending = provider.callApi('timeout test', {}).then(result => { finished = true; return result; });
  t.after(() => rmSync(artifact, { recursive: true, force: true }));
  const stdoutLog = join(artifact, 'claude.stdout.log');
  for (let attempt = 0; attempt < 100 && (!existsSync(stdoutLog) || readFileSync(stdoutLog, 'utf8') === ''); attempt++) {
    await setTimeout(10);
  }
  assert.ok(readFileSync(stdoutLog, 'utf8').includes('message_start'), 'stdout is persisted while CLI is running');
  assert.equal(finished, false);
  const result = await pending;
  assert.equal(result.metadata.artifactDirectory, artifact);
  assert.match(result.error, /timed out after 2000ms/);
  assert.equal(readFileSync(join(artifact, 'prompt.md'), 'utf8'), 'timeout test');
  assert.equal(readFileSync(join(artifact, 'project/src/partial.ts'), 'utf8'), 'export const partial = true;');
  assert.equal(readFileSync(join(artifact, 'claude.stdout.log'), 'utf8'),
    '{"type":"stream_event","event":{"type":"message_start"}}\n');
  assert.equal(readFileSync(join(artifact, 'claude.stderr.log'), 'utf8'), 'partial diagnostic\n');
  const saved = JSON.parse(readFileSync(join(artifact, 'result.json'), 'utf8'));
  assert.equal(saved.error, result.error);
  assert.equal(saved.signal, 'SIGKILL');
  assert.equal(existsSync(join(source, 'src/partial.ts')), false);
  const parent = Number(readFileSync(join(artifact, 'project/parent-pid.txt'), 'utf8'));
  const descendants = JSON.parse(readFileSync(join(artifact, 'project/descendants.json'), 'utf8'));
  const pids = [parent, ...descendants];
  t.after(() => {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  function isRunning(pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
    // Linux may retain an orphan as a zombie until its parent reaps it.
    if (process.platform === 'linux') {
      try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    return true;
  }
  for (let attempt = 0; attempt < 100 && pids.some(isRunning); attempt++) await setTimeout(20);
  assert.deepEqual(pids.filter(isRunning), [], 'CLI, child and grandchild must all stop');
  provider.config.timeout_ms = 0;
  await assert.rejects(provider.runAgent('no unlimited runs', directory, {}, {}), /positive timeout_ms/);
});

for (const mode of ['exit', 'spawn']) {
  test(`Opus ${mode} error preserves project, logs and failure result`, async t => {
    const directory = temporaryDirectory(t);
    const source = join(directory, 'source');
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    cpSync(join(evalDirectory, 'fixtures/frontend-mediator'), source, { recursive: true });
    if (mode === 'exit') {
      const executable = join(bin, 'claude');
      writeFileSync(executable, `#!${process.execPath}
require('node:fs').writeFileSync('src/partial.ts', 'export const failed = true;');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('{"type":"system","subtype":"init"}\\n');
  process.stderr.write('simulated CLI failure\\n');
  process.exitCode = 7;
});
`);
      chmodSync(executable, 0o755);
    }
    setEnvironment(t, { PATH: bin });
    const provider = new TestCoderProvider({ config: {
      ...suite.providers[1].config, working_dir: relative(evalDirectory, source),
    } });
    const result = await provider.callApi('error test', {});
    const artifact = result.metadata.artifactDirectory;
    t.after(() => rmSync(artifact, { recursive: true, force: true }));
    assert.ok(result.error);
    assert.ok(existsSync(join(artifact, 'project/src/routes/order-edit.tsx')));
    const saved = JSON.parse(readFileSync(join(artifact, 'result.json'), 'utf8'));
    assert.equal(saved.error, result.error);
    assert.equal(readFileSync(join(artifact, 'claude.stdout.log'), 'utf8'),
      mode === 'exit' ? '{"type":"system","subtype":"init"}\n' : '');
    assert.equal(readFileSync(join(artifact, 'claude.stderr.log'), 'utf8'),
      mode === 'exit' ? 'simulated CLI failure\n' : '');
    if (mode === 'exit') {
      assert.equal(readFileSync(join(artifact, 'project/src/partial.ts'), 'utf8'), 'export const failed = true;');
      assert.match(result.error, /exited with 7/);
      assert.equal(saved.exitCode, 7);
    } else {
      assert.equal(saved.code, 'ENOENT');
    }
  });
}
