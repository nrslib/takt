import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  beginProjectRun,
  isCurrentProcessLockOwner,
  recordLockOwner,
  restoreLockOwner,
} from '../src/project-lock.mjs';

test('records, restores, and checks a lock owner without mistaking a reused PID', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-c1-lock-'));
  const lockPath = join(directory, 'owner.json');
  let startedAt = '2026-10-01T12:00:00Z';
  const readers = {
    platform: 'win32',
    readWindowsCreationTime: () => startedAt,
  };

  try {
    const acquired = beginProjectRun(lockPath, 42, readers);
    assert.equal(acquired.state, 'acquired');
    const owner = acquired.owner;
    assert.deepEqual(restoreLockOwner(lockPath), owner);
    assert.equal(isCurrentProcessLockOwner(lockPath, 42, readers), true);
    assert.equal(beginProjectRun(lockPath, 42, readers).state, 'owned');
    assert.equal(isCurrentProcessLockOwner(lockPath, 43, readers), false);
    assert.equal(beginProjectRun(lockPath, 43, readers).state, 'busy');
    startedAt = '2026-10-02T12:00:00Z';
    assert.equal(isCurrentProcessLockOwner(lockPath, 42, readers), false);
    assert.equal(beginProjectRun(lockPath, 42, readers).state, 'busy');
    assert.throws(() => recordLockOwner(lockPath, 42, readers), { code: 'EEXIST' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stores and compares numeric Unix starts on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const directory = mkdtempSync(join(tmpdir(), 'platform-c1-lock-'));
    const lockPath = join(directory, 'owner.json');
    let startedAt = 1_759_320_000_100.25;
    const readers = { platform, readUnixStart: () => startedAt };
    try {
      const owner = recordLockOwner(lockPath, 42, readers);
      assert.deepEqual(restoreLockOwner(lockPath), owner);
      assert.equal(isCurrentProcessLockOwner(lockPath, 42, readers), true);
      startedAt = 1_759_320_000_100.75;
      assert.equal(isCurrentProcessLockOwner(lockPath, 42, readers), false);
      assert.equal(beginProjectRun(lockPath, 42, readers).state, 'busy');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('current Unix process retains lock ownership after JSON roundtrip', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-c1-lock-'));
  const lockPath = join(directory, 'owner.json');
  const readers = { platform: 'darwin' };
  try {
    const acquired = beginProjectRun(lockPath, process.pid, readers);
    assert.equal(acquired.state, 'acquired');
    assert.equal(typeof acquired.owner.startedAt, 'number');
    assert.deepEqual(restoreLockOwner(lockPath), acquired.owner);
    assert.equal(beginProjectRun(lockPath, process.pid, readers).state, 'owned');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not write a lock without a valid start time', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-c1-lock-'));
  const lockPath = join(directory, 'owner.json');
  try {
    for (const startedAt of ['', Number.NaN, undefined]) {
      assert.throws(() => recordLockOwner(lockPath, 42, {
        platform: 'darwin',
        readUnixStart: () => startedAt,
      }), /process start time unavailable/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
