import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchGoalReader, type WatchReadRequest } from '../features/daemon/watchers/goalReader.js';
import { WATCH_INTERVALS } from '../features/daemon/watchers/loop.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ worker: vi.fn() }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  postMessage = vi.fn();
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => { await Promise.resolve(); this.emit('exit', 1); return 1; });
  constructor() { super(); doubles.worker(this); }
} }));
vi.mock('../features/daemon/watchers/goalPaths.js', () => ({
  watchGoalDirectory: async (cwd: string, goalId: string) => `${cwd}/.takt/goals/${goalId}`,
}));

afterEach(() => { vi.restoreAllMocks(); doubles.worker.mockClear(); });

it('terminates a stalled goal read at its deadline, rejects queued reads and recovers with a new worker', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const reader = new WatchGoalReader();
  try {
    const first = reader.read('/repository', 'stalled');
    const queued = reader.read('/repository', 'queued');
    const settled = Promise.allSettled([first, queued]);
    expect(timeout).toHaveBeenNthCalledWith(1, WATCH_INTERVALS.long);
    const worker = doubles.worker.mock.calls[0]![0] as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
    const failure = new Error('read deadline');
    deadline.abort(failure);
    expect(await settled).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    const goal = goalRecord();
    const recovered = reader.read('/repository', goal.id);
    expect(doubles.worker).toHaveBeenCalledTimes(2);
    const replacement = doubles.worker.mock.calls[1]![0] as EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
    const request = replacement.postMessage.mock.calls[0]![0] as WatchReadRequest;
    replacement.emit('message', { id: request.id, ok: true, kind: 'goal', goal });
    await expect(recovered).resolves.toEqual(goal);
  } finally { await reader.close(); }
});

it('waits for a stalled notification worker to terminate before releasing the goal save locks on cancellation', async () => {
  const events: string[] = [];
  const exclusive = vi.spyOn(FileAsyncLock.prototype, 'exclusive').mockImplementation(async (_path, action) => {
    try { return await action(); } finally { events.push('released'); }
  });
  const cancellation = new AbortController();
  const reader = new WatchGoalReader();
  try {
    const saving = reader.savePullRequestRetryLimit('/repository', 'goal', 'failure', 'a'.repeat(40), 'ja', {
      signal: cancellation.signal, timeoutMs: 10_000,
    });
    const settled = Promise.allSettled([saving]);
    await vi.waitFor(() => expect(doubles.worker).toHaveBeenCalledOnce());
    const worker = doubles.worker.mock.calls[0]![0] as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>;
    };
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, kind: 'pr-retry-limit', cwd: '/repository',
      goalId: 'goal', failureId: 'failure', expectedSha: 'a'.repeat(40), language: 'ja' });
    expect(exclusive.mock.calls.map(([path]) => path)).toEqual([
      '/repository/.takt/goals/goal/goal.json.lock', '/repository/.takt/goal-execution.lock',
    ]);
    worker.terminate.mockImplementationOnce(async () => {
      await Promise.resolve();
      worker.emit('exit', 1);
      events.push('terminated');
      return 1;
    });
    const failure = new Error('cancel save');
    cancellation.abort(failure);
    expect(await settled).toEqual([{ status: 'rejected', reason: failure }]);
    expect(events).toEqual(['terminated', 'released', 'released']);
  } finally { await reader.close(); }
});
