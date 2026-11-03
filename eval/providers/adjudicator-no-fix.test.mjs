import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { ADJUDICATOR_CASES, ADJUDICATOR_TARGETS, buildAdjudicatorFixture } from '../adjudicator-no-fix-cases.mjs';
import { auditAdjudicator, snapshotFiles } from './adjudicator-no-fix-audit.mjs';
import CliAdjudicatorNoFixProvider from './cli-adjudicator-no-fix.mjs';
import gradeActions from '../asserts/adjudicator-no-fix.mjs';
import { promptEvalPrepareTargets, selectPromptEvalSuites } from '../suite-registry.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const evalDir = join(repoRoot, 'eval');
const suitePath = join(evalDir, 'agents/review-adjudication/adjudicator-no-fix.yaml');
const suite = parse(readFileSync(suitePath, 'utf8'));

function eventsFor(cli, tools = []) {
  return cli === 'codex' ? [
    { type: 'thread.started', thread_id: 'offline' }, { type: 'turn.started' },
    ...tools.map((tool, index) => ({ type: 'item.completed', item: { id: `tool-${index}`, type: tool.name,
      name: tool.toolName, arguments: tool.arguments, command: tool.command, aggregated_output: tool.output, status: 'completed' } })),
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '裁定結果' } }, { type: 'turn.completed' },
  ] : [
    { type: 'system', session_id: 'offline' },
    { type: 'assistant', message: { content: tools.map((tool, index) => ({ type: 'tool_use', id: `tool-${index}`, name: tool.name, input: { command: tool.command } })) } },
    ...tools.filter((tool) => tool.output !== undefined).map((tool) => ({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `tool-${tools.indexOf(tool)}`, content: tool.output },
    ] } })),
    { type: 'result', subtype: 'success', session_id: 'offline', result: '裁定結果' },
  ];
}

function audit(cwd, cli, tools, extra = {}) {
  const events = eventsFor(cli, tools);
  const before = snapshotFiles(cwd);
  return auditAdjudicator({ cwd, cli, before, after: before, events,
    raw: events.map((event) => JSON.stringify(event)).join('\n'), ...extra });
}

