import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonIngress } from '../core/daemon/ports.js';
import { startManagerPatrols, type ManagerPatrolTarget } from '../features/daemon/patrols.js';
import { WATCH_INTERVALS, type WatchLoop } from '../features/daemon/watchers/loop.js';

const initialTime = Date.parse('2026-11-08T00:00:00Z');
const interval = 1_800_000;
const repositoryDirectory = '/workspace/a/service';
const loops: WatchLoop[] = [];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(initialTime); });
afterEach(async () => {
  for (const loop of loops.splice(0)) await loop.close();
  vi.useRealTimers();
});

function memoryRecords(entries: [string, number][] = []) {
  const values = new Map(entries);
  return {
    values,
    read: vi.fn(async (repository: string) => values.get(repository)),
    write: vi.fn(async (repository: string, lastQueued: number) => { values.set(repository, lastQueued); }),
  };
}

function fixture(options: { records?: ReturnType<typeof memoryRecords>; accept?: DaemonIngress['accept'];
  goalIds?: string[]; pending?: boolean; targets?: ManagerPatrolTarget[] } = {}) {
  const records = options.records ?? memoryRecords();
  const target: ManagerPatrolTarget = { conversationId: 'conversation', repositoryDirectory, intervalSeconds: 1800 };
  let targets = options.targets ?? [target];
  let goalIds = options.goalIds ?? ['goal'];
  let pending = options.pending ?? false;
  const accept = vi.fn<DaemonIngress['accept']>(options.accept ?? (async (input) => ({ kind: 'accepted',
    eventId: input.eventId, operationId: input.eventId, acceptedSequence: 1 })));
  const errors = vi.fn();
  const dependencies = { targets: async () => targets, goals: async () => goalIds, pending: () => pending,
    records, ingress: { accept }, now: Date.now, onError: errors };
  const loop = startManagerPatrols(dependencies);
  loops.push(loop);
  return { records, target, loop, accept, errors,
    setTargets(value: ManagerPatrolTarget[]) { targets = value; },
    setGoals(value: string[]) { goalIds = value; },
    setPending(value: boolean) { pending = value; },
    async observe(at: number) { vi.setSystemTime(at); loop.wake(); await loop.drain(); },
  };
}

it('queues and saves one patrol during the first observation when no timestamp exists', async () => {
  const f = fixture();
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.accept).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation', source: 'daemon',
    event: { kind: 'patrol', repositoryDirectory, goalIds: ['goal'] } }));
  expect(f.records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);
  expect(f.errors).not.toHaveBeenCalled();
});

it('keeps workspace Epic patrols without goals and suppresses duplicate or completed targets', async () => {
  const target = { conversationId: 'workspace-conversation', workspaceId: '650e8400-e29b-41d4-a716-446655440001',
    epicIds: ['650e8400-e29b-41d4-a716-446655440000'], intervalSeconds: 1800 };
  const f = fixture({ targets: [target], goalIds: [] });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: { kind: 'patrol',
    workspaceId: target.workspaceId, epicIds: target.epicIds, goalIds: [] } }));
  expect(f.records.write).toHaveBeenCalledWith(JSON.stringify(['workspace', target.workspaceId]), initialTime);
  f.setPending(true);
  await f.observe(initialTime + interval);
  expect(f.accept).toHaveBeenCalledTimes(1);
  f.setPending(false);
  f.setTargets([]);
  await f.observe(initialTime + 2 * interval);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.errors).not.toHaveBeenCalled();
});

it.each([interval, 4 * interval])('queues only one patrol on startup after %i milliseconds without replaying missed periods', async (elapsed) => {
  const f = fixture({ records: memoryRecords([[repositoryDirectory, initialTime - elapsed]]) });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  await f.observe(initialTime);
  await f.observe(initialTime + interval - 1);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);
});

