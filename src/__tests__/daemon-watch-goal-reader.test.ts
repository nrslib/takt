import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchGoalReader, type WatchReadRequest } from '../features/daemon/watchers/goalReader.js';
import { WATCH_INTERVALS } from '../features/daemon/watchers/loop.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ worker: vi.fn() }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  postMessage = vi.fn();
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => { await Promise.resolve(); this.emit('exit', 1); return 1; });
  constructor() { super(); doubles.worker(this); }
} }));

afterEach(() => { vi.restoreAllMocks(); doubles.worker.mockClear(); });

it.each(['goal', 'run'] as const)('terminates a stalled %s read at its deadline, rejects queued reads and recovers with a new worker', async (kind) => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const reader = new WatchGoalReader();
  try {
    const first = kind === 'goal' ? reader.read('/repository', 'stalled') : reader.readRunProgress('/meta.json');
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
