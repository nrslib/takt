import { parse } from 'yaml';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import buildPrompt from '../phase1-execution-log-prompt.mjs';
import { middleObservation } from '../phase1-execution-log-fixtures.mjs';
import Phase1ExecutionLogProvider, { executionReference } from './phase1-execution-log.mjs';
import { createCliReviewSession } from './cli-review.mjs';
import { auditPhase2, classifyReadCommand } from './phase1-execution-log-audit.mjs';
import gradePhase2 from '../asserts/phase1-execution-log.mjs';
import { Phase1ExecutionLog } from '../../dist/core/workflow/phase1-execution-log.js';

const vars = {
  task: '実際の確認範囲を報告する。', last_response: 'Current work summary',
  phase1_log: JSON.stringify([{ kind: 'attempt_result', status: 'done', content: 'Verified a current file.' }]),
};
const providerConfig = { cli: 'codex', model: 'offline', isolate_working_dir: true };
const promptConfig = { working_dir: 'fixtures/phase2-report-access' };
const sourceDirectory = fileURLToPath(new URL('../fixtures/phase2-report-access', import.meta.url));

function promptFor(vars) {
  return buildPrompt({ vars, provider: { id: 'phase1-execution-log:codex:offline', label: 'offline' }, config: promptConfig });
}
function codexEvents(tools = [], answer = '# Report') {
  return [
    { type: 'thread.started', thread_id: 'session-1' },
    ...tools.map((item) => ({ type: 'item.completed', item })),
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: answer } },
    { type: 'turn.completed' },
  ];
}

test('takes the working directory from promptfoo prompt config without provider settings', () => {
  const config = { working_dir: 'fixtures/remediation-evidence' };
  const prompt = buildPrompt({ vars, config, provider: { id: 'echo', label: 'echo' } });
  const cwd = fileURLToPath(new URL('../fixtures/remediation-evidence', import.meta.url));
  assert.equal(prompt.match(/^- 作業ディレクトリ: (.+)$/m)?.[1], cwd);
  assert.ok(prompt.includes(join(cwd, '.takt/reports')));
});

test('rejects missing working_dir in promptfoo prompt config', () => {
  assert.throws(() => buildPrompt({ vars, config: {}, provider: { id: 'echo' } }), /working_dir/);
});

for (const language of ['ja', 'en']) {
  test(`sends one ${language} Phase 2 instruction and keeps raw events until cleanup`, async () => {
    const prompt = promptFor({ ...vars, language });
    assert.ok(prompt.includes(sourceDirectory));
    assert.equal(prompt.includes('/fixture/'), false);
    const inputs = [];
    let isolatedDirectory;
    const provider = new Phase1ExecutionLogProvider({ config: providerConfig }, {
      createCliReviewSession: ({ cli }, { cwd, onEvent }) => ({ run: async (input) => {
        assert.equal(cli, 'codex');
        isolatedDirectory = cwd;
        assert.notEqual(cwd, sourceDirectory);
        const workingDirectory = input.match(/^- (?:Working Directory|作業ディレクトリ): (.+)$/m)?.[1];
        assert.equal(workingDirectory, cwd);
        assert.ok(input.includes(join(cwd, '.takt/reports')));
        assert.equal(readFileSync(join(workingDirectory, 'package.json'), 'utf8'), readFileSync(join(sourceDirectory, 'package.json'), 'utf8'));
        inputs.push(input);
        codexEvents().forEach(onEvent);
        return '# Report';
      } }),
    });
    const result = await provider.callApi(prompt, { vars, prompt: { config: promptConfig } });
    assert.equal(result.output, '# Report');
    assert.equal(result.metadata.phase2_audit.pass, true);
    assert.deepEqual(result.metadata.phase2_events, codexEvents());
    assert.deepEqual(inputs, [prompt.replaceAll(sourceDirectory, isolatedDirectory)]);
    assert.equal(existsSync(isolatedDirectory), false);
  });
}

