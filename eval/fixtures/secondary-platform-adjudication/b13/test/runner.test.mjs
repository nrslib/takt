import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTask as previousRun } from '../src/runner.previous.mjs';
import { runTask as currentRun } from '../src/runner.mjs';

test('new isolation breaks the previous Windows execution path after processing starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-b13-'));
  const attemptPath = join(directory, 'last-run-attempt');
  const spawn = (command, args) => ({ command, args, status: 0 });
  try {
    assert.equal(previousRun('node', ['job.mjs'], spawn).status, 0);
    assert.throws(
      () => currentRun('node', ['job.mjs'], { platform: 'win32', spawn, attemptPath }),
      /sandbox launcher unavailable/,
    );
    assert.equal(readFileSync(attemptPath, 'utf8'), 'node');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('available hosts use their OS isolation launchers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-b13-'));
  const attemptPath = join(directory, 'last-run-attempt');
  const spawn = (command, args) => ({ command, args });
  try {
    const mac = currentRun('node', ['job.mjs'], {
      platform: 'darwin', spawn, attemptPath,
    });
    assert.equal(mac.command, '/usr/bin/sandbox-exec');
    assert.ok(mac.args.includes('job.mjs'));

    const linux = currentRun('node', ['job.mjs'], {
      platform: 'linux', spawn, attemptPath,
    });
    assert.equal(linux.command, 'bwrap');
    assert.ok(linux.args.includes('--unshare-net'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
