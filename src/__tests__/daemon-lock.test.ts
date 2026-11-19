import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeProcess, readProcessOwner } from '../infra/daemon/process.js';
import { ensurePrivateDirectory, readPrivateFile } from '../infra/daemon/privateFile.js';
import type { IoOptions } from '../core/daemon/io.js';
import { deferred } from './helpers/controlledDaemon.js';

vi.mock('node:fs/promises', () => ({ open: vi.fn(), stat: vi.fn(), unlink: vi.fn() }));
vi.mock('../infra/daemon/privateFile.js', () => ({
  ensurePrivateDirectory: vi.fn(), readPrivateFile: vi.fn(),
  hasCode: (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code,
}));
vi.mock('../infra/daemon/process.js', () => ({ readProcessOwner: vi.fn(), observeProcess: vi.fn() }));
// timers/promises の待機も Vitest の仮想時計で進める。
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(value); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
}));

const path = resolve('daemon-test.lock');
const files = new Map<string, Buffer>();
const options = (): IoOptions => ({ signal: new AbortController().signal, timeoutMs: 5000 });
let FileAsyncLock: typeof import('../infra/daemon/lock.js').FileAsyncLock;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.resetModules();
  files.clear();
  vi.mocked(readProcessOwner).mockResolvedValue({ pid: process.pid, startTime: 'self-start' });
  vi.mocked(readPrivateFile).mockImplementation(async (name) => files.get(name));
  vi.mocked(unlink).mockImplementation(async (name) => { files.delete(String(name)); });
  vi.mocked(open).mockImplementation(async (name) => {
    const key = String(name);
    if (files.has(key)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    files.set(key, Buffer.alloc(0));
    return {
      chmod: vi.fn(), close: vi.fn(),
      writeFile: async (content: Buffer) => { files.set(key, content); },
    } as unknown as Awaited<ReturnType<typeof open>>;
  });
  ({ FileAsyncLock } = await import('../infra/daemon/lock.js'));
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('FileAsyncLock acquisition-only deadline', () => {
  it('keeps the file and local queue held while an acquired action exceeds the acquisition deadline', async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const first = new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => {
      entered.resolve(); await release.promise; return 42;
    }, options());
    await entered.promise;
    const action = vi.fn(async () => 2);
    const second = new FileAsyncLock().exclusive(path, action, { ...options(), timeoutMs: 20000 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(files.has(path)).toBe(true);
    expect(action).not.toHaveBeenCalled();
    release.resolve();
    expect(await first).toBe(42);
    expect(await second).toBe(2);
    expect(files.size).toBe(0);
  });

  it.each(['abort', 'deadline'] as const)('does not start a local waiter after acquisition %s', async (kind) => {
    const entered = deferred<void>(); const release = deferred<void>();
    const holder = new FileAsyncLock().exclusive(path, async () => { entered.resolve(); await release.promise; }, options());
    await entered.promise;
    const abort = new AbortController(); const action = vi.fn(async () => 2);
    const waiting = new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, action, { signal: abort.signal, timeoutMs: 100 });
    const rejected = expect(waiting).rejects.toMatchObject({ name: kind === 'abort' ? 'AbortError' : 'TimeoutError' });
    if (kind === 'abort') abort.abort(); else await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(action).not.toHaveBeenCalled();
    expect(files.has(path)).toBe(true);
    release.resolve(); await holder;
    expect(await new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => 3, options())).toBe(3);
  });

  it('checks the deadline after writing the ownership file and before starting the action', async () => {
    const written = deferred<void>(); const finish = deferred<void>();
    vi.mocked(open).mockResolvedValueOnce({
      chmod: async () => {}, close: async () => {},
      writeFile: async (content: Buffer) => { files.set(path, content); written.resolve(); await finish.promise; },
    } as unknown as Awaited<ReturnType<typeof open>>);
    const action = vi.fn(async () => 1);
    const waiting = new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, action, { ...options(), timeoutMs: 100 });
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'TimeoutError' });
    await written.promise;
    await vi.advanceTimersByTimeAsync(100);
    finish.resolve(); await rejected;
    expect(action).not.toHaveBeenCalled();
    expect(files.has(path)).toBe(false);
    expect(await new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => 2, options())).toBe(2);
  });

  it('bounds acquisition of a foreign file lock without removing its live owner', async () => {
    const content = Buffer.from(JSON.stringify({ pid: 123456, startTime: 'foreign-start' }));
    files.set(path, content);
    vi.mocked(observeProcess).mockResolvedValue({ kind: 'alive', owner: { pid: 123456, startTime: 'foreign-start' } });
    const action = vi.fn(async () => 1);
    const waiting = new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, action, { ...options(), timeoutMs: 100 });
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(action).not.toHaveBeenCalled();
    expect(files.get(path)).toEqual(content);
    files.delete(path);
    expect(await new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => 2, options())).toBe(2);
  });

  it('propagates an action failure after its acquisition deadline and releases the lock', async () => {
    const failure = new Error('publication failed');
    await expect(new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => {
      await vi.advanceTimersByTimeAsync(6000); throw failure;
    }, options())).rejects.toBe(failure);
    expect(files.size).toBe(0);
    expect(await new FileAsyncLock().exclusive(path, async () => 2, options())).toBe(2);
  });

  it.each([false, true])('propagates release failure and aggregates a simultaneous action failure (%s)', async (actionFails) => {
    const actionFailure = new Error('publication failed'); const releaseFailure = new Error('unlink failed');
    vi.mocked(unlink).mockRejectedValueOnce(releaseFailure);
    const waiting = new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => {
      await vi.advanceTimersByTimeAsync(6000);
      if (actionFails) throw actionFailure;
      return 42;
    }, options());
    if (actionFails) await expect(waiting).rejects.toMatchObject({ errors: [actionFailure, releaseFailure] });
    else await expect(waiting).rejects.toBe(releaseFailure);
    files.clear();
    expect(await new FileAsyncLock().exclusive(path, async () => 2, options())).toBe(2);
  });

  it('rejects ownership changes even after an acquisition-only action succeeds', async () => {
    const other = Buffer.from('another owner');
    await expect(new FileAsyncLock().exclusiveWithAcquisitionTimeout(path, async () => {
      files.set(path, other); return 42;
    }, options())).rejects.toThrow();
    expect(files.get(path)).toEqual(other);
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe('FileAsyncLock contention', () => {
  it('shares one process identity lookup across concurrent paths and later acquisitions', async () => {
    const identity = deferred<Awaited<ReturnType<typeof readProcessOwner>>>();
    vi.mocked(readProcessOwner).mockReturnValue(identity.promise);
    const first = new FileAsyncLock().exclusive(path, async () => 1, options());
    const second = new FileAsyncLock().exclusive(`${path}.other`, async () => 2, options());
    await vi.advanceTimersByTimeAsync(0);
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    identity.resolve({ pid: process.pid, startTime: 'self-start' });
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    await new FileAsyncLock().exclusive(path, async () => {
      expect(JSON.parse(files.get(path)!.toString())).toMatchObject({ pid: process.pid, startTime: 'self-start' });
    }, options());
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
  });

  it('queues normalized paths across instances in order without file retries or process observations', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const order: number[] = [];
    const first = new FileAsyncLock().exclusive(path, async () => { entered.resolve(); await release.promise; order.push(0); }, options());
    await entered.promise;
    const waiters = [1, 2, 3].map((index) => new FileAsyncLock().exclusive(`./${path.slice(process.cwd().length + 1)}`,
      async () => { order.push(index); }, options()));
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual([]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    expect(observeProcess).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, ...waiters]);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(open).toHaveBeenCalledTimes(4);
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
  });

  it('keeps a shared identity lookup available when its first waiter is cancelled', async () => {
    const identity = deferred<Awaited<ReturnType<typeof readProcessOwner>>>();
    vi.mocked(readProcessOwner).mockReturnValue(identity.promise);
    const abort = new AbortController();
    const action = vi.fn(async () => 1);
    const first = new FileAsyncLock().exclusive(path, action, { ...options(), signal: abort.signal });
    const second = new FileAsyncLock().exclusive(`${path}.other`, async () => 2, options());
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await rejected;
    expect(vi.mocked(readProcessOwner).mock.calls[0]![1].signal.aborted).toBe(false);
    identity.resolve({ pid: process.pid, startTime: 'self-start' });
    expect(await second).toBe(2);
    expect(action).not.toHaveBeenCalled();
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    expect(await new FileAsyncLock().exclusive(path, async () => 3, options())).toBe(3);
  });

  it('retries an identity lookup after failure instead of caching the rejection', async () => {
    const failure = new Error('identity unavailable');
    vi.mocked(readProcessOwner).mockRejectedValueOnce(failure);
    await expect(new FileAsyncLock().exclusive(path, async () => 1, options())).rejects.toBe(failure);
    expect(await new FileAsyncLock().exclusive(path, async () => 2, options())).toBe(2);
    expect(readProcessOwner).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'deadline'] as const)('does not start an identity lookup after %s during directory creation', async (kind) => {
    const directory = deferred<void>();
    vi.mocked(ensurePrivateDirectory).mockReturnValueOnce(directory.promise);
    const abort = new AbortController();
    const action = vi.fn(async () => 1);
    const run = new FileAsyncLock().exclusive(path, action, { signal: abort.signal, timeoutMs: 100 });
    const rejected = expect(run).rejects.toMatchObject({ name: kind === 'abort' ? 'AbortError' : 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ensurePrivateDirectory).toHaveBeenCalledTimes(1);
    if (kind === 'abort') abort.abort();
    else await vi.advanceTimersByTimeAsync(100);
    directory.resolve();
    await rejected;
    expect(readProcessOwner).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await new FileAsyncLock().exclusive(path, async () => 2, options())).toBe(2);
  });

  it('handles a shared identity lookup failure after its only waiter is cancelled', async () => {
    const identity = deferred<Awaited<ReturnType<typeof readProcessOwner>>>();
    vi.mocked(readProcessOwner).mockReturnValueOnce(identity.promise);
    const abort = new AbortController();
    const action = vi.fn(async () => 1);
    const run = new FileAsyncLock().exclusive(path, action, { ...options(), signal: abort.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
    identity.reject(new Error('identity unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(open).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await new FileAsyncLock().exclusive(path, async () => 2, options())).toBe(2);
    expect(readProcessOwner).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'deadline'] as const)('removes a %s waiter without letting later waiters bypass the holder', async (kind) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = new FileAsyncLock().exclusive(path, async () => { entered.resolve(); await release.promise; }, options());
    await entered.promise;
    const abort = new AbortController();
    const cancelledAction = vi.fn(async () => 2);
    const second = new FileAsyncLock().exclusive(path, cancelledAction, { signal: abort.signal, timeoutMs: 100 });
    const rejected = expect(second).rejects.toMatchObject({ name: kind === 'abort' ? 'AbortError' : 'TimeoutError' });
    if (kind === 'abort') abort.abort();
    else await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const thirdAction = vi.fn(async () => 3);
    const third = new FileAsyncLock().exclusive(path, thirdAction, options());
    expect(await new FileAsyncLock().exclusive(`${path}.other`, async () => 4, options())).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelledAction).not.toHaveBeenCalled();
    expect(thirdAction).not.toHaveBeenCalled();
    release.resolve();
    await first;
    expect(await third).toBe(3);
    expect(await new FileAsyncLock().exclusive(path, async () => 5, options())).toBe(5);
  });

  it('keeps the local queue held until a timed-out action finishes cleanup', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = new FileAsyncLock().exclusive(path, async () => { entered.resolve(); await release.promise; },
      { ...options(), timeoutMs: 100 });
    const rejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await entered.promise;
    const action = vi.fn(async () => 2);
    const second = new FileAsyncLock().exclusive(path, action, options());
    await vi.advanceTimersByTimeAsync(100);
    expect(action).not.toHaveBeenCalled();
    expect(files.has(path)).toBe(true);
    release.resolve();
    await rejected;
    expect(await second).toBe(2);
    expect(files.size).toBe(0);
  });

  it('releases the local queue after acquisition and action failures', async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(new FileAsyncLock().exclusive(path, async () => 1, options())).rejects.toMatchObject({ code: 'EACCES' });
    const failure = new Error('action failed');
    const first = new FileAsyncLock().exclusive(path, async () => { throw failure; }, options());
    const second = new FileAsyncLock().exclusive(path, async () => 2, options());
    await expect(first).rejects.toBe(failure);
    expect(await second).toBe(2);
    expect(files.size).toBe(0);
  });

  it.each([true, false])('preserves a self-owned file (start time present: %s)', async (withStartTime) => {
    const content = Buffer.from(JSON.stringify({ pid: process.pid, ...(withStartTime ? { startTime: 'self-start' } : {}) }));
    files.set(path, content);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const action = vi.fn(async () => 1);
    const run = new FileAsyncLock().exclusive(path, action, { ...options(), timeoutMs: 1500 });
    const rejected = expect(run).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    expect(observeProcess).not.toHaveBeenCalled();
    if (withStartTime) expect(kill).not.toHaveBeenCalled();
    else expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(unlink).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(files.get(path)).toEqual(content);
  });

  it.each([
    { startTime: 'previous-start' },
    { processIdentity: { startTime: 'previous-start' } },
  ])('recovers a previous process lock with the same PID and a different start time: %j', async (identity) => {
    files.set(path, Buffer.from(JSON.stringify({ pid: process.pid, ...identity })));
    vi.mocked(observeProcess).mockResolvedValue({ kind: 'dead' });
    const action = vi.fn(async () => {
      expect(JSON.parse(files.get(path)!.toString())).toMatchObject({ pid: process.pid, startTime: 'self-start' });
      return 42;
    });
    const run = new FileAsyncLock().exclusive(path, action, options());
    await vi.advanceTimersByTimeAsync(25);
    expect(await run).toBe(42);
    expect(observeProcess).toHaveBeenCalledExactlyOnceWith(
      { pid: process.pid, startTime: 'previous-start' }, expect.objectContaining({ timeoutMs: 5000 }));
    expect(readProcessOwner).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
  });

  it.each(['alive', 'unknown'] as const)('spaces foreign %s owner checks one second apart and recovers after death', async (kind) => {
    const owner = { pid: 123456, startTime: 'foreign-start' };
    files.set(path, Buffer.from(JSON.stringify(owner)));
    vi.mocked(observeProcess).mockResolvedValue(kind === 'alive' ? { kind, owner } : { kind, reason: 'unavailable' });
    const action = vi.fn(async () => 42);
    const run = new FileAsyncLock().exclusive(path, action, options());
    await vi.advanceTimersByTimeAsync(0);
    expect(observeProcess).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ timeoutMs: 5000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(observeProcess).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(observeProcess).toHaveBeenCalledTimes(2);
    vi.mocked(observeProcess).mockResolvedValue({ kind: 'dead' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(observeProcess).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(25);
    expect(await run).toBe(42);
    expect(files.size).toBe(0);
  });
});
