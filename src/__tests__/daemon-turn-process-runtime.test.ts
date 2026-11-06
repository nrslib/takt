import { expect, it, vi } from 'vitest';
import { createTurnProcessRuntime, type TurnIo } from '../features/daemonTurn/processRuntime.js';
import { TURN_PROTOCOL_VERSION, MAX_PROCESS_PENDING_REQUESTS, type TurnProcessMessage } from '../core/daemon/processProtocol.js';
import { deferred, turnStart } from './helpers/daemon-turn.js';
import type { TurnOutcome, TurnStart } from '../core/daemon/messages.js';

function fixture(execute = vi.fn(async (_input: TurnStart, _io: TurnIo): Promise<TurnOutcome> => ({ kind: 'completed', result: { kind: 'reply', message: 'done' } }))) {
  const messages: TurnProcessMessage[] = [];
  const sent = new Map<string, ReturnType<typeof deferred<TurnProcessMessage>>>();
  const onFatal = vi.fn();
  const close = vi.fn(async () => {});
  const runtime = createTurnProcessRuntime({ createBusiness: () => ({ execute, close }), onFatal,
    transport: { async send(message) { messages.push(message); sent.get(message.kind)?.resolve(message); } } });
  const envelope = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'launch' };
  const wait = (kind: string) => { const value = deferred<TurnProcessMessage>(); sent.set(kind, value); return value.promise; };
  const initialize = () => runtime.receive({ ...envelope, kind: 'initialize', conversationId: turnStart().turn.conversationId,
    assignment: turnStart().state.assignment, configDirectory: '/config' });
  return { runtime, messages, wait, initialize, execute, close, onFatal, envelope };
}

