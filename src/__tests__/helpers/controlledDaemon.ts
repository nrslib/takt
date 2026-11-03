import { vi } from 'vitest';
import type { AcceptedEvent, Admission, EventInput } from '../../core/daemon/events.js';
import type { ConversationTurnState, TurnStart, TurnIdentity, TurnOutcome, TurnResult } from '../../core/daemon/messages.js';
import type { ConversationOwner, DaemonBus, DaemonStateOwner, EventStore, StoredEvent, TurnRunner } from '../../core/daemon/ports.js';
import { createDaemonDispatcher } from '../../features/daemon/dispatcher.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function input(id: string, conversationId = 'conversation', lane: 'human' | 'other' = 'human'): EventInput {
  return {
    eventId: id, requestId: id, conversationId, source: 'tui', occurredAt: '2026-11-03T00:00:00Z',
    event: lane === 'human' ? { kind: 'human_command', command: { kind: 'message', text: id }, speaker: { namespace: 'test', id: 'person' } }
      : { kind: 'director_message', text: id, directorConversationId: 'director' },
  };
}

export class MemoryEventStore implements EventStore {
  readonly records = new Map<string, StoredEvent | { state: 'settled'; event: AcceptedEvent; result: TurnResult }>();
  readonly accept = vi.fn(async (event: AcceptedEvent): ReturnType<EventStore['accept']> => {
    await this.beforeAccept(event);
    const existing = [...this.records.values()].find((record) => record.event.eventId === event.eventId
      || record.event.conversationId === event.conversationId && record.event.requestId === event.requestId);
    if (existing !== undefined) {
      const saved = existing.event;
      return { kind: 'duplicate', event: saved, state: existing.state };
    }
    this.records.set(event.eventId, { state: 'queued', event });
    await this.afterAccept(event);
    return { kind: 'stored' };
  });
  readonly markStarted = vi.fn(async (eventId: string, turn: TurnIdentity) => {
    await this.beforeStart(eventId);
    this.records.set(eventId, { state: 'running', event: this.records.get(eventId)!.event, turn });
  });
  readonly saveResult = vi.fn(async (eventId: string, result: TurnResult) => {
    await this.beforeResult(eventId);
    this.records.set(eventId, { state: 'settling', event: result.event, result });
  });
  readonly markSettled = vi.fn(async (eventId: string, result: TurnResult) => {
    await this.beforeSettle(eventId);
    this.records.set(eventId, { state: 'settled', event: result.event, result });
  });
  beforeAccept: (event: AcceptedEvent) => Promise<void> = async () => {};
  afterAccept: (event: AcceptedEvent) => Promise<void> = async () => {};
  beforeStart: (eventId: string) => Promise<void> = async () => {};
  beforeResult: (eventId: string) => Promise<void> = async () => {};
  beforeSettle: (eventId: string) => Promise<void> = async () => {};
  async restore() {
    const records = [...this.records.values()];
    return {
      lastAcceptedSequence: Math.max(0, ...records.map(({ event }) => event.acceptedSequence)),
      pending: (async function* () { for (const record of records) if (record.state !== 'settled') yield record; })(),
    };
  }
}

interface ControlledCall {
  input: TurnStart;
  turn: TurnIdentity;
  signal: AbortSignal;
  finished: boolean;
}

/** provider を実行せず、開始・進捗・結果・終了確認をテストの操作で進める。 */
export class ControlledTurnRunner implements TurnRunner {
  bus!: DaemonBus;
  readonly calls: ControlledCall[] = [];
  readonly committed: TurnIdentity[] = [];
  readonly interrupts: TurnIdentity[] = [];
  private readonly waiting = new Map<number, ReturnType<typeof deferred<ControlledCall>>>();
  beforeClose: () => Promise<void> = async () => {};
  closed = false;
  start(input: TurnStart, signal: AbortSignal) {
    const call = { input, turn: input.turn, signal, finished: false };
    this.calls.push(call);
    this.waiting.get(this.calls.length)?.resolve(call);
  }
  started(count: number): Promise<ControlledCall> {
    const call = this.calls[count - 1];
    if (call !== undefined) return Promise.resolve(call);
    let wait = this.waiting.get(count);
    if (wait === undefined) { wait = deferred<ControlledCall>(); this.waiting.set(count, wait); }
    return wait.promise;
  }
  resultCommitted(turn: TurnIdentity) { this.committed.push(turn); }
  interrupt(turn: TurnIdentity) { this.interrupts.push(turn); }
  progress(call: ControlledCall, message: string) { return this.bus.post({ kind: 'turn_progress', turn: call.turn, message }); }
  finish(call: ControlledCall, outcome: TurnOutcome = { kind: 'completed', result: { kind: 'reply', message: call.input.event.eventId } }) {
    call.finished = true;
    return this.bus.post({ kind: 'turn_finished', turn: call.turn, outcome });
  }
  async close() {
    await this.beforeClose();
    await Promise.all(this.calls.filter((call) => !call.finished).map((call) => this.finish(call, { kind: 'interrupted' })));
    this.closed = true;
  }
}

export async function harness() {
  const store = new MemoryEventStore();
  const runner = new ControlledTurnRunner();
  const applied = new Map<string, TurnResult>();
  const owner: ConversationOwner = { inquiry: async () => {},
    apply: vi.fn(async (result) => { applied.set(result.operationId, result); }),
    progress: vi.fn(async () => {}),
    snapshot: vi.fn(async (conversationId) => ({
      conversationId, revision: 0, stateSequence: 0,
      transferId: 'snapshot', mode: 'initial' as const, turnState: turnState(),
      items: (async function* () {})(), complete() {}, cancel() {},
    })),
  };
  const stateRequests = { handle: vi.fn<DaemonStateOwner['handle']>(async (_turn, request) => {
    switch (request.kind) {
      case 'save_conversation': return { kind: 'state_saved', version: request.change.expectedVersion + 1, duplicate: false };
      case 'get_delivery': return { kind: 'delivery', conversationId: request.conversationId, assignment: turnState().assignment, connectedPorts: ['tui'] };
      case 'notify_director': return { kind: 'notification_saved', notificationId: request.notificationId };
      case 'accept_director_message': return { kind: 'event_accepted', admission: { kind: 'accepted', eventId: request.eventId, operationId: 'message-operation', acceptedSequence: 1 } };
    }
  }) };
  const resources = { close: vi.fn(async () => {}) };
  const failures = vi.fn();
  const dispatcher = await createDaemonDispatcher({
    store, runner, conversations: owner, stateRequests, resources,
    limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: failures,
  });
  runner.bus = dispatcher;
  return { dispatcher, store, runner, owner, applied, stateRequests, resources, failures };
}

export function accepted(value: Admission): asserts value is Extract<Admission, { kind: 'accepted' }> {
  if (value.kind !== 'accepted') throw new Error(`Rejected: ${value.reason}`);
}

export function turnState(): ConversationTurnState {
  return { version: 0, assignment: { kind: 'repository', repositoryDirectory: '/project' },
    session: { provider: 'mock', model: null, sessionId: null }, revision: 0, pending: null, approval: null };
}