test('uses the same session for carryover preparation and one Phase 2 instruction', async () => {
  const inputs = [];
  const provider = new Phase1ExecutionLogProvider({ config: providerConfig }, {
    createCliReviewSession: (_config, { onEvent }) => ({ run: async (input) => {
      inputs.push(input);
      const answer = inputs.length === 1 ? 'テストは未実行です。次はテストを流す。' : '# Report\nテストは未実行';
      codexEvents([], answer).forEach(onEvent);
      return answer;
    } }),
  });
  const carryover = 'Phase 1 session preparation';
  const result = await provider.callApi(promptFor(vars), {
    vars: { ...vars, phase1_session_prompt: carryover }, prompt: { config: promptConfig },
  });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0], carryover);
  assert.equal(result.metadata.resumed, true);
  assert.equal(result.metadata.phase2_events.length, codexEvents().length);
  assert.equal(gradePhase2(result.output, { vars: { phase1_session_prompt: carryover }, providerResponse: result }).pass, true);
});

test('large case hides its only current observation in a multi-megabyte, chunked tool result', () => {
  const prompt = promptFor({ ...vars, phase1_log: '[]', large_record: true });
  assert.equal(prompt.includes(middleObservation), false);
  const reference = executionReference(prompt);
  const content = readFileSync(reference.path, 'utf8');
  const offset = content.indexOf(middleObservation);
  assert.ok(reference.byteSize > 2_000_000);
  assert.ok(offset > content.length * 0.4 && offset < content.length * 0.6);
  const lines = content.trim().split('\n');
  assert.ok(lines.length > 1000);
  assert.ok(lines.every((line) => line.length < 3000));
  assert.ok(lines.some((line) => JSON.parse(line).kind === 'content_chunk' && line.includes(middleObservation)));
  assert.equal(gradePhase2('未確認', { vars: { large_record: true }, providerResponse: { metadata: { phase2_audit: { pass: true } } } }).pass, false);
  assert.equal(gradePhase2('OBS-7c39b2、current.ts:42、有効レコード数は17件', { vars: { large_record: true }, providerResponse: { metadata: { phase2_audit: { pass: true } } } }).pass, true);
});

