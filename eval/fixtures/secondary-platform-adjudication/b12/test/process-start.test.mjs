import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProcessStartTime, isSameProcess } from '../src/process-start.mjs';
import { readWindowsCreationTime } from '../src/windows-process-time.mjs';

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