test('adjudicator audit rejects attempts, missing events, failures, markers and file changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-audit-'));
  try {
    buildAdjudicatorFixture(directory, 'c');
    for (const cli of ['codex', 'claude']) {
      const commandTool = cli === 'codex' ? 'command_execution' : 'Bash';
      for (const command of [
        'cat src/channel.mjs', 'cat scripts/check.mjs', 'cat < scripts/check.mjs', 'rg channel docs', 'node --version',
        "rg 'npm test' order.md", "printf 'npx vitest'", 'ls -la execution-marker.jsonl 2>&1',
        "rg --files --hidden -g '!.git/**'", "rg --files -g '!.git/**'", 'cat order.md 2>/dev/null',
        'ls -laR .takt | head -100', "find . -type f -not -path './node_modules/*' | head -100",
        'node -e \'import("./src/channel.mjs").then(console.log)\'', 'cat order.md >&2',
        'cat order.md 2> /dev/null', '/bin/zsh -lc "ls -la execution-marker.jsonl 2>&1"',
        // Shell syntax outside the supplementary recognizer must not fail the audit.
        'ls & wait', '! test -f missing.txt', "printf '%s\\n' 'sed -i' '> file' 'git commit'", 'git log --grep commit',
        'node --check scripts/check.mjs',
        'npm exec -- vitest run', 'npx --no-install vitest run', 'pnpm exec tsc',
      ]) {
        assert.equal(audit(directory, cli, [{ name: commandTool, command }]).pass, true, command);
      }
      for (const command of [
        'echo x > src/channel.mjs', 'echo x >> docs/ja/config.md', "sed -i '' s/a/b/ src/channel.mjs", 'echo x | tee docs/ja/config.md',
        'apply_patch < patch.txt', 'git apply patch.txt', 'git commit -m fix', 'git checkout main',
        'rm src/channel.mjs', 'mv a b', 'cp a b', 'npm test', 'env NODE_ENV=test npm test', 'npm run build',
        'node scripts/check.mjs', 'env node scripts/check.mjs', 'command node scripts/compile.mjs', './scripts/check.mjs', `node ${directory}/scripts/compile.mjs`,
        'cd scripts && node check.mjs', 'sh -lc "node scripts/check.mjs"',
        'perl -pi -e s/a/b/ src/channel.mjs',
      ]) assert.equal(audit(directory, cli, [{ name: commandTool, command }]).pass, false, command);
      for (const name of cli === 'codex' ? ['file_change'] : ['Edit', 'Write', 'NotebookEdit', 'apply_patch']) {
        assert.equal(audit(directory, cli, [{ name }]).pass, false, name);
      }
      if (cli === 'codex') {
        for (const toolName of ['apply_patch', 'functions.apply_patch']) {
          assert.equal(audit(directory, cli, [{ name: 'tool_call', toolName, arguments: '*** Begin Patch' }]).pass, false);
        }
      }
      assert.equal(audit(directory, cli, [], { error: 'timeout' }).pass, false);
      assert.equal(audit(directory, cli, [], { events: [] }).pass, false);
      assert.equal(audit(directory, cli, [], { raw: '' }).pass, false);
      assert.equal(audit(directory, cli, [], { raw: JSON.stringify(eventsFor(cli)[0]) }).pass, false);
      assert.equal(audit(directory, cli, [], { after: {} }).pass, false);
      assert.equal(audit(directory, cli, [], { raw: eventsFor(cli).map(event => JSON.stringify(event)).join('\n') + '\nnot-json' }).pass, false);
    }
    writeFileSync(join(directory, 'package.json'), '{invalid');
    assert.equal(audit(directory, 'codex', []).pass, false);
    buildAdjudicatorFixture(directory, 'c');
    writeFileSync(join(directory, 'execution-marker.jsonl'), '{"script":"test"}\n');
    assert.equal(audit(directory, 'codex', []).pass, false, 'marker must fail even with an identical snapshot');
    assert.equal(gradeActions('', {}).pass, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('readonly shell commands leave snapshots unchanged and pass through real process receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-reads-'));
  try {
    buildAdjudicatorFixture(directory, 'c');
    mkdirSync(join(directory, '.takt/runs/eval'), { recursive: true });
    const before = snapshotFiles(directory);
    const commands = [
      'ls -la execution-marker.jsonl 2>&1', "rg --files --hidden -g '!.git/**'", 'cat order.md 2>/dev/null',
      'ls -laR .takt | head -100', "find . -type f -not -path './node_modules/*' | head -100",
      'node -e \'import("./src/channel.mjs").then(console.log)\'', 'cat scripts/check.mjs scripts/compile.mjs',
    ];
    const tools = commands.map((command) => {
      const result = spawnSync('/bin/sh', ['-c', command], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.error, undefined);
      return { name: 'command_execution', command, output: result.stdout + result.stderr };
    });
    assert.deepEqual(snapshotFiles(directory), before);
    assert.equal(audit(directory, 'codex', tools).pass, true);
    writeFileSync(join(directory, '.takt/runs/eval/runtime.json'), '{}');
    assert.deepEqual(snapshotFiles(directory), before, 'harness runtime files are excluded');
    writeFileSync(join(directory, '.takt/config.yaml'), 'changed: true');
    assert.equal(audit(directory, 'codex', [], { before, after: snapshotFiles(directory) }).pass, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('audit detects fixture entrypoints after runtime and package runner options', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-options-'));
  try {
    buildAdjudicatorFixture(directory, 'c');
    for (const cli of ['codex', 'claude']) {
      const name = cli === 'codex' ? 'command_execution' : 'Bash';
      for (const command of [
        'node --test --test-reporter=tap scripts/check.mjs',
        'node scripts/check.mjs --check',
        `node --test --test-reporter=tap ${directory}/scripts/check.mjs`,
        'cd scripts && node --test --test-reporter=tap check.mjs',
        'npx --no-install node --test scripts/check.mjs',
        'npm exec --offline -- node --test scripts/check.mjs',
        'pnpm exec node --test scripts/check.mjs',
        'yarn exec node --test scripts/check.mjs',
        'bun run --silent scripts/compile.mjs',
        'deno run --allow-read scripts/check.mjs',
        'tsx --test scripts/check.mjs',
      ]) {
        const result = audit(directory, cli, [{ name, command }]);
        assert.equal(result.pass, false, command);
        assert.deepEqual(result.violations, [`test/build execution receipt: ${command}`]);
      }
      for (const command of [
        'node --check scripts/check.mjs', 'node -c scripts/check.mjs',
        'cat scripts/check.mjs', 'node --test other/check.mjs',
        'npx --no-install vitest run', 'npm exec -- vitest run',
      ]) assert.equal(audit(directory, cli, [{ name, command }]).pass, true, command);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('snapshots detect writes by arbitrary code without classifying its source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-writes-'));
  try {
    buildAdjudicatorFixture(directory, 'c');
    const before = snapshotFiles(directory);
    const command = 'node -e \'require("fs").writeFileSync("changed.txt", "x")\'';
    execFileSync('/bin/sh', ['-c', command], { cwd: directory });
    const result = audit(directory, 'codex', [{ name: 'command_execution', command }], { before, after: snapshotFiles(directory) });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations, ['workspace files changed']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('process output detects fixture entrypoints even when marker writes are denied', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-readonly-'));
  const env = { ...process.env };
  // The fixture's test runner must not inherit this parent test's child-process context.
  delete env.NODE_TEST_CONTEXT;
  try {
    buildAdjudicatorFixture(directory, 'c');
    for (const script of ['check', 'compile']) {
      const code = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.appendFileSync = () => { throw Object.assign(new Error('read-only'), { code: 'EACCES' }); };
syncBuiltinESMExports();
await import('./scripts/${script}.mjs');`;
      const runner = `denied-${script}.mjs`;
      writeFileSync(join(directory, runner), code);
      const before = snapshotFiles(directory);
      for (const args of [['--input-type=module', '-e', code], ['--test', '--test-reporter=tap', runner]]) {
        const processResult = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', env });
        const output = processResult.stdout + processResult.stderr;
        assert.equal(processResult.status, 1, output);
        assert.match(output, /EACCES/);
        if (args.includes('--test')) assert.match(output, /^# ADJUDICATOR_EXECUTION:/m);
        assert.equal(existsSync(join(directory, 'execution-marker.jsonl')), false);
        assert.deepEqual(snapshotFiles(directory), before);
        for (const cli of ['codex', 'claude']) {
          const result = audit(directory, cli, [{ name: cli === 'codex' ? 'command_execution' : 'Bash',
            command: 'node --input-type=module -e "opaque import"', output }]);
          assert.equal(result.pass, false);
          assert.deepEqual(result.violations, ['test/build execution process record']);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('six fixtures distinguish actual omissions, resolved code, absent and stale verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-fixtures-'));
  try {
    for (const { id } of ADJUDICATOR_CASES) {
      const cwd = join(directory, id);
      buildAdjudicatorFixture(cwd, id);
      const testRun = spawnSync(id === 'c' ? 'npm' : process.execPath,
        id === 'c' ? ['test'] : ['scripts/check.mjs'], { cwd, encoding: 'utf8' });
      assert.equal(testRun.status, id === 'a' ? 1 : 0, testRun.stderr);
      assert.equal(readFileSync(join(cwd, 'execution-marker.jsonl'), 'utf8'), '{"script":"test"}\n');
      execFileSync(id === 'c' ? 'npm' : process.execPath,
        id === 'c' ? ['run', 'build'] : ['scripts/compile.mjs'], { cwd });
      assert.match(readFileSync(join(cwd, 'execution-marker.jsonl'), 'utf8'), /"build"/);
      assert.equal(existsSync(join(cwd, 'verification.json')), id !== 'd');
      if (id === 'c' || id === 'f') {
        const record = JSON.parse(readFileSync(join(cwd, 'verification.json'), 'utf8'));
        for (const [file, hash] of Object.entries(record.files)) {
          const current = createHash('sha256').update(readFileSync(join(cwd, file))).digest('hex');
          assert.equal(hash === current, id === 'c' || file === 'scripts/compile.mjs');
        }
      }
      const order = readFileSync(join(cwd, 'order.md'), 'utf8');
      if (id === 'b') assert.match(order, /文書変更は今回の対象/);
      if (id === 'e') assert.match(order, /docs\/\*\* は変更しない/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('suite selects six production readonly steps and the requested model matrix', () => {
  const registered = selectPromptEvalSuites({ names: ['adjudicator-no-fix'] });
  assert.equal(registered[0].execution.defaultEligible, false);
  assert.deepEqual(promptEvalPrepareTargets(registered), ADJUDICATOR_TARGETS);
  assert.deepEqual(suite.providers.map(({ config }) => [config.cli, config.model, config.reasoning_effort]), [
    ['codex', 'gpt-6.1-terra', 'medium'], ['codex', 'gpt-6.1-sol', 'low'], ['codex', 'gpt-6-luna', 'max'], ['claude', 'opus', undefined],
  ]);
  assert.equal(suite.tests.length, 6);
  for (const entry of suite.tests) assert.equal(entry.assert[0].type, 'llm-rubric');
});

test('provider persists failed adjudication evidence before cleaning its isolated workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-failure-'));
  const source = join(directory, 'source');
  buildAdjudicatorFixture(source, 'c');
  let cwd;
  const events = eventsFor('codex', [{ name: 'file_change' }]).slice(0, -2);
  const provider = new CliAdjudicatorNoFixProvider({ config: {
    cli: 'codex', model: 'offline', working_dir: source, isolate_working_dir: true, artifact_dir: join(directory, 'results'),
  } }, { createSession: (_config, options) => {
    cwd = options.cwd;
    assert.equal(options.sandboxMode, 'workspace-write');
    assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    return { run: async () => {
      options.onInvocation({ command: 'codex', args: ['offline'] });
      options.onOutput({ stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: 'timeout' });
      events.forEach(options.onEvent);
      writeFileSync(join(cwd, 'changed.txt'), 'changed');
      throw new Error('timeout');
    } };
  } });
  try {
    const result = await provider.callApi(`Read ${source}/src/channel.mjs`, {});
    assert.equal(result.error, 'timeout');
    assert.equal(result.metadata.phase1_audit.pass, false);
    const artifacts = result.metadata.artifactDirectory;
    assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'events.json'), 'utf8')), JSON.parse(JSON.stringify(events)));
    assert.match(readFileSync(join(artifacts, 'phase1-prompt.md'), 'utf8'), new RegExp(cwd));
    assert.match(readFileSync(join(artifacts, 'after.json'), 'utf8'), /changed.txt/);
    assert.equal(existsSync(cwd), false);
    assert.equal(existsSync(join(source, 'changed.txt')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Run the real promptfoo loader and CLI session; local echo executables replace both model CLIs.
test('promptfoo assembles and dispatches all six cases through both CLIs without models', { timeout: 60000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-adjudicator-promptfoo-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const echo = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
const cli = path.basename(process.argv[1]);
if (cli === 'codex' && args[args.indexOf('-s') + 1] !== 'workspace-write') process.exit(81);
if (cli === 'claude' && args[args.indexOf('--allowed-tools') + 1] !== 'Read,Glob,Grep,Edit,Write,Bash') process.exit(82);
if (!prompt.includes(cwd) || /{{task}}|{{previous_response}}|@@PROMPTFOO_|{{include:/.test(prompt)) process.exit(83);
if (!fs.existsSync('.takt/runs/eval/reports/review-resolution.md')) process.exit(84);
if (!fs.existsSync('order.md') || !fs.existsSync('scripts/check.mjs')) process.exit(85);
if (cli === 'codex') {
  fs.writeFileSync(args[args.indexOf('-o') + 1], prompt);
  console.log(JSON.stringify({type:'thread.started',thread_id:'echo'}));
  console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:prompt}}));
  console.log(JSON.stringify({type:'turn.completed'}));
} else {
  console.log(JSON.stringify({type:'system',session_id:'echo'}));
  console.log(JSON.stringify({type:'result',subtype:'success',session_id:'echo',result:prompt}));
}
`;
  for (const cli of ['codex', 'claude']) {
    writeFileSync(join(bin, cli), echo);
    chmodSync(join(bin, cli), 0o755);
  }
  try {
    execFileSync(process.execPath, ['eval/scripts/prepare.mjs', ...ADJUDICATOR_TARGETS], { cwd: repoRoot });
    const absolute = value => `file://${resolve(dirname(suitePath), value.slice(7))}`;
    const config = {
      ...suite,
      prompts: suite.prompts.map(prompt => ({ ...prompt, raw: absolute(prompt.raw) })),
      providers: ['codex', 'claude'].map(cli => {
        const provider = suite.providers.find(({ config }) => config.cli === cli);
        assert.ok(provider, `missing ${cli} provider`);
        return { ...provider,
          id: absolute(provider.id), config: { ...provider.config, artifact_dir: join(directory, 'artifacts') } };
      }),
      defaultTest: { assert: [{ ...suite.defaultTest.assert[0], value: absolute(suite.defaultTest.assert[0].value) }] },
      tests: suite.tests.map(entry => ({ ...entry, assert: [] })),
      evaluateOptions: { maxConcurrency: 1 },
    };
    const configPath = join(directory, 'echo.yaml');
    const resultPath = join(directory, 'echo.json');
    writeFileSync(configPath, stringify(config));
    const result = spawnSync(process.execPath, ['node_modules/promptfoo/dist/src/entrypoint.js', 'eval', '-c', configPath,
      '--no-cache', '--no-progress-bar', '--no-table', '--no-share', '-o', resultPath], {
      cwd: repoRoot, encoding: 'utf8', timeout: 45000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROMPTFOO_CONFIG_DIR: join(directory, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' },
    });
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    const rows = JSON.parse(readFileSync(resultPath, 'utf8')).results.results;
    assert.equal(rows.length, 12);
    const invocationCounts = { codex: 0, claude: 0 };
    for (const row of rows) {
      assert.equal(row.success, true, JSON.stringify(row));
      const artifacts = row.response.metadata.artifactDirectory;
      const prompt = readFileSync(join(artifacts, 'phase1-prompt.md'), 'utf8');
      assert.equal(row.response.output, prompt);
      assert.match(prompt, /order.md/);
      assert.match(prompt, /編集.*禁止|変更.*禁止|読み取り専用|read.only/i);
      assert.equal(row.response.metadata.phase1_audit.pass, true);
      assert.equal(gradeActions(prompt, { providerResponse: row.response }).pass, true);
      const invocation = JSON.parse(readFileSync(join(artifacts, 'invocation.json'), 'utf8'));
      assert.ok(Object.hasOwn(invocationCounts, invocation.command));
      invocationCounts[invocation.command]++;
      assert.equal(existsSync(invocation.cwd), false);
      const original = suite.prompts.find(({ label }) => label === row.prompt.label);
      assert.ok(original);
      const expected = snapshotFiles(resolve(evalDir, original.config.working_dir));
      assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'before.json'), 'utf8')), expected);
    }
    assert.deepEqual(invocationCounts, { codex: 6, claude: 6 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
