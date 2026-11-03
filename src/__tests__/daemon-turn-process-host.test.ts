import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTurnProcessHost } from '../features/daemon/turnProcessHost.js';
import type { DaemonBus } from '../core/daemon/ports.js';
import type { ManagedProcess } from '../shared/utils/spawn.js';
import type { DaemonProcessMessage, TurnProcessMessage } from '../core/daemon/processProtocol.js';
import { deferred, turnStart } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));

function childFixture() {
  const child = Object.assign(new EventEmitter(), { connected: true }) as ChildProcess;
  const messages: DaemonProcessMessage[] = [];
  const initialized = deferred<void>();
  child.send = vi.fn((message: unknown, callback: unknown) => {
    messages.push(message as DaemonProcessMessage);
    child.emit('sent', message);
    if ((message as DaemonProcessMessage).kind === 'initialize') initialized.resolve();
    (callback as (error: Error | null) => void)(null);
    return true;
  }) as typeof child.send;
  const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const terminated = deferred<void>();
  const terminate = vi.fn(async () => { terminated.resolve(); await exit.promise; });
  const managed: ManagedProcess = { child, wait: () => exit.promise, waitForExit: () => exit.promise, terminate };
  doubles.spawn.mockReturnValue(managed);
  const envelope = () => {
    const initialization = messages.find((message) => message.kind === 'initialize');
    if (initialization === undefined) throw new Error('Not initialized');
    return { protocolVersion: initialization.protocolVersion, launchId: initialization.launchId };
  };
  const receive = (message: Omit<TurnProcessMessage, 'protocolVersion' | 'launchId'>) => child.emit('message', { ...envelope(), ...message });
  return { child, messages, managed, exit, terminated, terminate, envelope, receive, initialized };
}
function fixture() {
  const posted = deferred<void>();
  const post = vi.fn(async (_message: Parameters<DaemonBus['post']>[0]) => { posted.resolve(); });
  const request = vi.fn<DaemonBus['request']>(async () => ({ kind: 'error', code: 'forbidden', message: 'denied' }));
  const onError = vi.fn();
  const host = createTurnProcessHost({ bus: { post, request }, configDirectory: '/config', onError });
  return { host, post, request, posted, onError };
}
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('initializes once, waits for ready, and reuses a committed conversation process', async () => {
  const child = childFixture(); const f = fixture(); const first = turnStart();
  f.host.start(first, new AbortController().signal);
  expect(child.messages.map((message) => message.kind)).toEqual(['initialize']);
  child.receive({ kind: 'ready' });
  expect(child.messages.at(-1)).toMatchObject({ kind: 'start_turn', input: first });
  child.receive({ kind: 'turn_finished', turn: first.turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } } as Omit<TurnProcessMessage, 'protocolVersion' | 'launchId'>);
  await f.posted.promise;
  expect(() => f.host.start(turnStart(2), new AbortController().signal)).toThrow();
  f.host.resultCommitted(first.turn);
  f.host.start(turnStart(2), new AbortController().signal);
  expect(doubles.spawn).toHaveBeenCalledOnce();
  const closing = f.host.close();
  child.receive({ kind: 'shutdown_complete' });
  let closed = false; void closing.then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  child.exit.resolve({ code: 0, signal: null }); await closing;
  expect(f.post).toHaveBeenCalledTimes(2);
});
it('does not release an interrupted turn until forced termination is confirmed', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  f.host.interrupt({ ...input.turn, generation: 99 });
  expect(child.messages.filter((message) => message.kind === 'interrupt')).toHaveLength(0);
  f.host.interrupt(input.turn);
  await vi.runOnlyPendingTimersAsync();
  await child.terminated.promise;
  expect(f.post).not.toHaveBeenCalled();
  expect(() => f.host.start(turnStart(2), new AbortController().signal)).toThrow();
  child.exit.resolve({ code: null, signal: 'SIGKILL' });
  await f.posted.promise;
  expect(f.post).toHaveBeenCalledExactlyOnceWith({ kind: 'turn_finished', turn: input.turn, outcome: { kind: 'interrupted' } });
  await f.host.close();
});
it('treats disconnect as failure only after process exit and ignores stale launch notifications', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  child.child.emit('message', { ...child.envelope(), launchId: 'old', kind: 'turn_finished', turn: input.turn,
    outcome: { kind: 'failed', message: 'old' } });
  expect(f.post).not.toHaveBeenCalled();
  child.child.emit('disconnect'); await child.terminated.promise;
  expect(f.post).not.toHaveBeenCalled();
  child.exit.resolve({ code: 1, signal: null }); await f.posted.promise;
  expect(f.post.mock.calls[0]![0]).toMatchObject({ outcome: { kind: 'failed' } });
  await f.host.close();
});
it('reports one terminal outcome when turn_finished races with exit', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  child.child.emit('message', { ...child.envelope(), kind: 'turn_finished', turn: input.turn,
    outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
  child.exit.resolve({ code: 1, signal: null }); await f.posted.promise; await f.host.close();
  expect(f.post).toHaveBeenCalledOnce();
  expect(f.post.mock.calls[0]![0]).toMatchObject({ outcome: { kind: 'completed' } });
});
it('forwards bounded state requests independently of turn completion and cancels them on disconnect', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  const pending = deferred<Awaited<ReturnType<DaemonBus['request']>>>();
  f.request.mockReturnValue(pending.promise);
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  child.child.emit('message', { ...child.envelope(), kind: 'daemon_request', turn: input.turn, requestId: 'request',
    request: { kind: 'get_delivery', conversationId: 'manager' } });
  expect(f.request).toHaveBeenCalledOnce();
  const signal = f.request.mock.calls[0]![2]; expect(signal.aborted).toBe(false);
  child.child.emit('disconnect'); await child.terminated.promise; expect(signal.aborted).toBe(true);
  pending.resolve({ kind: 'error', code: 'stale_turn', message: 'cancelled' });
  child.exit.resolve({ code: 1, signal: null }); await f.host.close();
  expect(child.messages.some((message) => message.kind === 'daemon_reply')).toBe(false);
});
it('holds close until terminal notifications have reached the bus', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  const notification = deferred<void>(); f.post.mockReturnValue(notification.promise);
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  const closing = f.host.close(); child.exit.resolve({ code: 0, signal: null });
  let closed = false; void closing.then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
  notification.resolve(); await closing; expect(closed).toBe(true);
});
it('preserves the interrupted cleanup change while shutting down', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  const closing = f.host.close();
  child.child.emit('message', { ...child.envelope(), kind: 'turn_finished', turn: input.turn,
    outcome: { kind: 'interrupted', change: { operationId: 'cleanup', expectedVersion: 0, session: { ...input.state.session, sessionId: null } } } });
  child.exit.resolve({ code: 0, signal: null }); await closing;
  expect(f.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: { kind: 'interrupted', change: expect.objectContaining({ operationId: 'cleanup' }) } }));
});
it('fails initialization only after the timed-out child is terminated', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal);
  await vi.runOnlyPendingTimersAsync(); await child.terminated.promise;
  expect(f.post).not.toHaveBeenCalled();
  child.exit.resolve({ code: null, signal: 'SIGTERM' }); await f.posted.promise; await f.host.close();
  expect(f.post).toHaveBeenCalledOnce();
  expect(f.post.mock.calls[0]![0]).toMatchObject({ outcome: { kind: 'failed' } });
});
it('reports synchronous spawn failure without retrying the model turn', async () => {
  doubles.spawn.mockImplementation(() => { throw new Error('spawn failed'); });
  const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); await f.posted.promise;
  expect(doubles.spawn).toHaveBeenCalledOnce();
  expect(f.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turn: input.turn, outcome: { kind: 'failed', message: expect.any(String) } }));
  await f.host.close();
});
it('returns a rejected state request to the child so interrupted cleanup can finish', async () => {
  const child = childFixture(); const f = fixture(); const input = turnStart();
  const pending = deferred<Awaited<ReturnType<DaemonBus['request']>>>(); f.request.mockReturnValue(pending.promise);
  const replied = deferred<void>();
  child.child.on('sent', (message: DaemonProcessMessage) => { if (message.kind === 'daemon_reply') replied.resolve(); });
  f.host.start(input, new AbortController().signal); child.receive({ kind: 'ready' });
  child.child.emit('message', { ...child.envelope(), kind: 'daemon_request', turn: input.turn, requestId: 'request',
    request: { kind: 'save_conversation', change: { operationId: 'save', expectedVersion: 0, session: input.state.session } } });
  f.host.interrupt(input.turn); pending.reject(new Error('cancelled'));
  await replied.promise;
  expect(child.messages.at(-1)).toMatchObject({ kind: 'daemon_reply', requestId: 'request', reply: { kind: 'error', code: 'stale_turn' } });
  expect(child.terminate).not.toHaveBeenCalled();
  child.child.emit('message', { ...child.envelope(), kind: 'turn_finished', turn: input.turn, outcome: { kind: 'interrupted' } });
  child.exit.resolve({ code: 0, signal: null }); await f.host.close();
});

it('waits for the old process to exit before starting the next event after an acknowledgement send failure', async () => {
  const first = childFixture(); const f = fixture(); const input = turnStart();
  f.host.start(input, new AbortController().signal); first.receive({ kind: 'ready' });
  first.child.emit('message', { ...first.envelope(), kind: 'turn_finished', turn: input.turn,
    outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
  await f.posted.promise;
  Object.defineProperty(first.child, 'connected', { value: false });
  f.host.resultCommitted(input.turn); await first.terminated.promise;
  const second = childFixture();
  f.host.start(turnStart(2), new AbortController().signal);
  expect(doubles.spawn).toHaveBeenCalledTimes(1);
  first.exit.resolve({ code: 1, signal: null });
  await second.initialized.promise;
  expect(doubles.spawn).toHaveBeenCalledTimes(2);
  second.receive({ kind: 'ready' });
  const closing = f.host.close(); second.exit.resolve({ code: 0, signal: null }); await closing;
});
