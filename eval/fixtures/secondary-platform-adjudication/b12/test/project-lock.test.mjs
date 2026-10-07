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
  const directory = mkdtempSync(join(tmpdir(), 'platform-b12-lock-'));
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

test('uses the Unix reader on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const directory = mkdtempSync(join(tmpdir(), 'platform-b12-lock-'));
    const lockPath = join(directory, 'owner.json');
    const readers = { platform, readUnixStart: () => 'Thu Oct  1 12:00:00 2026' };
    try {
      recordLockOwner(lockPath, 42, readers);
      assert.equal(isCurrentProcessLockOwner(lockPath, 42, readers), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
