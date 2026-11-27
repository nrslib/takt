import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { conversationId } from '../infra/conversations/identity.js';
import { withManagerLifecycleLock, withManagerLifecycleLocks } from '../infra/conversations/managerLifecycleLock.js';
import { deferred } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('../infra/daemon/lock.js', () => ({ FileAsyncLock: class { acquire = doubles.acquire; } }));
vi.mock('node:fs/promises', () => ({ realpath: async () => '/config' }));
const ids = ['/a', '/b', '/c'].map((repositoryDirectory) => conversationId({ kind: 'repository', repositoryDirectory })).sort();
const signal = () => new AbortController().signal;

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it('holds every distinct lock in a consistent order through the action and releases in reverse order', async () => {
  const held = new Set<string>(); const released: string[] = [];
  doubles.acquire.mockImplementation(async (path: string) => {
    const id = basename(path, '.lock'); held.add(id);
    return async () => { held.delete(id); released.push(id); };
  });
  const abortSignal = signal();
  expect(await withManagerLifecycleLocks('/config', [ids[1]!, ids[0]!, ids[1]!], abortSignal, async () => {
    expect([...held]).toEqual(ids.slice(0, 2));
    return 'done';
  })).toBe('done');
  expect(held.size).toBe(0);
  expect(released).toEqual(ids.slice(0, 2).reverse());
  for (const [, options] of doubles.acquire.mock.calls) expect(options).toEqual({ signal: abortSignal, timeoutMs: 5000 });
});

it('releases acquired locks when a later acquisition fails and permits a subsequent operation', async () => {
  const release = vi.fn(async () => {}); const action = vi.fn(); const failure = new Error('acquisition failed');
  doubles.acquire.mockResolvedValueOnce(release).mockRejectedValueOnce(failure);
  await expect(withManagerLifecycleLocks('/config', ids, signal(), action)).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(action).not.toHaveBeenCalled();
  doubles.acquire.mockResolvedValue(async () => {});
  await expect(withManagerLifecycleLocks('/config', ids, signal(), async () => 'retry')).resolves.toBe('retry');
});

it('releases partial acquisitions on cancellation without entering the action', async () => {
  const controller = new AbortController(); const release = vi.fn(async () => {}); const action = vi.fn();
  const waiting = deferred<void>();
  doubles.acquire.mockResolvedValueOnce(release).mockImplementationOnce(async (_path, options) => {
    waiting.resolve();
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = withManagerLifecycleLocks('/config', ids, controller.signal, action);
  await waiting.promise; controller.abort();
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(action).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it('attempts every release and propagates action and cleanup failures together', async () => {
  const operation = new Error('action failed'); const cleanup = new Error('release failed');
  const releases = [vi.fn(async () => {}), vi.fn(async () => { throw cleanup; }), vi.fn(async () => {})];
  for (const release of releases) doubles.acquire.mockResolvedValueOnce(release);
  const result = withManagerLifecycleLocks('/config', ids, signal(), async () => { throw operation; });
  await expect(result).rejects.toMatchObject({ errors: [operation, cleanup] });
  for (const release of releases) expect(release).toHaveBeenCalledOnce();
});

it('propagates a release failure after a successful action', async () => {
  const failure = new Error('release failed');
  doubles.acquire.mockResolvedValue(async () => { throw failure; });
  await expect(withManagerLifecycleLock('/config', ids[0]!, signal(), async () => 'done')).rejects.toBe(failure);
});

it('does not apply the acquisition timeout to the protected operation', async () => {
  vi.useFakeTimers();
  const release = vi.fn(async () => {}); doubles.acquire.mockResolvedValue(release);
  const abortSignal = signal();
  const result = withManagerLifecycleLock('/config', ids[0]!, abortSignal, async () => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    abortSignal.throwIfAborted(); return 'done';
  });
  await vi.advanceTimersByTimeAsync(6000);
  await expect(result).resolves.toBe('done');
  expect(release).toHaveBeenCalledOnce();
});
