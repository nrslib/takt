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
  const transport = { send: vi.fn(async (message: TurnProcessMessage) => { messages.push(message); sent.get(message.kind)?.resolve(message); }) };
  const runtime = createTurnProcessRuntime({ createBusiness: () => ({ execute, close }), onFatal,
    transport });
  const envelope = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'launch' };
  const wait = (kind: string) => { const value = deferred<TurnProcessMessage>(); sent.set(kind, value); return value.promise; };
  const initialize = () => runtime.receive({ ...envelope, kind: 'initialize', conversationId: turnStart().turn.conversationId,
    assignment: turnStart().state.assignment, configDirectory: '/config' });
  return { runtime, messages, wait, initialize, execute, close, onFatal, envelope, transport };
}

it('sends typed activity through the existing progress transport before the final result', async () => {
  const f = fixture(vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    io.progress({ kind: 'thinking' });
    io.progress({ kind: 'tool', tool: 'Bash' });
    io.progress({ kind: 'responding' });
    return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
  }));
  await f.initialize();
  const input = turnStart();
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input });
  await done;
  expect(f.messages.filter((value) => value.kind === 'turn_progress')).toEqual([
    { ...f.envelope, kind: 'turn_progress', turn: input.turn, message: { kind: 'thinking' } },
    { ...f.envelope, kind: 'turn_progress', turn: input.turn, message: { kind: 'responding' } },
  ]);
  expect(f.messages.at(-1)?.kind).toBe('turn_finished');
  expect(f.onFatal).not.toHaveBeenCalled();
  await f.runtime.disconnect();
});

it('coalesces repeated activity bursts behind slow sends and finishes without waiting for activity', async () => {
  const entered = deferred<TurnIo>();
  const finish = deferred<void>();
  const f = fixture(vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    entered.resolve(io);
    await finish.promise;
    return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
  }));
  await f.initialize();
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const send = f.transport.send.getMockImplementation()!;
  const progress = () => f.messages.filter((message) => message.kind === 'turn_progress');
  f.transport.send.mockImplementation(async (message) => {
    await send(message);
    if (message.kind === 'turn_progress') await gates[progress().length - 1]!.promise;
  });
  const input = turnStart();
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input });
  const io = await entered.promise;
  io.progress({ kind: 'thinking' });
  for (let wave = 0; wave < 2; wave++) {
    for (let index = 0; index < MAX_PROCESS_PENDING_REQUESTS * 2; index++) {
      io.progress({ kind: 'tool', tool: `Tool${index}` });
      io.progress({ kind: 'waiting' });
    }
    io.progress({ kind: 'tool', tool: `Latest${wave}` });
    expect(progress()).toHaveLength(wave + 1);
    gates[wave]!.resolve();
    await vi.waitFor(() => expect(progress()).toHaveLength(wave + 2));
    expect(progress().at(-1)).toMatchObject({ message: { kind: 'tool', tool: `Latest${wave}` } });
  }
  io.progress({ kind: 'responding' });
  finish.resolve();
  expect(await done).toMatchObject({ outcome: { kind: 'completed' } });
  io.progress({ kind: 'tool', tool: 'TooLate' });
  gates[2]!.resolve();
  await f.runtime.disconnect();
  expect(progress().map((message) => message.message)).toEqual([
    { kind: 'thinking' }, { kind: 'tool', tool: 'Latest0' }, { kind: 'tool', tool: 'Latest1' },
  ]);
  expect(f.onFatal).not.toHaveBeenCalled();
});

it('disables failed activity delivery without failing the turn or retrying queued activity', async () => {
  const entered = deferred<TurnIo>();
  const finish = deferred<void>();
  const f = fixture(vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    entered.resolve(io);
    await finish.promise;
    return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
  }));
  await f.initialize();
  const failed = deferred<void>();
  const send = f.transport.send.getMockImplementation()!;
  f.transport.send.mockImplementation(async (message) => {
    await send(message);
    if (message.kind === 'turn_progress') await failed.promise;
  });
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: turnStart() });
  const io = await entered.promise;
  io.progress({ kind: 'thinking' });
  io.progress({ kind: 'responding' });
  failed.reject(new Error('Activity transport unavailable'));
  await vi.waitFor(() => expect(f.transport.send.mock.settledResults.at(-1)?.type).toBe('rejected'));
  io.progress({ kind: 'tool', tool: 'Unavailable' });
  finish.resolve();
  expect(await done).toMatchObject({ outcome: { kind: 'completed' } });
  expect(f.messages.filter((message) => message.kind === 'turn_progress')).toHaveLength(1);
  expect(f.onFatal).not.toHaveBeenCalled();
  await f.runtime.disconnect();
});

it('keeps only one activity send in flight when the child is reused for the next turn', async () => {
  const finish = deferred<void>();
  const f = fixture(vi.fn(async (input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    io.progress({ kind: 'tool', tool: `Generation${input.turn.generation}` });
    if (input.turn.generation === 2) await finish.promise;
    return { kind: 'completed', result: { kind: 'reply', message: 'done' } };
  }));
  await f.initialize();
  const blocked = deferred<void>();
  const send = f.transport.send.getMockImplementation()!;
  f.transport.send.mockImplementation(async (message) => {
    await send(message);
    if (message.kind === 'turn_progress') await blocked.promise;
  });
  const first = turnStart();
  const done = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: first });
  await done;
  await f.runtime.receive({ ...f.envelope, kind: 'result_committed', turn: first.turn });
  const second = turnStart(2);
  const next = f.wait('turn_finished');
  await f.runtime.receive({ ...f.envelope, kind: 'start_turn', input: second });
  const progress = () => f.messages.filter((message) => message.kind === 'turn_progress');
  expect(progress()).toHaveLength(1);
  blocked.resolve();
  await vi.waitFor(() => expect(progress()).toHaveLength(2));
  expect(progress()[1]).toMatchObject({ turn: second.turn, message: { kind: 'tool', tool: 'Generation2' } });
  finish.resolve();
  await next;
  expect(f.onFatal).not.toHaveBeenCalled();
  await f.runtime.disconnect();
});

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
it('bounds pending requests and releases every waiter on disconnect', async () => {
  const execute = vi.fn(async (_input: TurnStart, io: TurnIo): Promise<TurnOutcome> => {
    io.progress({ kind: 'thinking' });
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
  expect(f.onFatal).not.toHaveBeenCalled();
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
