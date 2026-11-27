import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { BuiltinProjectHost } from '../infra/worker-pool/projectHost.js';
import { ProjectRequestSchema, ProjectReplySchema } from '../core/worker-pool/projectProtocol.js';
import { deferred } from './helpers/controlledDaemon.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
beforeEach(() => { vi.resetAllMocks(); });

function fixture() {
  const exited = deferred<{ code: number; signal: null }>();
  const child = Object.assign(new EventEmitter(), { pid: 42, connected: true,
    send: vi.fn((request: { kind: string; id: string }, callback: (error: Error | null) => void) => {
      callback(null);
      if (request.kind === 'shutdown') exited.resolve({ code: 0, signal: null });
    }),
  });
  const terminate = vi.fn(async () => {});
  doubles.spawn.mockReturnValue({ child, waitForExit: () => exited.promise, terminate });
  const finished = vi.fn();
  const host = new BuiltinProjectHost('/project', '/config', finished);
  return { host, child, terminate, finished, exited };
}

it('validates the local protocol and rejects extra fields and invalid responses', () => {
  expect(ProjectRequestSchema.safeParse({ kind: 'start', id: '1', taskName: '', workerName: 'builtin' }).success).toBe(false);
  expect(ProjectRequestSchema.safeParse({ kind: 'start', id: '1', taskName: 'a', workerName: 'builtin', queue: ['b'] }).success).toBe(false);
  expect(ProjectReplySchema.safeParse({ kind: 'snapshot', id: '1', work: { concurrency: 0, available: true, tasks: [] } }).success).toBe(false);
});

it('correlates snapshots and claims and emits completion separately', async () => {
  const f = fixture();
  try {
    const inspected = f.host.inspect();
    const request = f.child.send.mock.calls[0]![0];
    expect(request).toMatchObject({ kind: 'inspect' });
    f.child.emit('message', { kind: 'snapshot', id: request.id, work: { concurrency: 3, available: true, tasks: [] } });
    await expect(inspected).resolves.toEqual({ concurrency: 3, available: true, tasks: [] });
    const started = f.host.start('a', 'builtin');
    const start = f.child.send.mock.calls[1]![0];
    expect(start).toMatchObject({ kind: 'start', taskName: 'a', workerName: 'builtin' });
    f.child.emit('message', { kind: 'started', id: start.id, result: { kind: 'started' } });
    await expect(started).resolves.toEqual({ kind: 'started' });
    f.child.emit('message', { kind: 'finished', taskName: 'a' });
    expect(f.finished).toHaveBeenCalledExactlyOnceWith('a');
  } finally { await f.host.close(); }
  expect(f.terminate).toHaveBeenCalled();
});

it('transfers the candidate origin from the project reply to the dispatcher snapshot', async () => {
  const f = fixture();
  const work = { concurrency: 2, available: true, tasks: [
    { taskName: 'shared', mergeTask: false, origin: 'https://example.com/team/repository.git' },
    { taskName: 'local-only', mergeTask: false },
  ] };
  try {
    const reply = ProjectReplySchema.parse({ kind: 'snapshot', id: 'check', work });
    const inspected = f.host.inspect();
    const request = f.child.send.mock.calls[0]![0];
    f.child.emit('message', { ...reply, id: request.id });
    await expect(inspected).resolves.toEqual(work);
  } finally { await f.host.close(); }
});

it('retains occupied slots until the exited process tree has terminated', async () => {
  const f = fixture();
  const terminated = deferred<void>();
  f.terminate.mockImplementation(() => terminated.promise);
  const snapshot = f.host.inspect();
  const rejected = expect(snapshot).rejects.toThrow('exited');
  f.exited.resolve({ code: 1, signal: null });
  await vi.waitFor(() => expect(f.terminate).toHaveBeenCalled());
  expect(f.finished).not.toHaveBeenCalled();
  terminated.resolve();
  await rejected;
  expect(f.finished).toHaveBeenCalledExactlyOnceWith();
  await f.host.close();
  await expect(f.host.start('a', 'builtin')).rejects.toThrow('closed');
});

it('propagates an error reply without inventing a successful claim', async () => {
  const f = fixture();
  try {
    const started = f.host.start('a', 'builtin');
    const rejected = expect(started).rejects.toThrow('claim failed');
    f.child.emit('message', { kind: 'error', id: f.child.send.mock.calls[0]![0].id, message: 'claim failed' });
    await rejected;
    expect(f.finished).not.toHaveBeenCalled();
  } finally { await f.host.close(); }
});

it.each([
  { kind: 'declined' }, { kind: 'preparation_failed', message: 'provider unavailable' },
  { kind: 'claim_retry', retryAt: 5000 },
] as const)('returns $kind without closing the host or holding the request open', async (result) => {
  const f = fixture();
  try {
    const started = f.host.start('b', 'builtin');
    f.child.emit('message', { kind: 'started', id: f.child.send.mock.calls[0]![0].id, result });
    await expect(started).resolves.toEqual(result);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.finished).not.toHaveBeenCalled();
    const update = f.host.setWaitingReasons([{ taskName: 'b', reason: 'Waiting for an available worker slot' }]);
    expect(f.child.send.mock.calls[1]![0]).toMatchObject({ kind: 'waiting', reasons: [{ taskName: 'b', reason: expect.any(String) }] });
    f.child.emit('message', { kind: 'updated', id: f.child.send.mock.calls[1]![0].id });
    await update;
  } finally { await f.host.close(); }
});

it('rejects pending work after a failed spawn without trying to terminate a missing PID', async () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, connected: false, send: vi.fn() });
  const terminate = vi.fn();
  doubles.spawn.mockReturnValue({ child, waitForExit: async () => { throw new Error('spawn failed'); }, terminate });
  const finished = vi.fn();
  const host = new BuiltinProjectHost('/project', '/config', finished);
  await vi.waitFor(() => expect(finished).toHaveBeenCalledExactlyOnceWith());
  await expect(host.start('a', 'builtin')).rejects.toThrow('closed');
  await host.close();
  expect(terminate).not.toHaveBeenCalled();
});

it.each(['inspect', 'waiting'] as const)('returns acquisition retry from %s without a successful snapshot or update', async (operation) => {
  const f = fixture();
  try {
    const result = operation === 'inspect' ? f.host.inspect() : f.host.setWaitingReasons([{ taskName: 'b', reason: 'waiting' }]);
    const request = f.child.send.mock.calls[0]![0];
    expect(request.kind).toBe(operation);
    f.child.emit('message', { kind: 'claim_retry', id: request.id, retryAt: 5000 });
    await expect(result).resolves.toEqual({ kind: 'claim_retry', retryAt: 5000 });
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.finished).not.toHaveBeenCalled();
    expect(ProjectReplySchema.safeParse({ kind: 'claim_retry', id: request.id, retryAt: Infinity }).success).toBe(false);
  } finally { await f.host.close(); }
});
