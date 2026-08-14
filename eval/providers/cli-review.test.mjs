import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './cli-review.mjs';

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
    assert.equal(isProcessRunning(pids.grandchild), false);
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