it('waits until the saved timestamp plus the interval, rather than a full interval after startup', async () => {
  const f = fixture({ records: memoryRecords([[repositoryDirectory, initialTime - 600_000]]) });
  await f.loop.drain();
  expect(f.accept).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_200_000 - 1);
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.records.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.records.write).toHaveBeenCalledWith(repositoryDirectory, initialTime + 1_200_000);
});

it('treats a saved zero timestamp as a previous acceptance', async () => {
  vi.setSystemTime(1000);
  const f = fixture({ records: memoryRecords([[repositoryDirectory, 0]]) });
  await f.loop.drain();
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(interval - 1);
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(interval);
  expect(f.accept).toHaveBeenCalledTimes(1);
});

it('keeps the acceptance interval across three restarts sharing the same records', async () => {
  const records = memoryRecords();
  const first = fixture({ records });
  await first.loop.drain();
  expect(first.accept).toHaveBeenCalledTimes(1);
  await first.loop.close();
  for (const elapsed of [300_000, 600_000, interval - 1]) {
    vi.setSystemTime(initialTime + elapsed);
    const restarted = fixture({ records });
    await restarted.loop.drain();
    expect(restarted.accept).not.toHaveBeenCalled();
    await restarted.loop.close();
  }
  expect(records.write).toHaveBeenCalledTimes(1);
  vi.setSystemTime(initialTime + interval);
  const due = fixture({ records });
  await due.loop.drain();
  expect(due.accept).toHaveBeenCalledTimes(1);
  expect(records.values.get(repositoryDirectory)).toBe(initialTime + interval);
});

it('does not accept or save without goals and waits for the next period when goals return', async () => {
  const previous = initialTime - 4 * interval;
  const f = fixture({ records: memoryRecords([[repositoryDirectory, previous]]), goalIds: [] });
  await f.loop.drain();
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(initialTime + interval);
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.records.write).not.toHaveBeenCalled();
  expect(f.records.values.get(repositoryDirectory)).toBe(previous);
  f.setGoals(['goal']);
  await f.observe(initialTime + interval + 1);
  await f.observe(initialTime + 2 * interval - 1);
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(initialTime + 2 * interval);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.records.write).toHaveBeenCalledWith(repositoryDirectory, initialTime + 2 * interval);
});

it('skips pending patrols without saving and waits for the next period after the slot clears', async () => {
  const f = fixture({ pending: true });
  await f.loop.drain();
  await f.observe(initialTime + interval);
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.records.write).not.toHaveBeenCalled();
  f.setPending(false);
  await f.observe(initialTime + interval + 1);
  await f.observe(initialTime + 2 * interval - 1);
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(initialTime + 2 * interval);
  expect(f.accept).toHaveBeenCalledTimes(1);
});

it('reports a read failure and treats that repository as never patrolled', async () => {
  const records = memoryRecords();
  const error = new Error('read failed');
  records.read.mockRejectedValue(error);
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.anything());
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(records.write).toHaveBeenCalledWith(repositoryDirectory, initialTime);
});

it('reports a write failure while keeping the accepted patrol and subsequent observations', async () => {
  const records = memoryRecords();
  const error = new Error('write failed');
  records.write.mockRejectedValueOnce(error);
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.anything());
  expect(f.accept).toHaveBeenCalledTimes(1);
  await f.observe(initialTime + interval - 1);
  expect(f.accept).toHaveBeenCalledTimes(1);
  await f.observe(initialTime + interval);
  expect(f.accept).toHaveBeenCalledTimes(2);
  expect(records.values.get(repositoryDirectory)).toBe(initialTime + interval);
});

