import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { getProcessStartTime, isSameProcess } from '../src/process-start.mjs';
import { readUnixStart } from '../src/unix-process-time.mjs';
import { readWindowsCreationTime } from '../src/windows-process-time.mjs';

test('Unix reader returns the current process start as a comparable number', () => {
  assert.equal(readUnixStart(process.pid), performance.timeOrigin);
  assert.equal(typeof readUnixStart(process.pid), 'number');
  assert.equal(getProcessStartTime(process.pid, { platform: 'darwin' }), performance.timeOrigin);
  assert.equal(getProcessStartTime(process.pid, { platform: 'linux' }), performance.timeOrigin);
  assert.equal(readUnixStart(process.pid + 1), undefined);
  assert.equal(isSameProcess({ pid: process.pid + 1, startedAt: undefined },
    process.pid + 1, { platform: 'linux' }), false);
  assert.throws(() => readUnixStart(0), RangeError);
});

test('Unix process identity distinguishes starts within the same second', () => {
  let startedAt = 1_759_320_000_100.25;
  const readers = { platform: 'darwin', readUnixStart: () => startedAt };
  const owner = { pid: 42, startedAt };
  assert.equal(isSameProcess(owner, 42, readers), true);
  startedAt = 1_759_320_000_100.75;
  assert.equal(isSameProcess(owner, 42, readers), false);
});

test('Windows creation time is read and compared using a mock adapter', () => {
  const readers = {
    platform: 'win32',
    readUnixStart: () => { throw new Error('wrong adapter'); },
    readWindowsCreationTime: (pid) => pid === 42 ? '2026-10-01T12:00:00Z' : undefined,
  };
  assert.equal(getProcessStartTime(42, readers), '2026-10-01T12:00:00Z');
  assert.equal(isSameProcess({ pid: 42, startedAt: '2026-10-01T12:00:00Z' }, 42, readers), true);
  assert.equal(isSameProcess({ pid: 42, startedAt: '2026-09-01T12:00:00Z' }, 42, readers), false);
  assert.equal(isSameProcess({ pid: 42, startedAt: '2026-10-01T12:00:00Z' }, 43, readers), false);
});

test('Windows adapter uses documented process start time interface', () => {
  const calls = [];
  const result = readWindowsCreationTime(42, (program, args, options) => {
    calls.push({ program, args, options });
    return '2026-10-01T12:00:00.0000000Z\n';
  });
  assert.equal(result, '2026-10-01T12:00:00.0000000Z');
  assert.equal(calls[0].program, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /GetProcessById\(42\)\.StartTime/);
});
