import { expect, it, vi } from 'vitest';
import { BuiltinWorkerAdapter } from '../infra/worker-pool/builtinWorkerAdapter.js';
import { TaskDispatcher } from '../features/daemon/taskDispatcher.js';
import type { PoolAssignment, ProjectWork, WorkerProject } from '../core/worker-pool/types.js';
import { randomUUID } from 'node:crypto';
import { RemoteAssignmentSchema } from '../core/worker-pool/remoteProtocol.js';

function fixture(concurrency: number | undefined = 1) {
  const snapshots = new Map<string, ProjectWork>([['R1', { concurrency: 3, available: true,
    tasks: ['a', 'b', 'c'].map((taskName) => ({ taskName, mergeTask: false })) }]]);
  const finished = new Map<string, (taskName?: string) => void>();
  const hosts = new Map<string, WorkerProject & { start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
  const errors = vi.fn();
  const wake = vi.fn();
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency })], onError: errors, wake,
    projects: async () => [...snapshots.keys()], factory: { create(cwd, done) {
      finished.set(cwd, done);
      const host = { inspect: vi.fn(async () => snapshots.get(cwd)!),
        start: vi.fn(async (taskName: string) => {
          snapshots.get(cwd)!.tasks = snapshots.get(cwd)!.tasks.filter((task) => task.taskName !== taskName);
          return { kind: 'started' as const };
        }), setWaitingReasons: vi.fn(async () => ({ kind: 'updated' as const })), close: vi.fn(async () => { done(); }) };
      hosts.set(cwd, host);
      return host;
    } },
  });
  return { pool, hosts, snapshots, finished, errors, wake };
}

it('reserves a shared slot until completion and then dispatches only one pending task', async () => {
  const f = fixture();
  try {
    await Promise.all([f.pool.dispatch(), f.pool.dispatch()]);
    expect(f.hosts.get('R1')!.start.mock.calls).toEqual([['a', 'builtin']]);
    expect(f.pool.activeTaskCount).toBe(1);
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenCalledOnce();
    f.finished.get('R1')!('a');
    expect(f.wake).toHaveBeenCalledOnce();
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start.mock.calls).toEqual([['a', 'builtin'], ['b', 'builtin']]);
  } finally { await f.pool.close(); }
});

it('restores project snapshots without starting pending work until normal dispatch is enabled', async () => {
  const f = fixture();
  try {
    await f.pool.restore();
    expect(f.pool.hasCompleteSnapshot()).toBe(true);
    expect(f.hosts.get('R1')!.start).not.toHaveBeenCalled();
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenCalledExactlyOnceWith('a', 'builtin');
  } finally { await f.pool.close(); }
});

it('restores remote reservations before local dispatch and retains them after the local host exits or the worker disconnects', async () => {
  const f = fixture(1);
  const assignment = RemoteAssignmentSchema.parse({ projectId: 'R1', taskName: 'remote-task', workerId: 'w1', workerName: 'w1',
    registrationGeneration: randomUUID(), executionId: randomUUID(), assignmentGeneration: 1, requestId: 'r1',
    originalSha: 'a'.repeat(40), origin: 'https://example.test/repo.git', branch: 'result', leaseExpiresAt: 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const snapshot = f.snapshots.get('R1')!;
  snapshot.concurrency = 1; snapshot.remoteRecords = [{ status: 'running', assignment }];
  f.pool.setRemoteWorkers([{ name: 'w1', kind: 'remote', concurrency: 1 }]);
  try {
    await f.pool.dispatch();
    expect(f.pool.activeTaskCount).toBe(1);
    expect(f.hosts.get('R1')!.start).not.toHaveBeenCalled();
    expect(f.pool.pull('w1')).toBeUndefined();
    f.finished.get('R1')!(); f.pool.setRemoteWorkers([]);
    expect(f.pool.activeTaskCount).toBe(1);
    await f.pool.dispatch();
    expect(f.pool.activeTaskCount).toBe(1);
    expect(f.hosts.get('R1')!.start).not.toHaveBeenCalled();
    snapshot.remoteRecords = [{ status: 'failed', assignment, failureReason: 'Lease expired' }];
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenCalledExactlyOnceWith('a', 'builtin');
  } finally { await f.pool.close(); }
});

it('rereads the pending queue after cancellation before a released slot is reused', async () => {
  const f = fixture();
  try {
    await f.pool.dispatch();
    f.snapshots.get('R1')!.tasks = [{ taskName: 'c', mergeTask: false }];
    f.finished.get('R1')!('a');
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start.mock.calls).toEqual([['a', 'builtin'], ['c', 'builtin']]);
  } finally { await f.pool.close(); }
});

it('counts a failed reservation only against its worker and releases it on the same dispatcher', async () => {
  const f = fixture(0);
  const assignment = RemoteAssignmentSchema.parse({ projectId: 'R1', taskName: 'failed-task', workerId: 'w1', workerName: 'w1',
    registrationGeneration: randomUUID(), executionId: randomUUID(), assignmentGeneration: 1, requestId: 'r1',
    originalSha: 'a'.repeat(40), origin: 'https://example.test/repo.git', branch: 'result', leaseExpiresAt: 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: '/worker/clone', retryReservation: true });
  const snapshot = f.snapshots.get('R1')!;
  snapshot.concurrency = 1;
  snapshot.tasks = [{ taskName: 'a', mergeTask: false, origin: assignment.origin }];
  snapshot.remoteRecords = [{ status: 'failed', assignment, failureReason: 'Provider failed' }];
  f.pool.setRemoteWorkers([{ name: 'w1', kind: 'remote', concurrency: 1 }, { name: 'w2', kind: 'remote', concurrency: 1 }]);
  try {
    await f.pool.restore();
    expect(f.pool.pull('w1')).toBeUndefined();
    const other = f.pool.pull('w2');
    expect(other).toEqual({ projectId: 'R1', taskName: 'a', workerName: 'w2' });
    f.pool.release(other!);
    snapshot.remoteRecords = [{ status: 'failed', assignment: { ...assignment, retryReservation: false } }];
    await f.pool.restore();
    expect(f.pool.pull('w1')).toEqual({ projectId: 'R1', taskName: 'a', workerName: 'w1' });
  } finally { await f.pool.close(); }
});

it('does not claim zero-capacity work and supplies a waiting reason to the project', async () => {
  const f = fixture(0);
  try {
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.setWaitingReasons).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ taskName: 'a', reason: expect.stringContaining('concurrency is 0') }),
    ]));
    expect(f.hosts.get('R1')!.start).not.toHaveBeenCalled();
    expect(f.pool.activeTaskCount).toBe(0);
  } finally { await f.pool.close(); }
});

