import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { HttpResponseResources } from '../features/mcp/responseResources.js';
import { deferred } from './helpers/daemon-turn.js';

function response() {
  const events = new EventEmitter();
  const value = Object.assign(events, { writableFinished: false, destroy: vi.fn(() => { events.emit('close'); }) });
  return { value: value as unknown as ServerResponse, destroy: value.destroy,
    finish() { value.writableFinished = true; events.emit('finish'); events.emit('close'); } };
}
const signal = () => new AbortController().signal;

it('requires a corresponding HTTP response before entering the action', async () => {
  const action = vi.fn();
  await expect(new HttpResponseResources().run(signal(), action)).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
});

it('holds resources after handler completion, releases once at finish, and isolates other responses', async () => {
  const owner = new HttpResponseResources(); const first = response(); const second = response();
  const releaseA = vi.fn(async () => {}); const releaseB = vi.fn(async () => {});
  await owner.handle(first.value, () => owner.run(signal(), async (_signal, retain) => { await retain('resource', async () => releaseA); }));
  await owner.handle(second.value, () => owner.run(signal(), async (_signal, retain) => { await retain('resource', async () => releaseB); }));
  expect(releaseA).not.toHaveBeenCalled(); expect(releaseB).not.toHaveBeenCalled();
  first.finish();
  expect(releaseA).toHaveBeenCalledOnce(); expect(releaseB).not.toHaveBeenCalled();
  second.finish(); await owner.close();
  expect(releaseA).toHaveBeenCalledOnce(); expect(releaseB).toHaveBeenCalledOnce();
});

it.each(['abort', 'disconnect', 'shutdown'] as const)('closes the response on %s and waits for the active operation before releasing', async (mode) => {
  const owner = new HttpResponseResources(); const res = response(); const controller = new AbortController();
  const entered = deferred<void>(); const finish = deferred<void>(); const release = vi.fn(async () => {});
  const operation = owner.handle(res.value, () => owner.run(controller.signal, async (active, retain) => {
    await retain('resource', async () => release); entered.resolve(); await finish.promise;
    expect(active.aborted).toBe(true);
  }));
  await entered.promise;
  if (mode === 'abort') controller.abort();
  if (mode === 'disconnect') res.value.emit('close');
  const closing = mode === 'shutdown' ? owner.close() : undefined;
  expect(release).not.toHaveBeenCalled();
  finish.resolve(); await operation; await closing; await owner.close();
  expect(release).toHaveBeenCalledOnce();
});

it('also closes and reclaims an aborted request after its handler has returned', async () => {
  const owner = new HttpResponseResources(); const res = response(); const controller = new AbortController();
  const release = vi.fn(async () => {});
  await owner.handle(res.value, () => owner.run(controller.signal, async (_signal, retain) => { await retain('resource', async () => release); }));
  controller.abort(); await owner.close();
  expect(res.destroy).toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});

it('retains resources through an error response and reports every release failure at shutdown', async () => {
  const owner = new HttpResponseResources(); const res = response(); const error = new Error('release failed');
  const release = vi.fn(async () => {});
  await expect(owner.handle(res.value, () => owner.run(signal(), async (_signal, retain) => {
    await retain('first', async () => release); await retain('second', async () => async () => { throw error; }); throw new Error('preparation failed');
  }))).rejects.toThrow('preparation failed');
  expect(release).not.toHaveBeenCalled(); res.finish();
  await expect(owner.close()).rejects.toMatchObject({ errors: [error] });
  expect(release).toHaveBeenCalledOnce();
});

it('shares pending and acquired resources within one response while keeping each action and key independent', async () => {
  const owner = new HttpResponseResources(); const res = response();
  const entered = deferred<void>(); const ready = deferred<() => Promise<void>>();
  const release = vi.fn(async () => {}); const otherRelease = vi.fn(async () => {});
  const acquire = vi.fn(async () => { entered.resolve(); return ready.promise; });
  const prepared: string[] = [];
  const action = (name: string) => owner.run(signal(), async (_signal, retain) => {
    await retain('repository', acquire); prepared.push(name); return name;
  });
  await owner.handle(res.value, async () => {
    const first = action('first'); await entered.promise;
    const second = action('second');
    expect(prepared).toEqual([]); expect(acquire).toHaveBeenCalledOnce();
    ready.resolve(release);
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(await action('third')).toBe('third');
    await owner.run(signal(), async (_signal, retain) => { await retain('other-repository', async () => otherRelease); });
  });
  expect(acquire).toHaveBeenCalledOnce(); expect(prepared).toEqual(['first', 'second', 'third']);
  expect(release).not.toHaveBeenCalled(); expect(otherRelease).not.toHaveBeenCalled();
  res.finish(); await owner.close();
  expect(release).toHaveBeenCalledOnce(); expect(otherRelease).toHaveBeenCalledOnce();
});

it('propagates shared acquisition failure without preparing and allows a later acquisition to succeed', async () => {
  const owner = new HttpResponseResources(); const res = response();
  const ready = deferred<() => Promise<void>>(); const entered = deferred<void>();
  const failure = new Error('acquisition failed'); const release = vi.fn(async () => {}); const prepare = vi.fn();
  const acquire = vi.fn(async () => { entered.resolve(); return ready.promise; });
  await owner.handle(res.value, async () => {
    const action = () => owner.run(signal(), async (_signal, retain) => { await retain('repository', acquire); prepare(); });
    const first = action(); await entered.promise; const second = action();
    const outcomes = Promise.allSettled([first, second]); ready.reject(failure);
    expect(await outcomes).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(acquire).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled();
    await owner.run(signal(), async (_signal, retain) => { await retain('repository', async () => release); prepare(); });
  });
  expect(prepare).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
  res.finish(); await owner.close(); expect(release).toHaveBeenCalledOnce();
});

it.each(['abort', 'disconnect', 'shutdown'] as const)('reclaims a shared acquisition once after every action finishes on %s', async (mode) => {
  const owner = new HttpResponseResources(); const res = response(); const controller = new AbortController();
  const entered = deferred<void>(); const finish = deferred<void>(); const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => release);
  const operation = owner.handle(res.value, () => Promise.all([1, 2].map((index) => owner.run(controller.signal, async (_active, retain) => {
    await retain('repository', acquire);
    if (index === 2) entered.resolve();
    await finish.promise;
  }))));
  await entered.promise;
  if (mode === 'abort') controller.abort();
  if (mode === 'disconnect') res.value.emit('close');
  const closing = mode === 'shutdown' ? owner.close() : undefined;
  expect(release).not.toHaveBeenCalled(); finish.resolve();
  await operation; await closing; await owner.close();
  expect(acquire).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
