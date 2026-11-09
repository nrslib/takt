import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startManagerPatrols, type ManagerPatrolTarget } from '../features/daemon/patrols.js';
import { parseDaemonProcessMessage } from '../core/daemon/processProtocol.js';
import { AcceptedEventSchema } from '../infra/daemon/eventRecord.js';
import { accepted, harness, input, deferred } from './helpers/controlledDaemon.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-06T00:00:00Z'); });
afterEach(() => vi.useRealTimers());

async function fixture(timestamps = new Map([['/project', Date.now()], ['/second', Date.now()]])) {
  const h = await harness();
  const target: ManagerPatrolTarget = { conversationId: 'conversation', repositoryDirectory: '/project',
    intervalSeconds: 10 };
  let goalIds: string[] = [randomUUID(), randomUUID()];
  let targets = [target];
  const errors = vi.fn();
  const records = { async read(repository: string) { return timestamps.get(repository); },
    async write(repository: string, lastQueued: number) { timestamps.set(repository, lastQueued); } };
  const dependencies = { targets: async () => targets, goals: async () => goalIds, ingress: h.dispatcher,
    records, pending: (id: string) => h.dispatcher.hasPendingPatrol(id), now: Date.now, onError: errors };
  const loop = startManagerPatrols(dependencies);
  await loop.drain();
  return { ...h, target, loop, errors, goalIds, timestamps, setGoals(ids: string[]) { goalIds = ids; }, setTargets(value: ManagerPatrolTarget[]) { targets = value; },
    async close() { await loop.close(); await h.dispatcher.control({ kind: 'stop' }); } };
}

it('enqueues one repository patrol per interval for all active goals, using the other lane', async () => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.runner.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const first = await f.runner.started(1);
    expect(first.input.event).toMatchObject({ lane: 'other', source: 'daemon', event: {
      kind: 'patrol', repositoryDirectory: '/project', goalIds: f.goalIds } });
    AcceptedEventSchema.parse(first.input.event);
    parseDaemonProcessMessage({ kind: 'start_turn', protocolVersion: 1, launchId: 'launch', input: first.input }, 'launch');
    await f.runner.finish(first);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.runner.calls).toHaveLength(2);
    expect(f.runner.calls[1]!.input.event.eventId).not.toBe(first.input.event.eventId);
    expect(f.errors).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('does not patrol repositories without active goals', async () => {
  const f = await fixture();
  try {
    f.setGoals([]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.runner.calls).toHaveLength(0);
    expect(f.dispatcher.hasPendingEvents).toBe(false);
  } finally { await f.close(); }
});

it('keeps one queued or running patrol per conversation and processes human messages first', async () => {
  const f = await fixture();
  try {
    await f.dispatcher.accept(input('active'));
    const active = await f.runner.started(1);
    // 同じ workspace の別リポジトリにも見回りの予定がある。
    f.setTargets([f.target, { ...f.target, repositoryDirectory: '/second' }]);
    f.loop.wake(); await f.loop.drain();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.dispatcher.hasPendingPatrol('conversation')).toBe(true);
    expect([...f.store.records.values()].filter(({ event }) => event.event.kind === 'patrol')).toHaveLength(1);
    await f.dispatcher.accept(input('human'));
    await f.runner.finish(active);
    const human = await f.runner.started(2);
    expect(human.input.event.eventId).toBe('human');
    await f.runner.finish(human);
    const patrol = await f.runner.started(3);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.runner.calls).toHaveLength(3);
    expect([...f.store.records.values()].filter(({ event }) => event.event.kind === 'patrol')).toHaveLength(1);
    await f.runner.finish(patrol);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.runner.calls).toHaveLength(4);
  } finally { await f.close(); }
});