it('shares two worker slots between two projects with one project slot each', async () => {
  const f = fixture(2);
  f.snapshots.get('R1')!.concurrency = 1;
  f.snapshots.set('R2', { concurrency: 1, available: true,
    tasks: ['d', 'e'].map((taskName) => ({ taskName, mergeTask: false })) });
  try {
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start.mock.calls).toEqual([['a', 'builtin']]);
    expect(f.hosts.get('R2')!.start.mock.calls).toEqual([['d', 'builtin']]);
    expect(f.pool.activeTaskCount).toBe(2);
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenCalledOnce();
    expect(f.hosts.get('R2')!.start).toHaveBeenCalledOnce();
    f.finished.get('R1')!('a');
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenLastCalledWith('b', 'builtin');
    expect(f.hosts.get('R2')!.start).toHaveBeenCalledOnce();
    expect(f.pool.activeTaskCount).toBe(2);
  } finally { await f.pool.close(); }
});

it('preserves separate project concurrency with no configured builtin limit', async () => {
  const f = fixture();
  // Construct an adapter without a global limit.
  const starts = vi.fn(async () => ({ kind: 'started' as const }));
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: undefined })], onError: f.errors, wake: f.wake,
    projects: async () => ['R1', 'R2'], factory: { create: () => ({
      inspect: async () => ({ concurrency: 3, available: true,
        tasks: ['a', 'b', 'c'].map((taskName) => ({ taskName, mergeTask: false })) }),
      start: starts, setWaitingReasons: async () => ({ kind: 'updated' }), close: async () => {},
    }) },
  });
  try { await pool.dispatch(); expect(starts).toHaveBeenCalledTimes(6); }
  finally { await pool.close(); }
});

it('does not start while manual project execution holds ownership', async () => {
  const f = fixture();
  try {
    f.snapshots.get('R1')!.available = false;
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).not.toHaveBeenCalled();
    f.snapshots.get('R1')!.available = true;
    await f.pool.dispatch();
    expect(f.hosts.get('R1')!.start).toHaveBeenCalledExactlyOnceWith('a', 'builtin');
  } finally { await f.pool.close(); }
});

it.each(['rejected claim', 'start error'] as const)('releases a reservation after %s', async (kind) => {
  const f = fixture();
  try {
    await f.pool.dispatch();
    f.finished.get('R1')!('a');
    const host = f.hosts.get('R1')!;
    if (kind === 'start error') host.start.mockRejectedValueOnce(new Error('spawn failed'));
    else host.start.mockResolvedValueOnce({ kind: 'declined' });
    await f.pool.dispatch();
    expect(f.pool.activeTaskCount).toBe(0);
    if (kind === 'start error') expect(f.errors).toHaveBeenCalledOnce();
    await f.pool.dispatch();
    expect(f.pool.activeTaskCount).toBe(1);
  } finally { await f.pool.close(); }
});

it('closes each project host and refuses dispatch after shutdown', async () => {
  const f = fixture();
  await f.pool.dispatch();
  const host = f.hosts.get('R1')!;
  await f.pool.close();
  await f.pool.dispatch();
  expect(host.close).toHaveBeenCalledOnce();
  expect(host.start).toHaveBeenCalledOnce();
  expect(f.pool.activeTaskCount).toBe(0);
});