const record = new Phase1ExecutionLog();
record.recordInstruction('initial', { systemPrompt: 'Reviewer', userInstruction: 'Review current work' });
record.markDispatched();
record.recordEvent({ type: 'tool_result', data: { id: 'read', content: 'current evidence', isError: false } });
record.recordResult({ status: 'done', content: 'あ'.repeat(30000) });
const recordContent = record.toReportInput();
const recordRows = recordContent.trimEnd().split('\n');
const evidence = `${recordRows[1]}\n`;
const reference = { path: '/logs/phase1.jsonl', byteSize: Buffer.byteLength(recordContent) };
function audit(tools, before = {}, after = {}) {
  return auditPhase2({ events: codexEvents(tools), cli: 'codex', reference, cwd: sourceDirectory, before, after });
}
function command(command, output = 'bounded evidence') {
  return { id: 'command-1', type: 'command_execution', command, aggregated_output: output, status: 'completed' };
}
function claudeEvents(name, input, content = evidence, id = 'r') {
  return [
    { type: 'system', session_id: 'claude-session' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
    { type: 'result', subtype: 'success', result: '# Report' },
  ];
}

test('promptfoo renders all seven cases for every provider and rewrites paths to the actual isolated directory without a model', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-phase1-log-promptfoo-'));
  const configUrl = new URL('../agents/implement/phase1-execution-log-handoff.yaml', import.meta.url);
  const suite = parse(readFileSync(configUrl, 'utf8'));
  const cases = parse(readFileSync(new URL(suite.tests.slice(7), configUrl), 'utf8'));
  const providerPath = join(directory, 'echo-phase2.mjs');
  const configPath = join(directory, 'config.json');
  const resultPath = join(directory, 'result.json');
  try {
    // Keep the real provider's config merge, isolation, rewrite, audit and cleanup; only replace the model session.
    writeFileSync(providerPath, `
      import assert from 'node:assert/strict';
      import Provider from ${JSON.stringify(new URL('./phase1-execution-log.mjs', import.meta.url).href)};
      export default class EchoPhase2 extends Provider {
        constructor(options) {
          super(options, {
            createCliReviewSession: (config, { cwd, onEvent }) => ({ run: async (input) => {
              const workingDirectory = input.match(/^- 作業ディレクトリ: (.+)$/m)?.[1];
              if (workingDirectory !== undefined) {
                assert.equal(workingDirectory, cwd);
                assert.ok(input.includes(cwd + '/.takt/reports'));
              }
              const events = config.cli === 'codex'
                ? [{ type: 'thread.started', thread_id: 'echo' },
                   { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: input } },
                   { type: 'turn.completed' }]
                : [{ type: 'system', session_id: 'echo' }, { type: 'result', subtype: 'success', result: input }];
              events.forEach(onEvent);
              return input;
            } }),
          });
        }
      }
    `);
    writeFileSync(configPath, JSON.stringify({
      ...suite,
      prompts: suite.prompts.map((prompt) => ({ ...prompt, raw: `file://${fileURLToPath(new URL(prompt.raw.slice(7), configUrl))}` })),
      providers: suite.providers.map((provider) => ({ ...provider, id: `file://${providerPath}` })),
      defaultTest: {},
      tests: cases.map(({ description, vars }) => ({ description, vars })),
    }));
    const evaluation = spawnSync(process.execPath, [
      'node_modules/promptfoo/dist/src/entrypoint.js', 'eval', '-c', configPath,
      '--no-cache', '--no-progress-bar', '--no-table', '--no-share', '-o', resultPath,
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PROMPTFOO_CONFIG_DIR: join(directory, 'promptfoo'), PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' },
    });
    assert.equal(evaluation.status, 0, evaluation.error?.message ?? evaluation.stderr + evaluation.stdout);
    const { results } = JSON.parse(readFileSync(resultPath, 'utf8')).results;
    assert.equal(results.length, 21);
    assert.deepEqual(new Set(results.map((result) => result.testCase.description)), new Set(cases.map((entry) => entry.description)));
    assert.deepEqual(new Set(results.map((result) => result.provider.label)), new Set(suite.providers.map((provider) => provider.label)));
    for (const result of results) {
      assert.equal(result.success, true, result.error);
      const { output, metadata } = result.response;
      const cwd = output.match(/^- 作業ディレクトリ: (.+)$/m)?.[1];
      assert.ok(cwd);
      assert.notEqual(cwd, sourceDirectory);
      assert.ok(output.includes(join(cwd, '.takt/reports')));
      assert.equal(output.includes(sourceDirectory), false);
      assert.equal(output.includes('/fixture/'), false);
      assert.equal(existsSync(cwd), false);
      assert.equal(metadata.phase2_audit.pass, true);
      const reference = executionReference(output);
      assert.ok(reference.byteSize > 0);
      assert.equal(existsSync(reference.path), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function auditClaude(events) {
  return auditPhase2({ events, cli: 'claude', reference, cwd: sourceDirectory, before: {}, after: {} });
}

test('Claude handoff caller allows the production read tools through the actual CLI session', async () => {
  const invocations = [];
  const provider = new Phase1ExecutionLogProvider({ config: { ...providerConfig, cli: 'claude' } }, {
    createCliReviewSession: (config, options) => createCliReviewSession(config, {
      ...options,
      processRunner: async (cli, args) => {
        invocations.push({ cli, args });
        return claudeEvents('Bash', { command: 'cat package.json' }, 'fixture metadata')
          .map((event) => JSON.stringify(event)).join('\n');
      },
    }),
  });
  const result = await provider.callApi(promptFor(vars), {
    vars: { ...vars, phase1_session_prompt: 'Prepare Phase 1' }, prompt: { config: promptConfig },
  });
  assert.equal(result.metadata.phase2_audit.pass, true, result.error);
  assert.equal(invocations.length, 2);
  for (const { cli, args } of invocations) {
    assert.equal(cli, 'claude');
    assert.equal(args[args.indexOf('--allowed-tools') + 1], 'Read,Glob,Grep,Bash');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  }
});

for (const input of [
  'node app.test.mjs', 'node build.mjs', 'node ./build.mjs',
  `node ${join(sourceDirectory, 'build.mjs')}`, 'bun app.test.mjs',
  '/bin/zsh -lc "node build.mjs"', 'cd . && node build.mjs',
  'cd .. && node phase2-report-access/build.mjs',
]) {
  test(`rejects direct fixture entrypoint execution even with a refused write: ${input}`, () => {
    const result = audit([{ ...command(input, 'Permission denied'), status: 'failed' }]);
    assert.equal(result.pass, false);
    assert.ok(result.violations.includes('test/build attempt'));
    assert.equal(auditClaude(claudeEvents('Bash', { command: input }, 'Permission denied')).pass, false);
  });
}

test('derives direct execution entrypoints from fixture scripts rather than fixed filenames', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phase2-entrypoints-'));
  try {
    writeFileSync(join(cwd, 'verify.mjs'), '');
    writeFileSync(join(cwd, 'bundle.mjs'), '');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: {
      test: 'node --test verify.mjs', build: 'node bundle.mjs',
    } }));
    for (const commandText of ['node verify.mjs', 'node bundle.mjs', 'cat verify.mjs bundle.mjs']) {
      const result = auditPhase2({ events: codexEvents([command(commandText)]), cli: 'codex', reference, cwd, before: {}, after: {} });
      assert.equal(result.pass, commandText.startsWith('cat'), commandText);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const input of [
  'npm test', 'npm run build', 'npm install', 'pnpm run test:unit', 'yarn build',
  'npx vitest', 'vitest run', 'node --test', './test.sh',
  'touch changed', 'rm file', 'mv file other', 'git commit -m report', 'git -C /project commit -m report',
  'cat file > copy', 'cat file >> copy', 'rg -n needle file | tee copy', 'sed -i s/a/b/ file',
  `python3 -c 'open(p, "w").write("changed")'`,
  `python3 -c 'open(p, "r+")'`,
  `node -e 'require("fs").writeFileSync("file", "changed")'`,
  `node -e 'require("fs").openSync("file", "w")'`,
  'rg -n needle file | npm test',
]) {
  test(`rejects identifiable test/build/install/write execution: ${input}`, () => assert.equal(audit([command(input)]).pass, false));
}
for (const input of [
  "rg -n 'npm test' /logs/phase1.jsonl",
  "rg -n 'current\\.ts|attempt_result' /logs/phase1.jsonl",
  "sed -n '1323,1326p' /logs/phase1.jsonl",
  "rg -n 'current\\.ts|attempt_result' /logs/phase1.jsonl | tail -n 30",
  'head -n 5 file', 'tail -c 1024 file', 'wc -l file', "cat file | sed -n '2,5p'",
  `python3 -c 'import json; p="/logs/phase1.jsonl"; print([json.loads(line) for line in open(p)][1322:1326])'`,
  `python3 -c 'p="/logs/phase1.jsonl"; print(open(p, "r").readlines()[1322:1326])'`,
  `node -e 'const fs = require("fs"); console.log(fs.readFileSync("file", "utf8").split("\\n").slice(1, 5))'`,
  'python3 script.py', '/tmp/rg pattern file', 'unknown-reader file',
  'git grep commit', 'npm view build',
  '/bin/zsh -lc "rg -n observation /logs/phase1.jsonl"',
]) {
  test(`accepts reading or unclassified execution: ${input}`, () => {
    assert.equal(classifyReadCommand(input), undefined);
    assert.equal(audit([command(input)]).pass, true);
    assert.equal(auditClaude(claudeEvents('Bash', { command: input }, 'bounded evidence')).pass, true);
  });
}

test('rejects forbidden tools even if sandbox refused the attempted write', () => {
  assert.equal(audit([{ id: 'w', type: 'file_change', changes: [], status: 'failed' }]).pass, false);
});

test('judges whole record retrieval from returned rows rather than the read command', () => {
  for (const input of ['cat /logs/phase1.jsonl', 'cat /logs/phase1.jsonl; pwd', 'head -n 100 /logs/phase1.jsonl']) {
    assert.equal(audit([command(input, evidence)]).pass, true);
    assert.equal(audit([command(input, recordContent)]).pass, false);
  }
  const partial = `${recordRows.at(-1)}\n`;
  const commands = Array.from({ length: Math.ceil(reference.byteSize / Buffer.byteLength(partial)) }, (_, id) => ({
    ...command("sed -n '1,10p' /logs/phase1.jsonl", partial), id: String(id),
  }));
  const result = audit(commands);
  assert.equal(result.pass, false);
  assert.equal(result.returnedBytes, commands.length * Buffer.byteLength(partial));
  assert.ok(result.violations.includes('whole record equivalent returned'));
  assert.equal(audit([command('rg -n needle /logs/phase1.jsonl', evidence)]).pass, true);
});

test('permits complete small records and rejects only more than half of a large record', () => {
  const outputOfSize = (bytes) => {
    const entry = { kind: 'attempt_result', status: 'done', content: '' };
    entry.content = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(entry) + '\n'));
    return JSON.stringify(entry) + '\n';
  };
  for (const [recordBytes, returnedBytes, pass] of [
    [1024, 1024, true],
    [64 * 1024, 64 * 1024, true],
    [64 * 1024 + 1, 64 * 1024 + 1, false],
    [128 * 1024, 64 * 1024 - 1, true],
    [128 * 1024, 64 * 1024, true],
    [128 * 1024, 64 * 1024 + 1, false],
  ]) {
    const output = outputOfSize(returnedBytes);
    for (const [cli, events] of [
      ['codex', codexEvents([command('cat /logs/phase1.jsonl', output)])],
      ['claude', claudeEvents('Bash', { command: 'cat /logs/phase1.jsonl' }, output)],
    ]) {
      const result = auditPhase2({ events, cli, reference: { ...reference, byteSize: recordBytes }, before: {}, after: {} });
      assert.equal(result.returnedBytes, returnedBytes);
      assert.equal(result.pass, pass, `${cli}: ${returnedBytes}/${recordBytes}`);
    }
  }
});

test('Codex counts returned JSONL rows through directories, wildcards, relative paths and aliases', () => {
  const output = recordRows.map((line, index) => `/logs/phase1.jsonl:${index + 1}:${line}`).join('\r\n');
  for (const input of ['rg -n . /logs', 'rg -n . /logs/*.jsonl', 'head -n 100 phase1.jsonl',
    'head -n 100 ./phase1.jsonl', 'head -n 100 ../logs/phase1.jsonl', 'head -n 100 /copy/aliased.jsonl']) {
    const result = audit([command(input, output)]);
    assert.equal(result.pass, false);
    assert.equal(result.returnedBytes, reference.byteSize);
    assert.ok(result.violations.includes('whole record equivalent returned'));
    const bounded = audit([command(input, evidence)]);
    assert.equal(bounded.pass, true);
    assert.equal(bounded.returnedBytes, Buffer.byteLength(evidence));
  }
});

test('Claude audit counts returned rows and matches results with their read calls', () => {
  const run = (name, input, content = evidence) => auditClaude(claudeEvents(name, input, content));
  assert.equal(run('Read', { file_path: reference.path }).pass, true);
  assert.equal(run('Read', { file_path: reference.path, offset: 10, limit: 5 }).pass, true);
  assert.equal(run('Read', { file_path: '/copy/alias.jsonl' }).pass, true);
  assert.equal(run('Read', { file_path: reference.path, limit: 5 }, recordContent).pass, false);
  assert.equal(run('Write', { file_path: 'new', content: 'data' }).pass, false);
  for (const name of ['Read', 'Grep']) {
    const inputFor = (path) => name === 'Read' ? { file_path: path, limit: 5 } : { path, pattern: 'needle' };
    const other = claudeEvents(name, inputFor('/project/phase1.jsonl'), 'unrelated output');
    const log = claudeEvents(name, inputFor('./phase1.jsonl'), [{ type: 'text', text: evidence }], 'record');
    const result = auditClaude([...other.slice(0, 2), log[1], log[2], ...other.slice(2)]);
    assert.equal(result.pass, true);
    assert.equal(result.returnedBytes, Buffer.byteLength(evidence));
    assert.equal(run(name, inputFor(reference.path), recordContent).pass, false);
  }
  const unmatched = claudeEvents('Read', { file_path: reference.path, limit: 1 });
  unmatched[2].message.content[0].tool_use_id = 'unknown';
  assert.equal(auditClaude(unmatched).pass, false);
});

test('Claude counts every returned JSONL row through directory and wildcard searches and numbered Reads', () => {
  for (const [name, input, prefix] of [
    ['Grep', { path: '/logs', pattern: '.', output_mode: 'content' }, (index) => `/logs/phase1.jsonl:${index + 1}:`],
    ['Grep', { path: '/logs', glob: '*.jsonl', pattern: '.', output_mode: 'content' }, (index) => `${index + 1}-`],
    ['Read', { file_path: '/copy/alias.jsonl', limit: 100 }, (index) => `   ${index + 1}→\t`],
  ]) {
    const output = recordRows.map((row, index) => prefix(index) + row).join('\n');
    for (const content of [output, [{ type: 'text', text: output }]]) {
      const result = auditClaude(claudeEvents(name, input, content));
      assert.equal(result.pass, false);
      assert.equal(result.returnedBytes, reference.byteSize);
      assert.ok(result.violations.includes('whole record equivalent returned'));
    }
    const bounded = auditClaude(claudeEvents(name, input, prefix(1) + evidence));
    assert.equal(bounded.pass, true);
    assert.equal(bounded.returnedBytes, Buffer.byteLength(evidence));
  }
});

test('Claude counts repeated results, including overlapping text blocks, cumulatively', () => {
  const call = claudeEvents('Read', { file_path: reference.path, limit: 100 }, [
    { type: 'text', text: recordContent }, { type: 'text', text: evidence },
  ]);
  const result = auditClaude([...call.slice(0, 3), call[2], call[3]]);
  assert.equal(result.pass, false);
  assert.equal(result.returnedBytes, 2 * (reference.byteSize + Buffer.byteLength(evidence)));
});

test('ignores unrelated and unidentifiable output regardless of its size or requested path', () => {
  for (const output of ['x'.repeat(reference.byteSize), JSON.stringify({ unrelated: 'x'.repeat(reference.byteSize) }),
    recordContent.replaceAll('"kind":', '"unknown":')]) {
    const codex = audit([command('rg -n . /project', output)]);
    const claude = auditClaude(claudeEvents('Grep', { path: '/project', pattern: '.' }, output));
    for (const result of [codex, claude]) {
      assert.equal(result.pass, true);
      assert.equal(result.returnedBytes, 0);
      assert.deepEqual(result.violations, []);
    }
  }
  const partial = 'x'.repeat(Math.ceil(reference.byteSize / 2));
  const calls = [0, 1].map((id) => ({ ...command('head -n 20 /project/file', partial), id: String(id) }));
  assert.equal(audit(calls.slice(0, 1)).pass, true);
  assert.equal(audit(calls).pass, true);
  const mixed = evidence + 'x'.repeat(reference.byteSize);
  for (const result of [audit([command('rg -n . /logs', mixed)]),
    auditClaude(claudeEvents('Grep', { path: '/logs', pattern: '.' }, mixed))]) {
    assert.equal(result.pass, true);
    assert.equal(result.returnedBytes, Buffer.byteLength(evidence));
  }
});

test('reading package.json does not count toward retrieval of a short execution record', () => {
  const output = readFileSync(join(sourceDirectory, 'package.json'), 'utf8');
  const shortReference = { path: reference.path, byteSize: Buffer.byteLength(vars.phase1_log + '\n') };
  assert.ok(Buffer.byteLength(output) > shortReference.byteSize);
  for (const [cli, events] of [
    ['codex', codexEvents([command('cat package.json', output)])],
    ['claude', claudeEvents('Read', { file_path: '/project/package.json' }, output)],
  ]) {
    const result = auditPhase2({ events, cli, reference: shortReference, before: {}, after: {} });
    assert.equal(result.pass, true);
    assert.equal(result.returnedBytes, 0);
    assert.deepEqual(result.violations, []);
  }
});

test('permits only the production Phase 2 tool set for each provider', () => {
  for (const name of ['Read', 'Glob', 'Grep']) {
    assert.equal(auditClaude(claudeEvents(name, { file_path: reference.path, limit: 1 }, 'bounded output')).pass, true);
  }
  for (const input of ['pwd', "sed -n '1,2p' /logs/phase1.jsonl", "rg -n 'current\\.ts|attempt_result' /logs/phase1.jsonl | tail -n 30"]) {
    assert.equal(auditClaude(claudeEvents('Bash', { command: input }, 'bounded output')).pass, true);
  }
  const prohibited = auditClaude(claudeEvents('Bash', { command: 'node --test' }, 'bounded output'));
  assert.equal(prohibited.pass, false);
  assert.ok(prohibited.violations.includes('test/build attempt'));
  assert.equal(auditClaude(claudeEvents('command_execution', { command: 'pwd' })).pass, false);
  assert.equal(audit([command('pwd', '/logs')]).pass, true);
  for (const name of ['Read', 'Glob', 'Grep', 'Bash']) {
    const result = audit([{ id: 'tool', type: 'mcp_tool_call', arguments: { name }, result: 'bounded output', status: 'completed' }]);
    assert.equal(result.pass, false);
    assert.ok(result.violations.includes('unauthorized tool: mcp_tool_call'));
  }
});

test('fails closed for missing/unknown events and records file changes before cleanup', () => {
  assert.equal(auditPhase2({ events: [], cli: 'codex', reference, before: {}, after: {} }).pass, false);
  assert.equal(audit([{ id: 'x', type: 'future_tool' }]).pass, false);
  assert.equal(audit([], { '/file': 'before' }, { '/file': 'after' }).pass, false);
});

test('accepts the reference grammar in main-era red and current green prompts', () => {
  for (const language of ['ja', 'en']) {
    const prompt = promptFor({ ...vars, language });
    assert.ok(executionReference(prompt).byteSize > 0);
    assert.ok(executionReference(`legacy mediation instructions\n${prompt}`).path);
  }
});


test('keeps all seven cases and both CLI providers wired to the machine audit without leaking the hidden answer', () => {
  const cases = parse(readFileSync(new URL('../cases/phase1-execution-log-handoff.yaml', import.meta.url), 'utf8'));
  const config = parse(readFileSync(new URL('../agents/implement/phase1-execution-log-handoff.yaml', import.meta.url), 'utf8'));
  assert.equal(cases.length, 7);
  assert.ok(config.providers.some((provider) => provider.config.cli === 'claude' && provider.config.model === 'opus'));
  assert.ok(config.providers.some((provider) => provider.config.cli === 'codex'));
  assert.equal(config.defaultTest.assert[0].type, 'javascript');
  assert.match(config.defaultTest.assert[0].value, /phase1-execution-log.mjs$/);
  for (const entry of cases) {
    assert.equal(entry.vars.task.includes(middleObservation), false);
    assert.equal(entry.vars.last_response.includes(middleObservation), false);
    assert.equal(JSON.stringify(entry.assert).includes(middleObservation), false);
  }
  assert.ok(cases.some((entry) => entry.vars.phase1_session_prompt));
});