it('reserves the patrol slot while admission is being persisted', async () => {
  const f = await fixture();
  const entered = deferred<void>(); const release = deferred<void>();
  f.store.beforeAccept = async () => { entered.resolve(); await release.promise; };
  try {
    const tick = vi.advanceTimersByTimeAsync(10000);
    await entered.promise;
    expect(f.dispatcher.hasPendingPatrol('conversation')).toBe(true);
    expect(f.runner.calls).toHaveLength(0);
    release.resolve(); await tick;
    await f.loop.drain();
    expect(f.runner.calls).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

it.each(['tui', 'slack'] as const)('interrupts a running patrol for %s input, retaining queued input and events until the next patrol interval', async (source) => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(10000);
    const patrol = await f.runner.started(1);
    await f.runner.progress(patrol, 'unfinished inspection');
    for (const id of ['E1', 'E2']) accepted(await f.dispatcher.accept(input(id, 'conversation', 'other')));
    expect(patrol.signal.aborted).toBe(false);
    for (const id of ['H1', 'H2']) accepted(await f.dispatcher.accept({ ...input(id), source }));
    expect(patrol.signal.aborted).toBe(true);
    expect(f.runner.interrupts).toEqual([patrol.turn]);
    expect(f.runner.calls).toHaveLength(1);
    for (const id of ['H1', 'H2', 'E1', 'E2']) expect(f.store.records.get(id)?.state).toBe('queued');
    await f.runner.progress(patrol, 'late inspection');
    await f.runner.finish(patrol, { kind: 'completed', result: { kind: 'reply', message: 'partial patrol result' } });
    expect(f.applied.get(patrol.turn.operationId)?.outcome).toEqual({ kind: 'interrupted' });
    expect(f.store.records.get(patrol.input.event.eventId)?.state).toBe('settled');
    expect(f.owner.progress).not.toHaveBeenCalled();
    for (const [index, id] of ['H1', 'H2', 'E1', 'E2'].entries()) {
      const call = await f.runner.started(index + 2);
      expect(call.input.event.eventId).toBe(id);
      expect(call.signal.aborted).toBe(false);
      await f.runner.finish(call);
    }
    expect(f.dispatcher.hasPendingEvents).toBe(false);
    expect(f.dispatcher.hasPendingPatrol('conversation')).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.runner.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    const next = await f.runner.started(6);
    expect(next.input.event.event.kind).toBe('patrol');
    expect(next.input.event.eventId).not.toBe(patrol.input.event.eventId);
    await f.runner.finish(next);
  } finally { await f.close(); }
});

it.each(['tui', 'slack'] as const)('does not interrupt a non-patrol event for %s input and runs it before a queued patrol', async (source) => {
  const f = await fixture();
  try {
    accepted(await f.dispatcher.accept(input('active-event', 'conversation', 'other')));
    const active = await f.runner.started(1);
    await vi.advanceTimersByTimeAsync(10000);
    accepted(await f.dispatcher.accept({ ...input('human'), source }));
    expect(active.signal.aborted).toBe(false);
    expect(f.runner.interrupts).toEqual([]);
    expect(f.runner.calls).toHaveLength(1);
    await f.runner.progress(active, 'event progress');
    expect(f.owner.progress).toHaveBeenCalledWith(active.turn, 'event progress');
    await f.runner.finish(active);
    const human = await f.runner.started(2);
    expect(human.input.event.eventId).toBe('human');
    await f.runner.finish(human);
    const patrol = await f.runner.started(3);
    expect(patrol.input.event.event.kind).toBe('patrol');
    await f.runner.finish(patrol);
  } finally { await f.close(); }
});

it('processes human input and ordinary events before an earlier queued patrol', async () => {
  const f = await fixture();
  try {
    accepted(await f.dispatcher.accept(input('active')));
    const active = await f.runner.started(1);
    await vi.advanceTimersByTimeAsync(10000);
    for (const id of ['E1', 'E2']) accepted(await f.dispatcher.accept(input(id, 'conversation', 'other')));
    accepted(await f.dispatcher.accept(input('human')));
    await f.runner.finish(active);
    for (const [index, id] of ['human', 'E1', 'E2'].entries()) {
      const call = await f.runner.started(index + 2);
      expect(call.input.event.eventId).toBe(id);
      await f.runner.finish(call);
    }
    const patrol = await f.runner.started(5);
    expect(patrol.input.event.event.kind).toBe('patrol');
    await f.runner.finish(patrol);
  } finally { await f.close(); }
});

it('keeps a running patrol when human input is rejected by storage or belongs to another conversation', async () => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(10000);
    const patrol = await f.runner.started(1);
    accepted(await f.dispatcher.accept(input('elsewhere', 'another-conversation')));
    f.store.beforeAccept = async () => { throw new Error('storage unavailable'); };
    expect(await f.dispatcher.accept(input('rejected'))).toEqual({ kind: 'rejected', reason: 'storage' });
    expect(patrol.signal.aborted).toBe(false);
    expect(f.runner.interrupts).toEqual([]);
    await f.runner.finish(patrol);
    expect(f.applied.get(patrol.turn.operationId)?.outcome.kind).toBe('completed');
  } finally { await f.close(); }
});

it('queues one overdue patrol on restart without replaying missed periods', async () => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(10000);
    const previous = await f.runner.started(1);
    await f.runner.finish(previous);
    expect(f.timestamps.get('/project')).toBe(Date.now());
  } finally { await f.close(); }
  vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
  const restarted = await fixture(f.timestamps);
  try {
    expect([...restarted.store.records.values()].filter(({ event }) => event.event.kind === 'patrol')).toHaveLength(1);
    const first = await restarted.runner.started(1);
    expect(first.input.event.event).toMatchObject({ kind: 'patrol', repositoryDirectory: '/project' });
    await restarted.runner.finish(first);
    await vi.advanceTimersByTimeAsync(9999);
    expect(restarted.runner.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarted.runner.calls).toHaveLength(2);
  } finally { await restarted.close(); }
});

it('alternates repositories that share a conversation when their patrols are due together', async () => {
  const f = await fixture();
  try {
    f.setTargets([f.target, { ...f.target, repositoryDirectory: '/second' }]);
    f.loop.wake(); await f.loop.drain();
    await vi.advanceTimersByTimeAsync(10000);
    const first = await f.runner.started(1);
    await f.runner.finish(first);
    await vi.advanceTimersByTimeAsync(10000);
    const second = await f.runner.started(2);
    expect(first.input.event.event).toMatchObject({ repositoryDirectory: '/project' });
    expect(second.input.event.event).toMatchObject({ repositoryDirectory: '/second' });
  } finally { await f.close(); }
});
