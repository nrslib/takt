import { describe, expect, it, vi } from 'vitest';
import { accepted, deferred, harness, input, MemoryEventStore, ControlledTurnRunner, turnState } from './helpers/controlledDaemon.js';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import type { TurnIdentity, TurnResult } from '../core/daemon/messages.js';
import type { AssistantCliOverrides } from '../core/config/provider-resolution.js';
import { parseDaemonProcessMessage, TURN_PROTOCOL_VERSION } from '../core/daemon/processProtocol.js';

const interrupt = (turn: TurnIdentity) => ({ kind: 'interrupt' as const, ...turn });

describe('event driven daemon dispatcher', () => {
  it('accepts and persists H1/H2 during T1 without waiting for provider completion', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const replies = await Promise.all([h.dispatcher.accept(input('H1')), h.dispatcher.accept(input('H2'))]);
    expect(replies.map((reply) => reply.kind)).toEqual(['accepted', 'accepted']);
    expect(h.store.records.get('H1')?.state).toBe('queued');
    expect(h.store.records.get('H2')?.state).toBe('queued');
    expect(t1.signal.aborted).toBe(false);
    expect(h.runner.calls).toHaveLength(1);
    await h.runner.finish(t1);
    expect((await h.runner.started(2)).input.event.eventId).toBe('H1');
  });

  it('runs H1 H2 E1 E2 after T1, with global human priority', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    for (const [id, lane] of [['E1', 'other'], ['H1', 'human'], ['E2', 'other'], ['H2', 'human']] as const) {
      await h.dispatcher.accept(input(id, 'conversation', lane));
    }
    await h.runner.finish(t1);
    for (const count of [2, 3, 4, 5]) await h.runner.finish(await h.runner.started(count));
    expect(h.runner.calls.map((call) => call.input.event.eventId)).toEqual(['T1', 'H1', 'H2', 'E1', 'E2']);
  });

  it('preserves acceptance order when Slack persistence completes before the earlier TUI message', async () => {
    const h = await harness();
    const first = deferred<void>();
    h.store.beforeAccept = async (event) => { if (event.eventId === 'H1') await first.promise; };
    const h1 = h.dispatcher.accept(input('H1'));
    const h2 = await h.dispatcher.accept({ ...input('H2'), source: 'slack' });
    accepted(h2);
    expect(h.runner.calls).toHaveLength(0);
    first.resolve();
    const reply = await h1;
    accepted(reply);
    expect(reply.acceptedSequence).toBeLessThan(h2.acceptedSequence);
    const t1 = await h.runner.started(1);
    expect(t1.input.event.eventId).toBe('H1');
    await h.runner.finish(t1);
    expect((await h.runner.started(2)).input.event.eventId).toBe('H2');
  });

  it('starts different conversations in parallel while workspace repositories share a conversation slot', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('repo-a', 'workspace'));
    const first = await h.runner.started(1);
    await h.dispatcher.accept(input('repo-b', 'workspace'));
    await h.dispatcher.accept(input('independent', 'other-conversation'));
    expect((await h.runner.started(2)).input.event.eventId).toBe('independent');
    expect(h.runner.calls).toHaveLength(2);
    await h.runner.finish(first);
    expect((await h.runner.started(3)).input.event.eventId).toBe('repo-b');
  });

  it('accepts another conversation while state reading is paused and cancels before provider start', async () => {
    const h = await harness();
    const entered = deferred<TurnIdentity>();
    const release = deferred<void>();
    const snapshot = h.owner.snapshot;
    h.owner.snapshot = vi.fn(async (id) => {
      entered.resolve(h.store.markStarted.mock.calls[0]![1]);
      await release.promise;
      return snapshot(id);
    });
    await h.dispatcher.accept(input('T1'));
    const turn = await entered.promise;
    expect(await h.dispatcher.accept(input('H1'))).toMatchObject({ kind: 'accepted' });
    expect(await h.dispatcher.control(interrupt(turn))).toEqual({ kind: 'interrupted' });
    release.resolve();
    await h.dispatcher.drain();
    expect(h.runner.calls.map((call) => call.input.event.eventId)).toEqual(['H1']);
    expect(h.applied.get(turn.operationId)?.outcome.kind).toBe('interrupted');
  });

  it('interrupts only T1, retains H1/H2, and ignores stale interrupts and results during T2', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.dispatcher.accept(input('H1'));
    await h.dispatcher.accept(input('H2'));
    expect(await h.dispatcher.control(interrupt(t1.turn))).toEqual({ kind: 'interrupted' });
    expect(t1.signal.aborted).toBe(true);
    expect(h.runner.calls).toHaveLength(1);
    // 終了確認までは同じ session の次ターンを開始しない。
    await h.runner.finish(t1);
    const t2 = await h.runner.started(2);
    expect(h.applied.get(t1.turn.operationId)?.outcome.kind).toBe('interrupted');
    expect(await h.dispatcher.control(interrupt(t1.turn))).toEqual({ kind: 'ignored' });
    expect(await h.dispatcher.control(interrupt({ ...t2.turn, generation: t1.turn.generation }))).toEqual({ kind: 'ignored' });
    await h.runner.finish(t1, { kind: 'completed', result: { kind: 'reply', message: 'late' } });
    await h.runner.progress(t1, 'stale progress');
    expect(h.owner.progress).not.toHaveBeenCalled();
    expect(h.owner.apply).toHaveBeenCalledTimes(1);
    expect(t2.signal.aborted).toBe(false);
    await h.runner.finish(t2);
    expect((await h.runner.started(3)).input.event.eventId).toBe('H2');
  });

  it.each(['completed', 'failed'] as const)('discards %s changes received after interruption', async (kind) => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.dispatcher.control(interrupt(t1.turn));
    const change = { operationId: 'obsolete-change', expectedVersion: 0, session: { ...turnState().session, sessionId: 'obsolete' } };
    await h.runner.finish(t1, kind === 'completed'
      ? { kind, change, result: { kind: 'reply', message: 'late' } }
      : { kind, change, message: 'late failure' });
    expect(h.applied.get(t1.turn.operationId)?.outcome).toEqual({ kind: 'interrupted', change: {
      operationId: t1.turn.operationId, expectedVersion: 0, interruptedMessage: 'T1',
    } });
    expect(h.store.records.get('T1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'interrupted' } } });
  });

  it('persists current interrupted cleanup changes and ignores interrupted changes from stale turns', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.dispatcher.accept(input('H1'));
    await h.dispatcher.control(interrupt(t1.turn));
    const change = {
      operationId: 'interrupt-cleanup', expectedVersion: 0,
      session: { ...turnState().session, sessionId: 'resumable-session' }, approval: null,
    };
    await h.dispatcher.post({ kind: 'turn_finished', turn: { ...t1.turn, generation: t1.turn.generation + 1 }, outcome: { kind: 'interrupted', change } });
    expect(h.owner.apply).not.toHaveBeenCalled();
    h.store.beforeResult = async () => { throw new Error('storage unavailable'); };
    await h.runner.finish(t1, { kind: 'interrupted', change });
    expect(h.runner.calls).toHaveLength(1);
    h.store.beforeResult = async () => {};
    await h.dispatcher.retryStorage();
    const t2 = await h.runner.started(2);
    const interruptedChange = { ...change, interruptedMessage: 'T1' };
    expect(h.applied.get(t1.turn.operationId)?.outcome).toEqual({ kind: 'interrupted', change: interruptedChange });
    expect(h.store.records.get('T1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'interrupted', change: interruptedChange } } });
    await h.runner.finish(t1, { kind: 'interrupted', change: { ...change, operationId: 'stale-cleanup' } });
    expect(h.owner.apply).toHaveBeenCalledTimes(1);
    expect(t2.signal.aborted).toBe(false);
  });

  it('ignores duplicate finish notifications while the first finish is being persisted', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    h.store.beforeSettle = async () => { entered.resolve(); await release.promise; };
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const finishing = h.runner.finish(t1);
    await entered.promise;
    await h.runner.finish(t1, { kind: 'failed', message: 'stale' });
    expect(h.owner.apply).toHaveBeenCalledTimes(1);
    expect(h.runner.committed).toEqual([]);
    release.resolve();
    await finishing;
    expect(h.store.records.get('T1')?.state).toBe('settled');
  });

  it('rejects a failed admission, allows retry, and deduplicates both requestId and eventId', async () => {
    const h = await harness();
    h.store.beforeAccept = async () => { throw new Error('storage unavailable'); };
    expect(await h.dispatcher.accept(input('H1'))).toEqual({ kind: 'rejected', reason: 'storage' });
    expect(h.runner.calls).toHaveLength(0);
    h.store.beforeAccept = async () => {};
    const first = await h.dispatcher.accept(input('H1'));
    accepted(first);
    expect(await h.dispatcher.accept({ ...input('new-event-id'), requestId: 'H1' })).toEqual(first);
    expect(await h.dispatcher.accept({ ...input('H1'), requestId: 'new-request-id' })).toEqual(first);
    await h.dispatcher.drain();
    expect(h.runner.calls).toHaveLength(1);
    expect(h.store.records.size).toBe(1);
  });

  it('discards a rejected admission after publication and runs only the resent message', async () => {
    const h = await harness();
    h.store.afterAccept = async () => { throw new Error('acknowledgement failed after publication'); };
    expect(await h.dispatcher.accept(input('H1'))).toEqual({ kind: 'rejected', reason: 'storage' });
    expect(h.store.records.size).toBe(0);
    h.store.afterAccept = async () => {};
    await h.dispatcher.retryStorage();
    await h.dispatcher.drain();
    expect(h.runner.calls).toHaveLength(0);
    accepted(await h.dispatcher.accept(input('resent-H1')));
    await h.runner.finish(await h.runner.started(1));
    await h.dispatcher.retryStorage();
    expect(h.runner.calls.map((call) => call.input.event.eventId)).toEqual(['resent-H1']);
    expect(h.store.records.has('H1')).toBe(false);
  });

  it('deduplicates simultaneous submissions before admission persistence finishes', async () => {
    const h = await harness();
    const release = deferred<void>();
    h.store.beforeAccept = () => release.promise;
    const first = h.dispatcher.accept(input('H1'));
    const duplicate = h.dispatcher.accept(input('H1'));
    expect(first).toBe(duplicate);
    release.resolve();
    expect(await duplicate).toEqual(await first);
    expect(h.store.accept).toHaveBeenCalledTimes(1);
  });

  it.each(['before-publication', 'after-publication'] as const)('discards a failed admission and releases later messages (%s)', async (phase) => {
    const h = await harness();
    const entered = deferred<void>();
    const write = deferred<void>();
    const pause = async (event: Parameters<typeof h.store.accept>[0]) => {
      if (event.eventId === 'H1') { entered.resolve(); await write.promise; }
    };
    if (phase === 'before-publication') h.store.beforeAccept = pause;
    else h.store.afterAccept = pause;
    const first = h.dispatcher.accept(input('H1'));
    await entered.promise;
    accepted(await h.dispatcher.accept(input('H2')));
    expect(h.runner.calls).toHaveLength(0);
    write.reject(new Error('admission failed'));
    expect(await first).toEqual({ kind: 'rejected', reason: 'storage' });
    const second = await h.runner.started(1);
    expect(second.input.event.eventId).toBe('H2');
    await h.runner.finish(second);
    h.store.beforeAccept = async () => {};
    h.store.afterAccept = async () => {};
    await h.dispatcher.retryStorage();
    accepted(await h.dispatcher.accept(input('resent-H1')));
    await h.runner.finish(await h.runner.started(2));
    await h.dispatcher.retryStorage();
    expect(h.runner.calls.map((call) => call.input.event.eventId)).toEqual(['H2', 'resent-H1']);
    expect(h.store.records.has('H1')).toBe(false);
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store: h.store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    await restored.drain();
    expect(runner.calls).toHaveLength(0);
  });

  it('settles a failed start without calling its provider and preserves later messages', async () => {
    const h = await harness();
    h.store.beforeStart = async () => { throw new Error('start storage'); };
    await h.dispatcher.accept(input('H1'));
    await h.dispatcher.drain();
    await h.dispatcher.accept(input('H2'));
    await h.dispatcher.drain();
    expect(h.runner.calls).toHaveLength(0);
    expect(h.owner.snapshot).not.toHaveBeenCalled();
    expect(h.store.records.get('H1')?.state).toBe('queued');
    h.store.beforeStart = async () => {};
    await h.dispatcher.retryStorage();
    await h.runner.finish(await h.runner.started(1));
    expect(h.store.records.get('H1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'failed' } } });
    expect(h.runner.calls.map((call) => call.input.event.eventId)).toEqual(['H2']);
    expect(h.failures).toHaveBeenCalledWith(expect.objectContaining({ phase: 'start' }));
  });

  it('settles a start committed before acknowledgement failure using its original generation', async () => {
    const h = await harness();
    h.store.afterStart = vi.fn().mockRejectedValueOnce(new Error('start acknowledgement failed')).mockResolvedValue(undefined);
    await h.dispatcher.accept(input('H1'));
    await h.dispatcher.accept(input('H2'));
    const next = await h.runner.started(1);
    expect(next.input.event.eventId).toBe('H2');
    expect(h.store.records.get('H1')).toMatchObject({ state: 'settled', result: { generation: 1, outcome: { kind: 'failed' } } });
    expect(h.store.markStarted.mock.calls.filter(([id]) => id === 'H1').map(([, turn]) => turn.generation)).toEqual([1, 1]);
    await h.runner.finish(next);
  });

  it.each(['checkpoint', 'apply', 'event-store'] as const)('retries only result persistence after %s failure and keeps later admissions', async (phase) => {
    const h = await harness();
    const originalApply = h.owner.apply;
    if (phase === 'apply') h.owner.apply = vi.fn(async () => { throw new Error('apply storage'); });
    else if (phase === 'checkpoint') h.store.beforeResult = async () => { throw new Error('result storage'); };
    else h.store.beforeSettle = async () => { throw new Error('event storage'); };
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.runner.finish(t1);
    await h.dispatcher.accept(input('H1'));
    await h.dispatcher.accept(input('H2'));
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.committed).toEqual([]);
    h.owner.apply = originalApply;
    h.store.beforeResult = async () => {};
    h.store.beforeSettle = async () => {};
    await Promise.all([h.dispatcher.retryStorage(), h.dispatcher.retryStorage()]);
    expect(h.runner.committed).toEqual([t1.turn]);
    await h.runner.finish(await h.runner.started(2));
    expect((await h.runner.started(3)).input.event.eventId).toBe('H2');
    expect(h.runner.calls.filter((call) => call.input.event.eventId === 'T1')).toHaveLength(1);
    expect(h.applied.size).toBe(2);
  });

  it('settles an interrupted start as interrupted even if its start write later fails', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const write = deferred<void>();
    h.store.beforeStart = async () => { entered.resolve(); await write.promise; };
    const admission = await h.dispatcher.accept(input('T1'));
    accepted(admission);
    await entered.promise;
    // generation は開始保存に渡された値を、保存前の観測点で捕捉する。
    const turn = h.store.markStarted.mock.calls[0]![1];
    expect(await h.dispatcher.control(interrupt(turn))).toEqual({ kind: 'interrupted' });
    write.reject(new Error('disk failure'));
    await h.dispatcher.drain();
    h.store.beforeStart = async () => {};
    await h.dispatcher.retryStorage();
    await h.dispatcher.drain();
    expect(h.runner.calls).toHaveLength(0);
    expect(h.store.records.get('T1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'interrupted' } } });
  });

  it('aborts outstanding state requests at shutdown and waits for their cleanup', async () => {
    const h = await harness();
    const toolCleanup = deferred<void>();
    const entered = deferred<AbortSignal>();
    h.stateRequests.handle.mockImplementationOnce(async (_turn, _request, signal) => {
      entered.resolve(signal);
      await toolCleanup.promise;
      signal.throwIfAborted();
      return { kind: 'state_saved', version: 1, duplicate: false };
    });
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const reply = h.dispatcher.request(t1.turn, { kind: 'get_delivery', conversationId: 'conversation' }, t1.signal);
    const signal = await entered.promise;
    const rejected = expect(reply).rejects.toMatchObject({ name: 'AbortError' });
    const stop = h.dispatcher.control({ kind: 'stop' });
    expect(signal.aborted).toBe(true);
    toolCleanup.resolve();
    await rejected;
    expect(await stop).toEqual({ kind: 'stopped' });
  });

  it('does not overwrite new admissions received while end persistence is paused', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    h.store.beforeSettle = async (id) => { if (id === 'T1') { entered.resolve(); await release.promise; } };
    await h.dispatcher.accept(input('T1'));
    const finishing = h.runner.finish(await h.runner.started(1));
    await entered.promise;
    await h.dispatcher.accept(input('H1'));
    release.resolve();
    await finishing;
    expect((await h.runner.started(2)).input.event.eventId).toBe('H1');
    expect(h.store.records.get('H1')?.state).toBe('running');
  });

  it('routes bounded state requests while a turn and another request are pending', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const request = deferred<{ kind: 'state_saved'; version: number; duplicate: boolean }>();
    h.stateRequests.handle.mockImplementationOnce(() => request.promise);
    const change = { operationId: 'save-session', expectedVersion: 0, session: turnState().session };
    const reply = h.dispatcher.request(t1.turn, { kind: 'save_conversation', change }, t1.signal);
    const result = await h.dispatcher.request(t1.turn, { kind: 'get_delivery', conversationId: 'conversation' }, t1.signal);
    expect(result).toEqual({ kind: 'delivery', conversationId: 'conversation', assignment: turnState().assignment, connectedPorts: ['tui'] });
    expect(h.stateRequests.handle).toHaveBeenCalledWith(t1.turn, { kind: 'save_conversation', change }, expect.any(AbortSignal));
    expect(await h.dispatcher.accept(input('H1'))).toMatchObject({ kind: 'accepted' });
    expect(h.runner.calls).toHaveLength(1);
    request.resolve({ kind: 'state_saved', version: 1, duplicate: false });
    expect((await reply).kind).toBe('state_saved');
    await h.runner.finish(t1);
    expect(await h.dispatcher.request(t1.turn, { kind: 'get_delivery', conversationId: 'conversation' }, t1.signal))
      .toMatchObject({ kind: 'error', code: 'stale_turn' });
    expect(h.stateRequests.handle).toHaveBeenCalledTimes(2);
  });

  it.each(['cancelled', 'committed'] as const)('waits for a %s state save at normal turn end before applying results or starting the next turn', async (state) => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.dispatcher.accept(input('independent', 'other-conversation'));
    const independent = await h.runner.started(2);
    const release = deferred<void>();
    const otherRelease = deferred<void>();
    const order: string[] = [];
    let savedVersion = 0;
    const snapshot = h.owner.snapshot;
    h.owner.snapshot = vi.fn(async (id) => {
      const read = await snapshot(id);
      return { ...read, turnState: { ...read.turnState, version: savedVersion } };
    });
    h.stateRequests.handle.mockImplementationOnce(async (_turn, _request, signal) => {
      // 確定済みの場合は、保存後の応答・後始末だけを保留する。
      if (state === 'committed') savedVersion = 1;
      await release.promise;
      order.push('request-cleanup');
      if (state === 'cancelled') {
        signal.throwIfAborted();
        savedVersion = 1;
      }
      return { kind: 'state_saved', version: savedVersion, duplicate: false };
    }).mockImplementationOnce(async () => {
      await otherRelease.promise;
      return { kind: 'state_saved', version: 1, duplicate: false };
    });
    const change = { operationId: 'save-session', expectedVersion: 0, session: turnState().session };
    const reply = h.dispatcher.request(t1.turn, { kind: 'save_conversation', change }, t1.signal);
    const checkedReply = state === 'cancelled' ? expect(reply).rejects.toMatchObject({ name: 'AbortError' })
      : expect(reply).resolves.toMatchObject({ kind: 'state_saved' });
    const otherReply = h.dispatcher.request(independent.turn, { kind: 'save_conversation', change }, independent.signal);
    const requestSignal = h.stateRequests.handle.mock.calls[0]![2];
    const otherSignal = h.stateRequests.handle.mock.calls[1]![2];
    await h.dispatcher.accept(input('H1'));
    h.store.beforeResult = async () => { order.push('result-save'); };
    const finishing = h.runner.finish(t1);
    const retrying = h.dispatcher.retryStorage();
    expect(requestSignal.aborted).toBe(true);
    expect(otherSignal.aborted).toBe(false);
    expect(t1.signal.aborted).toBe(false);
    expect(h.store.saveResult).not.toHaveBeenCalled();
    expect(h.owner.apply).not.toHaveBeenCalled();
    expect(h.runner.calls).toHaveLength(2);
    expect(await h.dispatcher.request(t1.turn, { kind: 'save_conversation', change }, t1.signal)).toMatchObject({ code: 'stale_turn' });
    release.resolve();
    await checkedReply;
    await Promise.all([finishing, retrying]);
    const next = await h.runner.started(3);
    expect(next.input.event.eventId).toBe('H1');
    expect(next.input.state.version).toBe(state === 'committed' ? 1 : 0);
    expect(savedVersion).toBe(state === 'committed' ? 1 : 0);
    expect(order).toEqual(['request-cleanup', 'result-save']);
    expect(h.applied.get(t1.turn.operationId)?.outcome.kind).toBe('completed');
    expect(otherSignal.aborted).toBe(false);
    otherRelease.resolve();
    await otherReply;
    await h.runner.finish(independent);
    await h.runner.finish(next);
  });

  it('delivers current progress and snapshots without waiting for provider completion', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const read = await h.dispatcher.snapshot('conversation');
    expect({ operationId: read.operationId, generation: read.generation }).toEqual({
      operationId: t1.turn.operationId, generation: t1.turn.generation,
    });
    expect(h.owner.snapshot).toHaveBeenCalledWith('conversation');
    await h.runner.progress(t1, 'progress');
    expect(h.owner.progress).toHaveBeenCalledWith(t1.turn, 'progress');
    await h.runner.finish(t1);
    expect(await h.dispatcher.snapshot('conversation')).toMatchObject({ operationId: null, generation: null });
    await h.dispatcher.accept(input('H1'));
    const t2 = await h.runner.started(2);
    expect(await h.dispatcher.snapshot('conversation')).toMatchObject({ operationId: t2.turn.operationId, generation: t2.turn.generation });
  });

  it.each(['delivered', 'failed'] as const)('waits for %s progress before saving the result and starting the next turn', async (delivery) => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    accepted(await h.dispatcher.accept(input('H1')));
    const entered = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    h.owner.progress = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      order.push('progress-finished');
      if (delivery === 'failed') throw new Error('delivery failed');
    });
    h.store.beforeResult = async () => { order.push('result-saved'); };
    const progress = h.runner.progress(t1, 'last progress');
    await entered.promise;
    const finishing = h.runner.finish(t1);
    expect(h.store.saveResult).not.toHaveBeenCalled();
    expect(h.owner.apply).not.toHaveBeenCalled();
    expect(h.runner.calls).toHaveLength(1);
    await h.runner.progress(t1, 'late progress');
    expect(h.owner.progress).toHaveBeenCalledTimes(1);
    // 別会話の終了処理は、T1 の配送待ちに巻き込まない。
    accepted(await h.dispatcher.accept(input('independent', 'other-conversation')));
    const independent = await h.runner.started(2);
    await h.runner.finish(independent);
    expect(h.store.records.get('independent')?.state).toBe('settled');
    expect(h.store.records.get('T1')?.state).toBe('running');
    order.length = 0;
    release.resolve();
    await Promise.all([progress, finishing]);
    const next = await h.runner.started(3);
    expect(next.input.event.eventId).toBe('H1');
    expect(order).toEqual(['progress-finished', 'result-saved']);
    expect(h.store.records.get('T1')?.state).toBe('settled');
    await h.runner.progress(t1, 'stale progress');
    expect(h.owner.progress).toHaveBeenCalledTimes(1);
    if (delivery === 'failed') expect(h.failures).toHaveBeenCalledWith(expect.objectContaining({ phase: 'progress' }));
    await h.runner.finish(next);
  });

  it('attaches the current turn to snapshots while start persistence is paused', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    h.store.beforeStart = async () => { entered.resolve(); await release.promise; };
    await h.dispatcher.accept(input('T1'));
    await entered.promise;
    const turn = h.store.markStarted.mock.calls[0]![1];
    const read = await h.dispatcher.snapshot('conversation');
    expect(read).toMatchObject({ operationId: turn.operationId, generation: turn.generation });
    expect(h.runner.calls).toHaveLength(0);
    expect(await h.dispatcher.control({ kind: 'interrupt', conversationId: read.conversationId, operationId: read.operationId!, generation: read.generation! }))
      .toEqual({ kind: 'interrupted' });
    release.resolve();
    await h.dispatcher.drain();
    expect(await h.dispatcher.snapshot('conversation')).toMatchObject({ operationId: null, generation: null });
  });

  it('saves provider failure once and does not automatically rerun it on storage recovery', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    await h.runner.finish(await h.runner.started(1), { kind: 'failed', message: 'provider error' });
    await h.dispatcher.retryStorage();
    await h.dispatcher.drain();
    expect(h.runner.calls).toHaveLength(1);
    expect(h.store.records.get('T1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'failed' } } });
  });

  it.each(['admission-first', 'result-first'] as const)('closes communication after child exit, request cleanup and admission/result persistence (%s)', async (completionOrder) => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const order: string[] = [];
    const admissionEntered = deferred<void>();
    const save = deferred<void>();
    const exited = deferred<void>();
    const runnerClosed = deferred<void>();
    const requestCleanup = deferred<void>();
    const resultEntered = deferred<void>();
    const resultSave = deferred<void>();
    h.stateRequests.handle.mockImplementationOnce(async (_turn, _request, signal) => {
      signal.addEventListener('abort', () => { order.push('request-cancelled'); }, { once: true });
      await requestCleanup.promise;
      order.push('request-cleaned');
      signal.throwIfAborted();
      return { kind: 'state_saved', version: 1, duplicate: false };
    });
    const reply = h.dispatcher.request(t1.turn, { kind: 'get_delivery', conversationId: 'conversation' }, t1.signal);
    const rejected = expect(reply).rejects.toMatchObject({ name: 'AbortError' });
    h.store.beforeAccept = async () => { admissionEntered.resolve(); await save.promise; };
    h.store.beforeResult = async () => {
      order.push('result-saving');
      resultEntered.resolve();
      await resultSave.promise;
    };
    h.store.beforeSettle = async () => { order.push('result-settling'); };
    h.runner.beforeClose = async () => { await exited.promise; order.push('child-exited'); };
    const closeRunner = h.runner.close.bind(h.runner);
    vi.spyOn(h.runner, 'close').mockImplementation(async () => {
      await closeRunner();
      order.push('runner-closed');
      runnerClosed.resolve();
    });
    h.resources.close.mockImplementation(async () => { order.push('resources-closed'); });
    const pending = h.dispatcher.accept(input('H1')).then((receipt) => { order.push('admission-complete'); return receipt; });
    await admissionEntered.promise;
    const stop = h.dispatcher.control({ kind: 'stop' });
    expect(h.dispatcher.control({ kind: 'stop' })).toBe(stop);
    expect(await h.dispatcher.accept(input('late'))).toEqual({ kind: 'rejected', reason: 'stopping' });
    expect(t1.signal.aborted).toBe(true);
    expect(h.runner.closed).toBe(false);
    expect(order).toEqual(['request-cancelled']);
    expect(h.resources.close).not.toHaveBeenCalled();
    if (completionOrder === 'admission-first') {
      save.resolve();
      expect(await pending).toMatchObject({ kind: 'accepted' });
    }
    exited.resolve();
    requestCleanup.resolve();
    await rejected;
    await resultEntered.promise;
    expect(h.resources.close).not.toHaveBeenCalled();
    resultSave.resolve();
    await runnerClosed.promise;
    if (completionOrder === 'result-first') {
      expect(h.resources.close).not.toHaveBeenCalled();
      save.resolve();
      expect(await pending).toMatchObject({ kind: 'accepted' });
    }
    expect(await stop).toEqual({ kind: 'stopped' });
    expect(h.runner.closed).toBe(true);
    expect(h.resources.close).toHaveBeenCalledTimes(1);
    expect(h.store.records.get('H1')?.state).toBe('queued');
    expect(h.runner.calls).toHaveLength(1);
    expect(h.applied.get(t1.turn.operationId)?.outcome.kind).toBe('interrupted');
    expect(order.indexOf('result-saving')).toBeGreaterThan(order.indexOf('child-exited'));
    expect(order.indexOf('result-saving')).toBeGreaterThan(order.indexOf('request-cleaned'));
    expect(order.indexOf('resources-closed')).toBeGreaterThan(order.indexOf('admission-complete'));
    expect(order.indexOf('resources-closed')).toBeGreaterThan(order.indexOf('result-settling'));
    expect(order.indexOf('resources-closed')).toBeGreaterThan(order.indexOf('runner-closed'));
  });

  it('reports shutdown failure when result persistence fails, retaining its result', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    await h.runner.started(1);
    h.store.beforeSettle = async () => { throw new Error('disk unavailable'); };
    await expect(h.dispatcher.control({ kind: 'stop' })).rejects.toBeInstanceOf(AggregateError);
    h.store.beforeSettle = async () => {};
    await h.dispatcher.retryStorage();
    expect(h.store.records.get('T1')?.state).toBe('settled');
    expect(h.runner.calls).toHaveLength(1);
  });

  it('reports shutdown failure when an admission pending at shutdown fails to persist', async () => {
    const h = await harness();
    const entered = deferred<void>();
    const save = deferred<void>();
    const storageError = new Error('storage unavailable');
    h.store.beforeAccept = async () => { entered.resolve(); await save.promise; };
    const admission = h.dispatcher.accept(input('H1'));
    await entered.promise;
    const stop = h.dispatcher.control({ kind: 'stop' });
    const failedStop = expect(stop).rejects.toBeInstanceOf(AggregateError);
    expect(h.resources.close).not.toHaveBeenCalled();
    save.reject(storageError);
    expect(await admission).toEqual({ kind: 'rejected', reason: 'storage' });
    await failedStop;
    expect(h.failures).toHaveBeenCalledWith({ phase: 'accept', event: expect.objectContaining({ eventId: 'H1' }), error: storageError });
    expect(h.store.records.size).toBe(0);
    expect(h.runner.calls).toHaveLength(0);
    expect(h.runner.closed).toBe(true);
    expect(h.resources.close).toHaveBeenCalledTimes(1);
  });

  it('waits for a result save already being retried when shutdown begins', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    h.store.beforeResult = async () => { throw new Error('storage unavailable'); };
    await h.runner.finish(await h.runner.started(1));
    const entered = deferred<void>();
    const save = deferred<void>();
    h.store.beforeResult = async () => { entered.resolve(); await save.promise; };
    const retry = h.dispatcher.retryStorage();
    await entered.promise;
    const stop = h.dispatcher.control({ kind: 'stop' });
    save.resolve();
    await retry;
    expect(await stop).toEqual({ kind: 'stopped' });
    expect(h.store.records.get('T1')?.state).toBe('settled');
    expect(h.runner.calls).toHaveLength(1);
  });

  it('defers a storage retry arriving during resource closure until shutdown has completed', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    await h.runner.started(1);
    h.store.beforeResult = async () => { throw new Error('storage unavailable'); };
    const closing = deferred<void>();
    const closed = deferred<void>();
    h.resources.close.mockImplementation(async () => { closing.resolve(); await closed.promise; });
    const stop = h.dispatcher.control({ kind: 'stop' });
    const failedStop = expect(stop).rejects.toBeInstanceOf(AggregateError);
    await closing.promise;
    h.store.beforeResult = async () => {};
    const retry = h.dispatcher.retryStorage();
    expect(h.store.saveResult).toHaveBeenCalledTimes(1);
    expect(h.store.records.get('T1')?.state).toBe('running');
    closed.resolve();
    await failedStop;
    await retry;
    expect(h.store.records.get('T1')?.state).toBe('settled');
    expect(h.runner.calls).toHaveLength(1);
  });

  it('rejects capacity before persistence and keeps previously accepted messages', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    await h.runner.started(1);
    for (let i = 0; i < 31; i++) accepted(await h.dispatcher.accept(input(`H${i}`)));
    expect(await h.dispatcher.accept(input('overflow'))).toEqual({ kind: 'rejected', reason: 'capacity' });
    expect(h.store.accept).toHaveBeenCalledTimes(32);
    const huge = input('huge', 'another');
    huge.event = { kind: 'director_message', directorConversationId: 'director', text: 'x'.repeat(1024 * 1024) };
    expect(await h.dispatcher.accept(huge)).toEqual({ kind: 'rejected', reason: 'capacity' });
    expect(h.store.accept).toHaveBeenCalledTimes(32);
  });

  it('restores queued work and interrupts saved running work without calling its provider again', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.dispatcher.accept(input('H1'));
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store: h.store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    const first = await runner.started(1);
    expect(first.input.event.eventId).toBe('H1');
    expect(h.applied.get(t1.turn.operationId)?.outcome.kind).toBe('interrupted');
    expect(await restored.accept(input('T1'))).toMatchObject({ operationId: t1.turn.operationId });
    expect(runner.calls).toHaveLength(1);
  });

  it('persists distinct per-message agent overrides and passes them to start_turn after restoration', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    await h.runner.started(1);
    const overrides: (AssistantCliOverrides | undefined)[] = [
      { provider: 'codex', model: 'first-model' },
      { provider: 'claude-sdk', model: 'second-model' },
      { provider: 'codex' }, { model: 'model-only' }, undefined,
    ];
    for (const [index, agentOverrides] of overrides.entries()) {
      const message = input(`H${index + 1}`);
      if (message.event.kind !== 'human_command') throw new Error('Expected human command');
      message.event = { ...message.event, ...(agentOverrides === undefined ? {} : { agentOverrides }) };
      accepted(await h.dispatcher.accept(message));
      expect(h.store.records.get(message.eventId)).toMatchObject({ state: 'queued', event: message });
    }
    await h.dispatcher.control({ kind: 'stop' });
    const store = new MemoryEventStore();
    for (const [id, record] of h.store.records) {
      store.records.set(id, JSON.parse(JSON.stringify(record)) as typeof record);
    }
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    for (const [index, agentOverrides] of overrides.entries()) {
      const call = await runner.started(index + 1);
      expect(call.input.event.eventId).toBe(`H${index + 1}`);
      const message = parseDaemonProcessMessage(JSON.parse(JSON.stringify({
        protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'restored-child', kind: 'start_turn', input: call.input,
      })), 'restored-child');
      if (message.kind !== 'start_turn' || message.input.event.event.kind !== 'human_command') throw new Error('Expected human start_turn');
      expect(message.input.event.event.agentOverrides).toEqual(agentOverrides);
      expect(message.input.state.session).toEqual(turnState().session);
      await runner.finish(call);
    }
    expect(runner.calls).toHaveLength(overrides.length);
    await restored.control({ kind: 'stop' });
  });

  it('restores a saved result and retries conversation application without provider execution', async () => {
    const h = await harness();
    const apply = h.owner.apply;
    h.owner.apply = vi.fn(async () => { throw new Error('conversation storage unavailable'); });
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    await h.runner.finish(t1, { kind: 'completed', result: { kind: 'reply', message: 'saved result' }, change: { operationId: 'save-session', expectedVersion: 0, session: { provider: 'mock', model: null, sessionId: 'saved-session' } } });
    expect(h.store.records.get('T1')?.state).toBe('settling');
    h.owner.apply = apply;
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store: h.store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    await restored.drain();
    expect(runner.calls).toHaveLength(0);
    expect(h.applied.get(t1.turn.operationId)?.outcome).toMatchObject({ kind: 'completed', change: { operationId: 'save-session', expectedVersion: 0, session: { provider: 'mock', model: null, sessionId: 'saved-session' } } });
    expect(h.store.records.get('T1')?.state).toBe('settled');
  });

  it('reuses a saved interrupted result without adding fields during restoration', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const active = await h.runner.started(1);
    const event = h.store.records.get('T1')!.event;
    const savedResult: TurnResult = { ...active.turn, event, outcome: { kind: 'interrupted', change: {
      operationId: 'saved-cleanup', expectedVersion: 0, session: { ...turnState().session, sessionId: 'saved-session' },
    } } };
    h.store.records.set('T1', { state: 'settling', event, result: savedResult });
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store: h.store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    await restored.drain();
    expect(h.store.saveResult).toHaveBeenCalledWith('T1', savedResult);
    expect(h.applied.get(active.turn.operationId)).toEqual(savedResult);
    expect(h.store.records.get('T1')).toEqual({ state: 'settled', event, result: savedResult });
    expect(runner.calls).toHaveLength(0);
  });

  it('returns durable duplicate admission after restart without queueing a settled event', async () => {
    const h = await harness();
    const admission = await h.dispatcher.accept(input('T1'));
    await h.runner.finish(await h.runner.started(1));
    const store = new MemoryEventStore();
    for (const [id, record] of h.store.records) store.records.set(id, record);
    const runner = new ControlledTurnRunner();
    const restored = await createDaemonDispatcher({
      store, runner, conversations: h.owner, stateRequests: h.stateRequests, resources: h.resources,
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: h.failures,
    });
    runner.bus = restored;
    expect(await restored.accept(input('T1'))).toEqual(admission);
    await restored.drain();
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['state-read', 'process-start'] as const)('records %s failure without losing the next event', async (phase) => {
    const h = await harness();
    if (phase === 'state-read') vi.mocked(h.owner.snapshot).mockRejectedValueOnce(new Error('read failed'));
    else vi.spyOn(h.runner, 'start').mockImplementationOnce(() => { throw new Error('process launch failed'); });
    await h.dispatcher.accept(input('T1'));
    await h.dispatcher.drain();
    expect(h.store.records.get('T1')).toMatchObject({ state: 'settled', result: { outcome: { kind: 'failed' } } });
    await h.dispatcher.accept(input('H1'));
    expect((await h.runner.started(1)).input.event.eventId).toBe('H1');
  });

  it('rejects state requests from stale generations and interrupted turns before dispatch', async () => {
    const h = await harness();
    await h.dispatcher.accept(input('T1'));
    const t1 = await h.runner.started(1);
    const request = { kind: 'get_delivery' as const, conversationId: 'conversation' };
    for (const turn of [{ ...t1.turn, generation: t1.turn.generation + 1 }, { ...t1.turn, operationId: 'other' }]) {
      expect(await h.dispatcher.request(turn, request, t1.signal)).toMatchObject({ code: 'stale_turn' });
    }
    await h.dispatcher.control(interrupt(t1.turn));
    expect(await h.dispatcher.request(t1.turn, request, new AbortController().signal)).toMatchObject({ code: 'stale_turn' });
    expect(h.stateRequests.handle).not.toHaveBeenCalled();
    await h.dispatcher.control({ kind: 'stop' });
    expect(await h.dispatcher.request(t1.turn, request, new AbortController().signal)).toMatchObject({ code: 'stopping' });
  });

  it('passes the accepted event and versioned state unchanged to the turn process', async () => {
    const h = await harness();
    const snapshot = await h.owner.snapshot('conversation');
    snapshot.turnState.version = 7;
    snapshot.cancel = vi.fn();
    h.owner.snapshot = vi.fn(async () => snapshot);
    await h.dispatcher.accept(input('short'));
    const call = await h.runner.started(1);
    expect(call.input).toEqual({ event: h.store.records.get('short')!.event, turn: call.turn, state: snapshot.turnState });
    expect(call.input.state).toBe(snapshot.turnState);
    expect(snapshot.cancel).toHaveBeenCalledTimes(1);
    expect(h.store.records.get('short')?.state).toBe('running');
    await h.runner.finish(call);
    expect(h.store.records.get('short')?.state).toBe('settled');
    expect(h.runner.committed).toEqual([call.turn]);
    expect(vi.mocked(h.owner.apply).mock.invocationCallOrder[0]).toBeGreaterThan(h.store.saveResult.mock.invocationCallOrder[0]!);
    expect(h.store.markSettled.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(h.owner.apply).mock.invocationCallOrder[0]!);
  });
});