it('limits retries for an unassigned repository and removes its schedule after saving', async () => {
  const records = memoryRecords();
  records.write.mockRejectedValue(new Error('write failed'));
  const f = fixture({ records });
  await f.loop.drain();
  expect(records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);

  f.setTargets([]);
  await f.observe(initialTime + 1000);
  await vi.advanceTimersByTimeAsync(WATCH_INTERVALS.long - 1001);
  expect(records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);

  records.write.mockImplementation(async (repository, lastQueued) => { records.values.set(repository, lastQueued); });
  await vi.advanceTimersByTimeAsync(1);
  expect(records.write).toHaveBeenCalledTimes(2);
  expect(records.values.get(repositoryDirectory)).toBe(initialTime);

  f.setTargets([f.target]);
  await f.observe(initialTime + WATCH_INTERVALS.long + 1);
  expect(records.read).toHaveBeenCalledTimes(2);
  expect(f.accept).toHaveBeenCalledTimes(1);
});

it('accepts later patrols while timestamp writes fail and retries the latest acceptance time', async () => {
  const records = memoryRecords([[repositoryDirectory, initialTime - interval]]);
  records.write.mockRejectedValue(new Error('write failed'));
  const f = fixture({ records });

  await f.loop.drain();
  await f.observe(initialTime + interval);
  await f.observe(initialTime + 2 * interval);
  expect(f.accept).toHaveBeenCalledTimes(3);
  expect(records.write.mock.calls.at(-1)).toEqual([repositoryDirectory, initialTime + 2 * interval]);

  records.write.mockImplementation(async (repository, lastQueued) => { records.values.set(repository, lastQueued); });
  await f.observe(initialTime + 2 * interval + WATCH_INTERVALS.long);
  expect(records.values.get(repositoryDirectory)).toBe(initialTime + 2 * interval);
  expect(records.write.mock.calls.at(-1)).toEqual([repositoryDirectory, initialTime + 2 * interval]);
});

it('continues with another repository after a timestamp write fails', async () => {
  const records = memoryRecords();
  const error = new Error('write failed');
  records.write.mockRejectedValueOnce(error);
  const f = fixture({ records, targets: [
    { conversationId: 'first', repositoryDirectory, intervalSeconds: 1800 },
    { conversationId: 'second', repositoryDirectory: '/workspace/b/service', intervalSeconds: 1800 },
  ] });
  await f.loop.drain();
  expect(f.accept.mock.calls.map(([input]) => input.conversationId)).toEqual(['first', 'second']);
  expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.anything());
  expect(records.values.get('/workspace/b/service')).toBe(initialTime);
});

it('persists a clamped future timestamp so restarts keep the original deadline', async () => {
  const records = memoryRecords([[repositoryDirectory, initialTime + 3_600_000]]);
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.accept).not.toHaveBeenCalled();
  expect(records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);
  await f.loop.close();

  vi.setSystemTime(initialTime + interval / 2);
  const restarted = fixture({ records });
  await restarted.loop.drain();
  expect(restarted.accept).not.toHaveBeenCalled();
  await restarted.observe(initialTime + interval - 1);
  expect(restarted.accept).not.toHaveBeenCalled();
  await restarted.observe(initialTime + interval);
  expect(restarted.accept).toHaveBeenCalledTimes(1);
  expect(records.write).toHaveBeenCalledWith(repositoryDirectory, initialTime + interval);
});

it('retries a failed acceptance timestamp after the patrol clears and preserves it across restart', async () => {
  const records = memoryRecords();
  records.write.mockRejectedValueOnce(new Error('write failed'));
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);
  f.setPending(true);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(records.write).toHaveBeenCalledExactlyOnceWith(repositoryDirectory, initialTime);
  f.setPending(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(records.write).toHaveBeenCalledTimes(2);
  expect(records.values.get(repositoryDirectory)).toBe(initialTime);
  await f.loop.close();

  const restarted = fixture({ records });
  await restarted.loop.drain();
  expect(restarted.accept).not.toHaveBeenCalled();
  await restarted.observe(initialTime + interval - 1);
  expect(restarted.accept).not.toHaveBeenCalled();
  await restarted.observe(initialTime + interval);
  expect(restarted.accept).toHaveBeenCalledTimes(1);
});