it('initializes without running AI, retains results until committed, and reuses the child', async () => {
  const f = fixture();
  await f.initialize();
  expect(f.execute).not.toHaveBeenCalled();
  const first = turnStart();
  const finished = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: first });
  expect(await finished).toMatchObject({ turn: first.turn, outcome: { kind: 'completed' } });
  await expect(f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: turnStart(2) })).rejects.toThrow();
  await f.runtime.receive({ ...f.envelope, kind: 'result_committed', turn: first.turn });
  const second = turnStart(2);
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: second });
  await done;
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.execute.mock.calls[1]![0].state.session.sessionId).toBe('shared-session');
  await f.runtime.receive({ ...f.envelope, kind: 'shutdown' });
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.messages.at(-1)?.kind).toBe('shutdown_complete');
});
it('handles a state reply while a turn is waiting and ignores a different generation', async () => {
  const execute = vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    const reply = await io.request({ kind: 'get_delivery', conversationId: 'manager' });
    expect(reply.kind).toBe('error');
    return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
  });
  const f = fixture(execute);
  await f.initialize();
  const input = turnStart();
  const requested = f.wait('daemon_request');
  const finished = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input });
  const request = await requested;
  if (request.kind !== 'daemon_request') throw new Error('Expected request');
  await f.runtime.receive({ ...f.envelope, kind: 'daemon_reply', turn: { ...input.turn, generation: 99 }, requestId: request.requestId,
    reply: { kind: 'error', code: 'forbidden', message: 'denied' } });
  expect(f.messages.some((value) => value.kind === 'turn_finished')).toBe(false);
  await f.runtime.receive({ ...f.envelope, kind: 'daemon_reply', turn: input.turn, requestId: request.requestId,
    reply: { kind: 'error', code: 'forbidden', message: 'denied' } });
  await finished;
  await f.runtime.receive({ ...f.envelope, kind: 'shutdown' });
});
it('interrupts only the matching turn and preserves its interrupted change', async () => {
  const gate = deferred<void>();
  const execute = vi.fn(async (input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    await gate.promise;
    expect(io.signal.aborted).toBe(true);
    return { kind: 'interrupted', change: { operationId: 'cleanup', expectedVersion: input.state.version,
      session: { ...input.state.session, sessionId: null } } };
  });
  const f = fixture(execute);
  await f.initialize();
  const input = turnStart();
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input });
  await f.runtime.receive({ ...f.envelope, kind: 'interrupt', turn: { ...input.turn, generation: 2 } });
  expect(f.execute.mock.calls[0]![1].signal.aborted).toBe(false);
  await f.runtime.receive({ ...f.envelope, kind: 'interrupt', turn: input.turn });
  gate.resolve();
  expect(await done).toMatchObject({ outcome: { kind: 'interrupted', change: { session: { sessionId: null } } } });
  await f.runtime.receive({ ...f.envelope, kind: 'shutdown' });
});
it('sends an interrupted legacy message larger than one MiB back to the daemon', async () => {
  const interruptedMessage = 'legacy'.repeat(256 * 1024);
  const execute = vi.fn(async (input: TurnStart): Promise<TurnOutcome> => ({ kind: 'interrupted', change: {
    operationId: 'cleanup', expectedVersion: input.state.version, interruptedMessage,
  } }));
  const f = fixture(execute);
  await f.initialize();
  const input = turnStart();
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input });
  const finished = await done;
  expect(finished.kind).toBe('turn_finished');
  if (finished.kind !== 'turn_finished') throw new Error('Expected turn_finished');
  expect(Buffer.byteLength(JSON.stringify(finished))).toBeGreaterThan(1024 * 1024);
  expect(finished.outcome).toEqual({ kind: 'interrupted', change: {
    operationId: 'cleanup', expectedVersion: input.state.version, interruptedMessage,
  } });
  await f.runtime.receive({ ...f.envelope, kind: 'shutdown' });
});
it('bounds pending requests and releases every waiter on disconnect', async () => {
  const execute = vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    const pending = Array.from({ length: MAX_PROCESS_PENDING_REQUESTS }, () => io.request({ kind: 'get_delivery', conversationId: 'manager' }));
    expect(() => io.request({ kind: 'get_delivery', conversationId: 'manager' })).toThrow();
    await Promise.allSettled(pending);
    return { kind: 'interrupted' };
  });
  const f = fixture(execute);
  await f.initialize();
  const request = f.wait('daemon_request');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: turnStart() });
  await request;
  await f.runtime.disconnect();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.messages.filter((value) => value.kind === 'turn_finished')).toHaveLength(1);
});
it('rejects stale launch and malformed input before execution', async () => {
  const f = fixture(); await f.initialize();
  await expect(f.runtime.receive({ ...f.envelope, launchId: 'stale', kind: 'start_turn', input: turnStart() })).rejects.toThrow();
  await expect(f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: {} })).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  await f.runtime.disconnect();
});
it('waits for initialization cleanup on shutdown and never advertises a ready child afterwards', async () => {
  const initialization = deferred<Awaited<ReturnType<Parameters<typeof createTurnProcessRuntime>[0]['createBusiness']>>>();
  const messages: TurnProcessMessage[] = []; const close = vi.fn(async () => {});
  const runtime = createTurnProcessRuntime({ createBusiness: () => initialization.promise, onFatal: vi.fn(),
    transport: { async send(message) { messages.push(message); } } });
  const input = turnStart(); const envelope = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'initializing' };
  const opening = runtime.receive({ ...envelope, kind: 'initialize', conversationId: input.turn.conversationId,
    assignment: input.state.assignment, configDirectory: '/config' });
  const closing = runtime.receive({ ...envelope, kind: 'shutdown' });
  expect(close).not.toHaveBeenCalled(); expect(messages).toHaveLength(0);
  initialization.resolve({ execute: vi.fn(async () => ({ kind: 'interrupted' as const })), close });
  await Promise.all([opening, closing]);
  expect(close).toHaveBeenCalledOnce();
  expect(messages.map((message) => message.kind)).toEqual(['shutdown_complete']);
});

it('starts resource cleanup before waiting for a blocked execution to finish', async () => {
  const released = deferred<void>();
  const f = fixture(vi.fn(async (): Promise<TurnOutcome> => { await released.promise; return { kind: 'interrupted' }; }));
  f.close.mockImplementation(async () => { released.resolve(); });
  await f.initialize();
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: turnStart() });
  await f.runtime.receive({ ...f.envelope, kind: 'shutdown' });
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.messages.map((message) => message.kind)).toEqual(['ready', 'turn_finished', 'shutdown_complete']);
});
