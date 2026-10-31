import { expect, it, vi } from 'vitest';
import { ManagerTurnScheduler } from '../features/manager/managerTurnScheduler.js';

it('shares one manager slot while allowing another manager to run', () => {
  const scheduler = new ManagerTurnScheduler();
  expect(scheduler.tryAcquire('workspace', 'first')).toBe(true);
  expect(scheduler.tryAcquire('workspace', 'second')).toBe(false);
  expect(scheduler.busyOperationId('workspace')).toBe('first');
  expect(scheduler.tryAcquire('another-manager', 'independent')).toBe(true);
  scheduler.release('workspace', 'first');
  expect(scheduler.tryAcquire('workspace', 'second')).toBe(true);
  scheduler.release('workspace', 'second');
  scheduler.release('another-manager', 'independent');
});

it('runs queued director operations in order before waking an event waiter', async () => {
  const scheduler = new ManagerTurnScheduler();
  const queue = ['director-1', 'director-2'];
  const started: string[] = [];
  scheduler.tryAcquire('manager', 'human');
  scheduler.registerDirector('manager', { peek: () => queue[0], start: () => {
    const id = queue[0];
    if (id !== undefined && scheduler.tryAcquire('manager', id)) { queue.shift(); started.push(id); }
  } });
  const waiting = scheduler.acquire('manager', 'event', new AbortController().signal);
  scheduler.release('manager', 'human');
  expect(started).toEqual(['director-1']);
  expect(scheduler.tryAcquire('manager', 'late-human')).toBe(false);
  scheduler.release('manager', 'director-1');
  expect(started).toEqual(['director-1', 'director-2']);
  scheduler.release('manager', 'director-2');
  const release = await waiting;
  expect(scheduler.busyOperationId('manager')).toBe('event');
  release();
  expect(scheduler.busyOperationId('manager')).toBeUndefined();
});

it('refuses a human or event acquisition while only a director message is pending', () => {
  const scheduler = new ManagerTurnScheduler();
  scheduler.registerDirector('manager', { peek: () => 'director', start: vi.fn() });
  expect(scheduler.busyOperationId('manager')).toBe('director');
  expect(scheduler.tryAcquire('manager', 'human')).toBe(false);
  expect(scheduler.tryAcquire('manager', 'event')).toBe(false);
  expect(scheduler.tryAcquire('manager', 'director')).toBe(true);
});

it('cancels an event waiting for a slot without acquiring it later', async () => {
  const scheduler = new ManagerTurnScheduler();
  scheduler.tryAcquire('manager', 'human');
  const controller = new AbortController();
  const reason = new Error('shutdown');
  const waiting = scheduler.acquire('manager', 'event', controller.signal);
  const rejected = expect(waiting).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  scheduler.release('manager', 'human');
  expect(scheduler.busyOperationId('manager')).toBeUndefined();
});

it('rejects release by a different operation and retains the current owner', () => {
  const scheduler = new ManagerTurnScheduler();
  scheduler.tryAcquire('manager', 'owner');
  expect(() => scheduler.release('manager', 'other')).toThrow();
  expect(scheduler.busyOperationId('manager')).toBe('owner');
});