it('reports preparation failure while preserving the host and the running assignment', async () => {
  const f = fixture(2);
  try {
    await f.pool.dispatch();
    f.finished.get('R1')!('b');
    const host = f.hosts.get('R1')!;
    host.start.mockResolvedValueOnce({ kind: 'preparation_failed', message: 'provider unavailable' });
    await f.pool.dispatch();
    expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'provider unavailable' }));
    expect(host.close).not.toHaveBeenCalled();
    expect(f.pool.activeTaskCount).toBe(1);
  } finally { await f.pool.close(); }
});

it('does not let one project spawn failure block another project', async () => {
  const starts = vi.fn(async () => ({ kind: 'started' as const }));
  const errors = vi.fn();
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 1 })], onError: errors, wake: vi.fn(),
    projects: async () => ['unavailable', 'healthy'], factory: { create(cwd) {
      if (cwd === 'unavailable') throw new Error('spawn failed');
      return { inspect: async () => ({ concurrency: 1, available: true, tasks: [{ taskName: 'a', mergeTask: false }] }),
        start: starts, setWaitingReasons: async () => ({ kind: 'updated' }), close: async () => {} };
    } },
  });
  try {
    await pool.dispatch();
    expect(errors).toHaveBeenCalledOnce();
    expect(starts).toHaveBeenCalledExactlyOnceWith('a', 'builtin');
  } finally { await pool.close(); }
});

it('hands assignments to remote and builtin adapters through the same pull reservation boundary', async () => {
  const received: PoolAssignment[] = [];
  const started = vi.fn(async () => ({ kind: 'started' as const }));
  const pool = new TaskDispatcher({ projects: async () => ['R1'], wake: vi.fn(), onError: vi.fn(),
    workers: [{ worker: { name: 'remote', kind: 'remote', concurrency: 1 }, async dispatch(port) {
      const assignment = port.pull('remote');
      if (assignment !== undefined) received.push(assignment);
      expect(port.pull('remote')).toBeUndefined();
    } }, new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 1 })],
    factory: { create: () => ({ inspect: async () => ({ concurrency: 2, available: true, tasks: [
      { taskName: 'ordinary', mergeTask: false, origin: 'https://example.com/team/repository.git' }, { taskName: 'merge', mergeTask: true },
      { taskName: 'waiting', mergeTask: false, origin: 'https://example.com/team/repository.git' },
    ] }), start: started, setWaitingReasons: async () => ({ kind: 'updated' }), close: async () => {} }) },
  });
  const pull = vi.spyOn(pool, 'pull');
  try {
    await pool.dispatch();
    expect(received).toEqual([{ projectId: 'R1', taskName: 'ordinary', workerName: 'remote' }]);
    expect(started).toHaveBeenCalledExactlyOnceWith('merge', 'builtin');
    expect(pull.mock.results.map((result) => result.value).filter(Boolean)).toEqual([
      { projectId: 'R1', taskName: 'ordinary', workerName: 'remote' },
      { projectId: 'R1', taskName: 'merge', workerName: 'builtin' },
    ]);
    expect(pool.activeTaskCount).toBe(2);
    expect(pool.pull('builtin')).toBeUndefined();
  } finally { await pool.close(); }
});

it('updates the project-limit waiting reason even without a global worker limit', async () => {
  const f = fixture();
  f.snapshots.get('R1')!.concurrency = 1;
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: undefined })],
    projects: async () => ['R1'], factory: { create: () => ({ inspect: async () => f.snapshots.get('R1')!,
      start: async () => ({ kind: 'started' }), setWaitingReasons: async (reasons) => { f.wake(reasons); return { kind: 'updated' }; }, close: async () => {} }) },
    wake: vi.fn(), onError: f.errors,
  });
  try {
    await pool.dispatch();
    expect(f.wake).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
      taskName: 'b', reason: expect.stringMatching(/waiting.*worker slot.*project concurrency/i),
    })]));
  } finally { await pool.close(); }
});

it.each(['inspect', 'waiting'] as const)('preserves active ownership and discards stale candidates after %s acquisition retry', async (operation) => {
  const f = fixture();
  try {
    await f.pool.dispatch();
    const host = f.hosts.get('R1')!;
    const retry = { kind: 'claim_retry' as const, retryAt: 5000 };
    if (operation === 'inspect') vi.spyOn(host, 'inspect').mockResolvedValueOnce(retry);
    else vi.spyOn(host, 'setWaitingReasons').mockResolvedValueOnce(retry);
    await f.pool.dispatch();
    expect(host.close).not.toHaveBeenCalled();
    expect(f.errors).not.toHaveBeenCalled();
    expect(f.pool.activeTaskCount).toBe(1);
    expect(host.start).toHaveBeenCalledOnce();
    f.snapshots.get('R1')!.tasks = [{ taskName: 'c', mergeTask: false }];
    f.finished.get('R1')!('a');
    expect(f.pool.pull('builtin')).toBeUndefined();
    await f.pool.dispatch();
    expect(host.start.mock.calls).toEqual([['a', 'builtin'], ['c', 'builtin']]);
  } finally { await f.pool.close(); }
});
