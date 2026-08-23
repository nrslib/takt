import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import CliReviewProvider, {
  createIsolatedWorkingDirectory,
  prepareWorkingDirectory,
  resolveTimeoutMs,
  rewriteWorkingDirectoryPaths,
  runProcess,
} from './cli-review.mjs';

const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(PROVIDERS_DIR, '..');

const PROCESS_TREE_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'process.on("SIGTERM", () => {});',
  'writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
  'setInterval(() => {}, 1000);',
].join('\n');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not met before the deadline');
    await delay(10);
  }
}

async function verifyTreeTermination(trigger) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-cli-review-provider-'));
  const readyPath = join(directory, 'ready.json');
  const controller = new AbortController();
  const run = runProcess(process.execPath, ['-e', PROCESS_TREE_SCRIPT, readyPath], {
    cwd: directory,
    input: '',
    timeoutMs: trigger === 'timeout' ? 500 : 5_000,
    abortSignal: controller.signal,
  });
  let pids;

  try {
    await waitFor(() => existsSync(readyPath));
    pids = JSON.parse(readFileSync(readyPath, 'utf8'));
    if (trigger === 'abort') controller.abort();

    await assert.rejects(run, new RegExp(trigger === 'timeout' ? 'timed out' : 'was aborted'));
    assert.equal(isProcessRunning(pids.child), false);
    await waitFor(() => !isProcessRunning(pids.grandchild));
  } finally {
    controller.abort();
    await run.catch(() => undefined);
    for (const pid of Object.values(pids ?? {})) {
      if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('timeout terminates the entire CLI process tree', {
  skip: process.platform === 'win32',
}, async () => {
  await verifyTreeTermination('timeout');
});

test('abort terminates the entire CLI process tree', {
  skip: process.platform === 'win32',
}, async () => {
  await verifyTreeTermination('abort');
});

test('zero and default timeout modes run non-inactivity shell wrappers without starting a watchdog', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-review-wrapper-'));
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory);
  const claudePath = join(binDirectory, 'claude');
  const codexPath = join(binDirectory, 'codex');
  const nodePath = join(binDirectory, 'node');
  const sleepPath = join(binDirectory, 'sleep');
  const watchdogMarker = join(directory, 'watchdog-started');
  writeFileSync(claudePath, [
    '#!/bin/sh',
    '/bin/sleep 0.05',
    "printf 'claude-ok\\n'",
  ].join('\n'));
  writeFileSync(codexPath, [
    '#!/bin/sh',
    "output=''",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) output="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '/bin/sleep 0.05',
    "printf 'codex-ok\\n' > \"$output\"",
  ].join('\n'));
  const watchdogSentinel = [
    '#!/bin/sh',
    'printf "started\\n" >> "$WATCHDOG_MARKER"',
    'exit 97',
  ].join('\n');
  writeFileSync(nodePath, watchdogSentinel);
  writeFileSync(sleepPath, watchdogSentinel);
  chmodSync(claudePath, 0o755);
  chmodSync(codexPath, 0o755);
  chmodSync(nodePath, 0o755);
  chmodSync(sleepPath, 0o755);

  try {
    for (const timeoutMode of ['default', 'explicit-zero']) {
      rmSync(watchdogMarker, { force: true });
      const env = {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        WATCHDOG_MARKER: watchdogMarker,
      };
      if (timeoutMode === 'explicit-zero') {
        env.CLAUDE_CODER_TIMEOUT_SECONDS = '0';
        env.CLAUDE_REVIEW_TIMEOUT_SECONDS = '0';
        env.CLAUDE_JUDGE_TIMEOUT_SECONDS = '0';
        env.CODEX_JUDGE_TIMEOUT_SECONDS = '0';
      } else {
        delete env.CLAUDE_CODER_TIMEOUT_SECONDS;
        delete env.CLAUDE_REVIEW_TIMEOUT_SECONDS;
        delete env.CLAUDE_JUDGE_TIMEOUT_SECONDS;
        delete env.CODEX_JUDGE_TIMEOUT_SECONDS;
      }

      const claude = spawnSync('bash', [
        'providers/claude-review.sh',
        'fake-opus',
        'fixtures/review-adjudication',
        'prompt',
      ], { cwd: EVAL_DIR, env, encoding: 'utf8' });
      assert.equal(claude.status, 0, claude.stderr);
      assert.equal(claude.stdout, 'claude-ok\n');

      const claudeCoder = spawnSync('bash', [
        'providers/claude-coder.sh',
        'fake-opus',
        'fixtures/review-adjudication',
        'prompt',
      ], { cwd: EVAL_DIR, env, encoding: 'utf8' });
      assert.equal(claudeCoder.status, 0, claudeCoder.stderr);
      assert.equal(claudeCoder.stdout, 'claude-ok\n');

      const claudeJudge = spawnSync('bash', [
        'providers/claude-judge.sh',
        'fake-opus',
        'prompt',
      ], { cwd: EVAL_DIR, env, encoding: 'utf8' });
      assert.equal(claudeJudge.status, 0, claudeJudge.stderr);
      assert.equal(claudeJudge.stdout, 'claude-ok\n');

      const codexJudge = spawnSync('bash', [
        'providers/codex-judge.sh',
        'fake-sol',
        'max',
        'prompt',
      ], { cwd: EVAL_DIR, env, encoding: 'utf8' });
      assert.equal(codexJudge.status, 0, codexJudge.stderr);
      assert.equal(codexJudge.stdout, 'codex-ok\n');
      assert.equal(
        existsSync(watchdogMarker),
        false,
        `${timeoutMode} mode must not start a watchdog process`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit Claude shell timeout terminates a TERM-resistant descendant', {
  skip: process.platform === 'win32',
  timeout: 25_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-claude-wrapper-tree-'));
  const binDirectory = join(directory, 'bin');
  const pidPath = join(directory, 'grandchild.pid');
  mkdirSync(binDirectory);
  const claudePath = join(binDirectory, 'claude');
  writeFileSync(claudePath, [
    '#!/bin/bash',
    `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' "$GRANDCHILD_PID_FILE" &`,
    'wait',
  ].join('\n'));
  chmodSync(claudePath, 0o755);
  let grandchildPid;

  try {
    const result = spawnSync('bash', [
      'providers/claude-review.sh',
      'fake-opus',
      'fixtures/review-adjudication',
      'prompt',
    ], {
      cwd: EVAL_DIR,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        GRANDCHILD_PID_FILE: pidPath,
        CLAUDE_REVIEW_TIMEOUT_SECONDS: '2',
      },
      encoding: 'utf8',
      timeout: 22_000,
    });
    assert.equal(result.status, 124, result.stderr);
    grandchildPid = Number(readFileSync(pidPath, 'utf8'));
    await waitFor(() => !isProcessRunning(grandchildPid));
  } finally {
    if (grandchildPid !== undefined && isProcessRunning(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL');
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runProcess allows completion when timeout is disabled', async () => {
  const output = await runProcess(process.execPath, ['-e', 'setTimeout(() => console.log("ok"), 25)'], {
    cwd: EVAL_DIR,
    input: '',
    timeoutMs: 0,
  });
  assert.equal(output, 'ok\n');
});

test('CLI review provider has no elapsed-time deadline unless explicitly configured', () => {
  assert.equal(resolveTimeoutMs({}), 0);
  assert.equal(resolveTimeoutMs({ timeout_ms: 0 }), 0);
  assert.equal(resolveTimeoutMs({ timeout_ms: 12_345 }), 12_345);
});

for (const [name, timeoutMs] of [
  ['negative value', -1],
  ['fractional value', 1.5],
  ['numeric string', '1000'],
  ['NaN', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
  ['timer overflow', 2_147_483_648],
]) {
  test(`CLI review provider rejects ${name} as timeout_ms`, () => {
    assert.throws(
      () => resolveTimeoutMs({ timeout_ms: timeoutMs }),
      /timeout_ms must be 0 \(disabled\) or an integer from 1 through 2147483647/,
    );
  });
}

test('isolated working directory copies only the provider fixture', () => {
  const outerDirectory = mkdtempSync(join(tmpdir(), 'takt-cli-review-source-'));
  const source = join(outerDirectory, 'fixture');
  const answerKey = join(outerDirectory, 'answer-key.txt');
  mkdirSync(source);
  writeFileSync(join(source, 'source.txt'), 'fixture');
  writeFileSync(answerKey, 'hidden');

  const isolated = prepareWorkingDirectory({
    working_dir: source,
    isolate_working_dir: true,
  });
  try {
    assert.equal(readFileSync(join(isolated.cwd, 'source.txt'), 'utf8'), 'fixture');
    assert.equal(existsSync(join(isolated.cwd, '..', 'answer-key.txt')), false);
    assert.equal(
      rewriteWorkingDirectoryPaths(
        `Read ${isolated.sourceDirectory}/source.txt`,
        isolated,
      ),
      `Read ${isolated.cwd}/source.txt`,
    );
  } finally {
    isolated.cleanup();
    rmSync(outerDirectory, { recursive: true, force: true });
  }
});

test('isolated working directory is removed when copying fails', () => {
  let copiedDestination;
  assert.throws(
    () => createIsolatedWorkingDirectory('/missing', (_source, destination) => {
      copiedDestination = destination;
      throw new Error('copy failed');
    }),
    /copy failed/,
  );
  assert.equal(existsSync(join(copiedDestination, '..')), false);
});

test('invalid provider timeout returns an error without creating an isolated fixture', async () => {
  const prefix = 'takt-prompt-eval-fixture-';
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
  const provider = new CliReviewProvider({
    config: {
      cli: 'claude',
      model: 'fake-opus',
      working_dir: 'fixtures/review-adjudication',
      isolate_working_dir: true,
      timeout_ms: -1,
    },
  });

  const result = await provider.callApi('prompt');
  const leaked = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !before.has(name));

  assert.match(result.error, /timeout_ms must be 0/);
  assert.deepEqual(leaked, []);
});
