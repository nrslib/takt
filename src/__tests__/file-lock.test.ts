import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  openSync: vi.fn(), closeSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(),
  statSync: vi.fn(), unlinkSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock('../infra/task/process.js', () => ({
  getSelfProcessIdentity: vi.fn(), isRecordedProcessAlive: vi.fn(),
}));

import { withFileLock } from '../infra/fs/file-lock.js';
import { getSelfProcessIdentity, isRecordedProcessAlive } from '../infra/task/process.js';

const lockPath = resolve('test.lock');
const identity = { startTime: 'darwin-start-v2:1791244800' };
const selfContent = JSON.stringify({ pid: process.pid, processIdentity: identity });
const otherContent = JSON.stringify({ pid: 4101, processIdentity: identity });
let content: string | undefined;
let stat: fs.Stats;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  content = undefined;
  stat = { dev: 1, ino: 1, mtimeMs: Date.now() } as fs.Stats;
  vi.mocked(getSelfProcessIdentity).mockReturnValue(identity);
  vi.mocked(isRecordedProcessAlive).mockReturnValue(true);
  vi.mocked(fs.openSync).mockImplementation((_path, flags) => {
    if (flags === 'wx') {
      if (content !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      content = '';
      stat = { ...stat, ino: stat.ino + 1, mtimeMs: Date.now() } as fs.Stats;
    } else if (content === undefined) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return 42;
  });
  vi.mocked(fs.fstatSync).mockImplementation(() => stat);
  vi.mocked(fs.readFileSync).mockImplementation(() => content!);
  vi.mocked(fs.writeFileSync).mockImplementation((_fd, value) => { content = String(value); });
  vi.mocked(fs.unlinkSync).mockImplementation(() => { content = undefined; });
  vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    vi.advanceTimersByTime(timeout!);
    return 'timed-out';
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withFileLock', () => {
  it('writes the process identity with exclusive creation, returns the result, and releases', () => {
    expect(withFileLock(lockPath, () => {
      expect(content).toBe(selfContent);
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      return 123;
    })).toBe(123);
    expect(fs.openSync).toHaveBeenCalledWith(lockPath, 'wx', 0o600);
    expect(content).toBeUndefined();
  });

  it('releases its own lock when closing the write handle changes the mtime', () => {
    vi.mocked(fs.closeSync).mockImplementationOnce(() => {
      stat = { ...stat, mtimeMs: stat.mtimeMs + 1_000 } as fs.Stats;
    });

    withFileLock(lockPath, () => {
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      expect(stat.mtimeMs).toBe(101_000);
      expect(content).toBe(selfContent);
    });

    expect(content).toBeUndefined();
    expect(withFileLock(lockPath, () => 'next')).toBe('next');
  });

  it('waits for another holder to release before running the action', () => {
    content = otherContent;
    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      content = undefined;
      vi.advanceTimersByTime(25);
      return 'timed-out';
    });
    const action = vi.fn(() => {
      expect(content).toBe(selfContent);
      return 'acquired';
    });
    expect(withFileLock(lockPath, action)).toBe('acquired');
    expect(isRecordedProcessAlive).toHaveBeenCalledWith(4101, identity);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('recovers a dead owner without waiting for the mtime threshold', () => {
    content = otherContent;
    vi.mocked(isRecordedProcessAlive).mockReturnValue(false);
    expect(withFileLock(lockPath, () => content)).toBe(selfContent);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('times out after five seconds without deleting even an old live owner', () => {
    content = otherContent;
    stat = { ...stat, mtimeMs: 0 } as fs.Stats;
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(/timed out waiting for lock/);
    expect(Date.now()).toBe(105_000);
    expect(content).toBe(otherContent);
    expect(action).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it.each(['{', '123\n', JSON.stringify({ pid: 0 }), JSON.stringify({ pid: 4101, processIdentity: [] })])(
    'keeps a fresh invalid record and recovers it only after the stale threshold: %s', (invalid) => {
      content = invalid;
      const action = vi.fn();
      expect(() => withFileLock(lockPath, action, { timeoutMs: 50 })).toThrow(/timed out/);
      expect(content).toBe(invalid);
      expect(action).not.toHaveBeenCalled();
      expect(isRecordedProcessAlive).not.toHaveBeenCalled();
      stat = { ...stat, mtimeMs: Date.now() - 30_001 } as fs.Stats;
      expect(withFileLock(lockPath, () => content)).toBe(selfContent);
      expect(content).toBeUndefined();
    },
  );

  it('does not remove a new holder after checking a stale snapshot', () => {
    content = otherContent;
    vi.mocked(isRecordedProcessAlive).mockImplementationOnce(() => {
      stat = { ...stat, ino: stat.ino + 1 } as fs.Stats;
      content = JSON.stringify({ pid: 4102, processIdentity: identity });
      return false;
    });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(JSON.parse(content!).pid).toBe(4102);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps an unreadable fresh record and recovers it only after the stale threshold', () => {
    content = otherContent;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('unreadable'), { code: 'EIO' });
    });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action, { timeoutMs: 25 })).toThrow(/timed out/);
    expect(content).toBe(otherContent);
    expect(action).not.toHaveBeenCalled();
    stat = { ...stat, mtimeMs: Date.now() - 30_001 } as fs.Stats;
    expect(withFileLock(lockPath, () => 'recovered')).toBe('recovered');
    // The new owner's readable content must be confirmed before release.
    expect(content).toBe(selfContent);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('releases after an action throws and permits the next acquisition', () => {
    const failure = new Error('update failed');
    expect(() => withFileLock(lockPath, () => { throw failure; })).toThrow(failure);
    expect(content).toBeUndefined();
    expect(withFileLock(lockPath, () => 'next')).toBe('next');
  });

  it('leaves a different owner untouched during release', () => {
    withFileLock(lockPath, () => { content = otherContent; });
    expect(content).toBe(otherContent);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('rejects nested acquisition of the same path without releasing the outer lock', () => {
    withFileLock(lockPath, () => {
      expect(() => withFileLock(lockPath, vi.fn())).toThrow(/reentrant lock detected/);
      expect(content).toBe(selfContent);
    });
    expect(content).toBeUndefined();
  });

  it('propagates creation errors without running the action', () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw failure; });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(failure);
    expect(action).not.toHaveBeenCalled();
  });

  it('closes and removes a partial record if writing fails', () => {
    const failure = new Error('write failed');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { content = '{'; throw failure; });
    const action = vi.fn();
    expect(() => withFileLock(lockPath, action)).toThrow(failure);
    expect(content).toBeUndefined();
    expect(fs.closeSync).toHaveBeenCalledWith(42);
    expect(action).not.toHaveBeenCalled();
  });
});
