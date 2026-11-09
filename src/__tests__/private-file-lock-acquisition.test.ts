import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const write = vi.hoisted(() => vi.fn());
const beforeOpen = vi.hoisted(() => vi.fn<(path: unknown) => void>());
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    beforeOpen(args[0]);
    return actual.openSync(...args);
  } };
});
vi.mock('../shared/utils/private-file.js', async (original) => ({
  ...await original<typeof import('../shared/utils/private-file.js')>(),
  writeNewPrivateFileWithMode: write,
}));
import { PrivateFileLockAcquisitionError, runPrivateFileExclusive, runPrivateFileExclusiveAsync } from '../shared/utils/private-file-lock.js';
import { PrivateArtifactContentWriteFailedError } from '../shared/utils/private-file.js';
const directories: string[] = [];
afterEach(() => {
  write.mockReset();
  beforeOpen.mockReset();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('private lock acquisition failures', () => {
  it.each(['creation', 'content'] as const)('classifies unpublished ENOSPC at %s and does not run the action', (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = stage === 'content' ? new PrivateArtifactContentWriteFailedError('disk full', -28, {})
      : Object.assign(new Error('disk full'), { code: 'ENOSPC', errno: -28 });
    write.mockImplementation(() => { throw source; });
    const action = vi.fn();
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), action)).toThrow(PrivateFileLockAcquisitionError);
    expect(action).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });
  it('preserves unrelated acquisition failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = Object.assign(new Error('denied'), { code: 'EACCES' });
    write.mockImplementation(() => { throw source; });
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), () => 42)).toThrow(source);
  });

  it.each((['sync', 'async'] as const).flatMap((mode) => [1, 2, 3].map((read) => ({ mode, read }))))(
    'acquires the $mode lock when it disappears between stat and open on recovery read $read', async ({ mode, read }) => {
      const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
      write.mockImplementation(actual.writeNewPrivateFileWithMode);
      const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
      directories.push(directory);
      const lock = join(directory, 'lock');
      const previous = JSON.stringify({ pid: process.pid, token: 'previous-holder' });
      writeFileSync(lock, previous);
      if (read > 1) vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('dead holder'), { code: 'ESRCH' });
      });
      let released = false;
      let reads = 0;
      beforeOpen.mockImplementation((path) => {
        if (path === lock && ++reads === read) {
          released = true;
          unlinkSync(lock);
        }
      });
      const action = vi.fn(() => {
        expect(released).toBe(true);
        expect(readFileSync(lock, 'utf8')).not.toBe(previous);
        return 42;
      });
      const result = mode === 'sync' ? runPrivateFileExclusive(lock, action) : await runPrivateFileExclusiveAsync(lock, action);
      expect(result).toBe(42);
      expect(action).toHaveBeenCalledOnce();
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it('keeps a replacement lock and does not enter the action during dead-holder recovery', async () => {
    const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
    write.mockImplementation(actual.writeNewPrivateFileWithMode);
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const lock = join(directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'dead-holder' }));
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-holder' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      unlinkSync(lock);
      writeFileSync(lock, replacement);
      throw Object.assign(new Error('dead holder'), { code: 'ESRCH' });
    });
    const action = vi.fn();
    await expect(runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 })).rejects.toThrow('Timed out');
    expect(readFileSync(lock, 'utf8')).toBe(replacement);
    expect(action).not.toHaveBeenCalled();
  });

  it('cancels an unbounded async lock wait without running the action', async () => {
    vi.useFakeTimers();
    try {
      const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
      write.mockImplementation(actual.writeNewPrivateFileWithMode);
      const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
      directories.push(directory);
      const lock = join(directory, 'lock');
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'current-holder' }));
      const controller = new AbortController();
      const reason = new Error('cancelled while waiting');
      let waiting!: () => void;
      const enteredWait = new Promise<void>((resolve) => { waiting = resolve; });
      const action = vi.fn();
      const operation = runPrivateFileExclusiveAsync(lock, action, {
        timeoutMs: null, signal: controller.signal, onWait: waiting,
      });
      await enteredWait;
      vi.setSystemTime(Date.now() + 20_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(action).not.toHaveBeenCalled();
      controller.abort(reason);
      await expect(operation).rejects.toBe(reason);
      expect(action).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates permission failures while inspecting a contended lock', async () => {
    const actual = await vi.importActual<typeof import('../shared/utils/private-file.js')>('../shared/utils/private-file.js');
    write.mockImplementation(actual.writeNewPrivateFileWithMode);
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const lock = join(directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'holder' }));
    const source = Object.assign(new Error('denied'), { code: 'EACCES' });
    beforeOpen.mockImplementation((path) => { if (path === lock) throw source; });
    const action = vi.fn();
    await expect(runPrivateFileExclusiveAsync(lock, action, { timeoutMs: 0 })).rejects.toBe(source);
    expect(action).not.toHaveBeenCalled();
  });
});