it('saves the acceptance completion time and uses it for the next interval', async () => {
  const f = fixture({ accept: async (input) => {
    vi.setSystemTime(Date.now() + 2000);
    return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: 1 };
  } });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.records.write).toHaveBeenCalledWith(repositoryDirectory, initialTime + 2000);
  await f.observe(initialTime + interval);
  await f.observe(initialTime + 2000 + interval - 1);
  expect(f.accept).toHaveBeenCalledTimes(1);
  await f.observe(initialTime + 2000 + interval);
  expect(f.accept).toHaveBeenCalledTimes(2);
});

it('does not overwrite the saved timestamp when admission is rejected', async () => {
  const previous = initialTime - interval;
  const records = memoryRecords([[repositoryDirectory, previous]]);
  const f = fixture({ records, accept: async () => ({ kind: 'rejected', reason: 'capacity' }) });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.records.write).not.toHaveBeenCalled();
  expect(records.values.get(repositoryDirectory)).toBe(previous);
  expect(f.errors).toHaveBeenCalledTimes(1);
});

it('orders repositories in the same conversation by their restored acceptance times', async () => {
  const olderRepository = '/workspace/b/service';
  const records = memoryRecords([[repositoryDirectory, initialTime - 2 * interval], [olderRepository, initialTime - 3 * interval]]);
  const f = fixture({ records, targets: [
    { conversationId: 'conversation', repositoryDirectory, intervalSeconds: 1800 },
    { conversationId: 'conversation', repositoryDirectory: olderRepository, intervalSeconds: 1800 },
  ] });
  // dispatcher と同じく、最初の受付成功後は共有 conversation の枠が埋まる。
  f.accept.mockImplementation(async (input) => {
    f.setPending(true);
    return { kind: 'accepted', eventId: input.eventId, operationId: input.eventId, acceptedSequence: 1 };
  });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.accept.mock.calls[0]![0].event).toMatchObject({ repositoryDirectory: olderRepository });
  expect(records.write).toHaveBeenCalledExactlyOnceWith(olderRepository, initialTime);
});

it.each([900, 3600])('recalculates the existing schedule from the last acceptance when the interval changes to %i seconds', async (seconds) => {
  const records = memoryRecords([[repositoryDirectory, initialTime - 600_000]]);
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.accept).not.toHaveBeenCalled();
  f.setTargets([{ ...f.target, intervalSeconds: seconds }]);
  await f.observe(initialTime + 60_000);
  const due = initialTime - 600_000 + seconds * 1000;
  await f.observe(due - 1);
  expect(f.accept).not.toHaveBeenCalled();
  await f.observe(due);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(records.write).toHaveBeenCalledWith(repositoryDirectory, due);
});

it('uses the in-memory acceptance after a failed write when the interval changes', async () => {
  const records = memoryRecords([[repositoryDirectory, initialTime - 4 * interval]]);
  records.write.mockRejectedValueOnce(new Error('write failed'));
  const f = fixture({ records });
  await f.loop.drain();
  expect(f.accept).toHaveBeenCalledTimes(1);
  f.setTargets([{ ...f.target, intervalSeconds: 900 }]);
  await f.observe(initialTime + 60_000);
  await f.observe(initialTime + 900_000 - 1);
  expect(f.accept).toHaveBeenCalledTimes(1);
  await f.observe(initialTime + 900_000);
  expect(f.accept).toHaveBeenCalledTimes(2);
});

it('drops an unassigned schedule but retains its saved timestamp for reassignment', async () => {
  const previous = initialTime - interval;
  const records = memoryRecords([[repositoryDirectory, previous]]);
  const f = fixture({ records, pending: true });
  await f.loop.drain();
  f.setTargets([]);
  await f.observe(initialTime + 1000);
  expect(f.accept).not.toHaveBeenCalled();
  expect(records.write).not.toHaveBeenCalled();
  expect(records.values.get(repositoryDirectory)).toBe(previous);
  f.setPending(false);
  f.setTargets([f.target]);
  await f.observe(initialTime + 2000);
  expect(f.accept).toHaveBeenCalledTimes(1);
});
