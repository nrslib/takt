import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { conversationTransferFrames, encodeConversationFrame } from '../features/daemon/conversationFrames.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';
import type { ConversationReadMetadata } from '../features/manager/conversationTransferReceiver.js';

const doubles = vi.hoisted(() => ({ connect: vi.fn(), ensure: vi.fn(), resolve: vi.fn(), owner: {
  pid: 1234, identity: { startTime: 'incarnation-one' }, version: 'test', cliPath: '/cli.js',
} }));
vi.mock('node:net', () => ({ createConnection: doubles.connect }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.ensure }));
vi.mock('../features/manager/tuiConversationPort.js', () => ({ createTuiConversationPort: () => ({ resolve: doubles.resolve }) }));
vi.mock('../infra/daemon/owner.js', () => ({ readDaemonOwner: () => doubles.owner, isDaemonOwnerRunning: () => true }));
vi.mock('../infra/daemon/ipcEndpoint.js', async (original) => ({
  ...await original<typeof import('../infra/daemon/ipcEndpoint.js')>(), resolveDaemonConfigDirectory: () => '/config',
  readDaemonIpcState: () => ({ protocolVersion: 1, endpoint: '/test.sock', capability: 'a'.repeat(64), owner: doubles.owner }),
  conversationIpcEndpoint: () => '/test.sock',
}));

type Request = { requestId: string; method: string; params: { command?: ConversationCommand; [key: string]: unknown } };
class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly requests: Request[] = [];
  constructor(private readonly handle: (request: Request, socket: FakeSocket) => void) { super(); }
  write(bytes: Buffer, callback?: (error?: Error) => void): boolean {
    const request = JSON.parse(bytes.toString()) as Request;
    this.requests.push(request);
    queueMicrotask(() => { if (!this.destroyed) { this.handle(request, this); callback?.(); } });
    return true;
  }
  response(request: Request, result: unknown): void {
    this.emit('data', encodeConversationFrame({ protocolVersion: 1, type: 'response', requestId: request.requestId, result }));
  }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
let clients: ConversationIpcClient[];
let sockets: FakeSocket[];
const record = conversationRecord('/repository');
const selected = { conversationId: record.id, assignment: record.assignment, binding: record.bindings[0]!, speaker: record.counterpart };
let submit: (request: Request, socket: FakeSocket) => void;
let helloOwner: () => typeof doubles.owner;
async function respond(request: Request, socket: FakeSocket) {
  if (request.method === 'hello') { socket.response(request, { owner: helloOwner() }); return; }
  if (request.method === 'submit') { submit(request, socket); return; }
  const read = { conversationId: record.id, transferId: randomUUID(), mode: 'initial' as const, revision: 4, stateSequence: 1, operationId: null };
  socket.response(request, { ...(request.method === 'open' ? { attachmentId: randomUUID() } : {}), read });
  const state = { conversationId: record.id, assignment: record.assignment, revision: 4, pending: record.pending,
    approval: null, running: null, interrupted: false };
  for await (const { frame } of conversationTransferFrames(record.id, read, 'snapshot', (async function* () { yield { kind: 'state', state }; })())) {
    socket.emit('data', encodeConversationFrame(frame));
  }
}
function client() { const value = new ConversationIpcClient(record.assignment, { provider: 'mock', model: 'chosen' }); clients.push(value); return value; }
beforeEach(() => {
  vi.clearAllMocks(); clients = []; sockets = [];
  doubles.owner.identity.startTime = 'incarnation-one';
  helloOwner = () => doubles.owner;
  doubles.ensure.mockResolvedValue(undefined);
  doubles.resolve.mockResolvedValue(selected);
  submit = (request, socket) => socket.response(request, { kind: 'accepted', operationId: randomUUID() });
  doubles.connect.mockImplementation(() => {
    const socket = new FakeSocket((request, socket) => { void respond(request, socket); });
    sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
  });
});
afterEach(() => { for (const value of clients) value.close(); vi.useRealTimers(); });

function controlReads(method: 'open' | 'snapshot') {
  const reads: Array<{ request: Request; socket: FakeSocket }> = [];
  doubles.connect.mockImplementation(() => {
    const socket = new FakeSocket((request, socket) => {
      if (request.method === method || request.method === 'snapshot') reads.push({ request, socket });
      else void respond(request, socket);
    });
    sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
  });
  return reads;
}

async function snapshotWire(revision: number, stateSequence: number) {
  const read = { conversationId: record.id, transferId: randomUUID(), mode: 'initial' as const, revision, stateSequence, operationId: null };
  const pending = { ...record.pending!, revision };
  const state = { conversationId: record.id, assignment: record.assignment, revision, pending,
    approval: null, running: null, interrupted: false };
  const item = { kind: 'display_event', event: { id: `revision-${revision}`, message: `Proposal ${revision}` } };
  const wire: Buffer[] = [];
  for await (const { frame } of conversationTransferFrames(record.id, read, 'snapshot', (async function* () {
    yield { kind: 'state', state }; yield item;
  })())) wire.push(encodeConversationFrame(frame));
  return { read, state, item, wire };
}

function readResponse(target: { request: Request; socket: FakeSocket }, read: ConversationReadMetadata) {
  target.socket.response(target.request, {
    ...(target.request.method === 'open' ? { attachmentId: randomUUID() } : {}), read,
  });
}

it.each(['complete', 'incomplete'] as const)('publishes display items together when a transfer is %s even when each item arrives in a separate chunk', async (status) => {
  const reads = controlReads('open');
  const value = client();
  const connecting = value.connect();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const { read, state } = await snapshotWire(4, 1);
  const items = Array.from({ length: 200 }, (_, index) => ({ kind: 'display_event' as const,
    event: { id: `event-${index}`, message: `Work ${index}` } }));
  const wire: Buffer[] = [];
  for await (const { frame } of conversationTransferFrames(record.id, read, 'snapshot', (async function* () {
    yield { kind: 'state', state }; yield* items;
  })())) wire.push(encodeConversationFrame(frame));
  const counts: number[] = [];
  value.subscribe(() => counts.push(value.getSnapshot().items.length));
  readResponse(reads[0]!, read);
  await connecting;
  for (const bytes of wire.slice(0, -1)) reads[0]!.socket.emit('data', bytes);

  expect(value.getSnapshot().state).toEqual(state);
  expect(new Set(counts)).toEqual(new Set([0]));
  reads[0]!.socket.emit('data', status === 'complete' ? wire.at(-1)! : encodeConversationFrame({
    protocolVersion: 1, type: 'event', conversationId: record.id,
    output: { kind: 'transfer_error', transferId: read.transferId, code: 'read_failed' },
  }));

  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: status, items });
  expect(new Set(counts)).toEqual(new Set([0, items.length]));
});

it('keeps the completed proposal usable while a background response and its transfer are pending', async () => {
  const reads = controlReads('open');
  const value = client(); const connecting = value.connect();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const initial = await snapshotWire(4, 1);
  readResponse(reads[0]!, initial.read);
  reads[0]!.socket.emit('data', Buffer.concat(initial.wire));
  await connecting;
  const previous = value.getSnapshot();
  const statuses: string[] = [];
  value.subscribe(() => { statuses.push(value.getSnapshot().readStatus); });
  const refreshing = value.refresh();
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  const waiting = value.getSnapshot();
  const { read, state, item, wire } = await snapshotWire(5, 2);
  readResponse(reads[1]!, read);
  const awaitingStart = value.getSnapshot();
  reads[1]!.socket.emit('data', Buffer.concat(wire.slice(0, -1)));
  const transferring = value.getSnapshot();
  reads[1]!.socket.emit('data', wire.at(-1)!);
  await refreshing;

  expect(waiting).toMatchObject({ readStatus: 'complete', state: previous.state, items: previous.items });
  expect(awaitingStart.readStatus).toBe('complete');
  expect(transferring).toMatchObject({ readStatus: 'complete', state });
  expect(statuses.every((status) => status === 'complete')).toBe(true);
  expect(value.getSnapshot()).toMatchObject({ readStatus: 'complete', state, items: [item] });
});

it.each(['open', 'snapshot'] as const)('allows a slow $0 transfer to finish without starting another snapshot', async (method) => {
  const reads = controlReads(method);
  const value = client();
  let operation: Promise<void>;
  if (method === 'open') operation = value.connect();
  else {
    await value.connect();
    await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
    operation = value.refresh();
  }
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const { read, wire } = await snapshotWire(4, 2);
  readResponse(reads[0]!, read);
  reads[0]!.socket.emit('data', wire[0]!);
  vi.useFakeTimers();
  const refreshes: Promise<void>[] = [];
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(500);
    refreshes.push(value.refresh());
  }
  await vi.advanceTimersByTimeAsync(0);
  const snapshotRequests = sockets[0]!.requests.filter(({ method }) => method === 'snapshot').length;
  reads[0]!.socket.emit('data', Buffer.concat(wire.slice(1)));
  // 旧実装が作った余分な要求も完結させ、失敗理由を要求数に限定する。
  for (const target of reads.slice(1)) {
    const extra = await snapshotWire(4, 3);
    readResponse(target, extra.read);
    target.socket.emit('data', Buffer.concat(extra.wire));
  }
  await operation;
  await Promise.all(refreshes);
  expect(snapshotRequests).toBe(method === 'open' ? 0 : 1);
  expect(value.getSnapshot().readStatus).toBe('complete');
});

it.each(['request', 'transfer'] as const)('invalidates a completed read after a background %s failure and recovers after retry', async (failure) => {
  const reads = controlReads('snapshot');
  const value = client(); await value.connect();
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  const refreshing = value.refresh();
  const settled = refreshing.catch(() => {});
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const { read, wire } = await snapshotWire(4, 2);
  if (failure === 'request') {
    reads[0]!.socket.emit('data', encodeConversationFrame({ protocolVersion: 1, type: 'response',
      requestId: reads[0]!.request.requestId, error: { kind: 'error', code: 'read_failed', message: 'Read failed' } }));
  } else {
    readResponse(reads[0]!, read);
    reads[0]!.socket.emit('data', wire[0]!);
    reads[0]!.socket.emit('data', encodeConversationFrame({ protocolVersion: 1, type: 'event', conversationId: record.id,
      output: { kind: 'transfer_error', transferId: read.transferId, code: 'read_failed' } }));
  }
  await settled;
  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'incomplete' });
  const retry = value.refresh();
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(value.getSnapshot().readStatus).toBe('reading');
  const repaired = await snapshotWire(5, 3);
  readResponse(reads[1]!, repaired.read);
  reads[1]!.socket.emit('data', Buffer.concat(repaired.wire));
  await retry;
  expect(value.getSnapshot()).toMatchObject({ readStatus: 'complete', state: repaired.state });
});

it('requires a fresh completed read after reconnecting the same client', async () => {
  const value = client(); await value.connect();
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  const reads = controlReads('open');
  sockets[0]!.destroy();
  expect(value.getSnapshot()).toMatchObject({ connection: 'disconnected', readStatus: 'incomplete' });
  await vi.waitFor(() => expect(reads).toHaveLength(1), { timeout: 2000 });
  const { read, wire } = await snapshotWire(4, 2);
  readResponse(reads[0]!, read);
  reads[0]!.socket.emit('data', Buffer.concat(wire.slice(0, -1)));
  await vi.waitFor(() => expect(value.getSnapshot().connection).toBe('connected'));
  expect(value.getSnapshot().readStatus).toBe('reading');
  reads[0]!.socket.emit('data', wire.at(-1)!);
  expect(value.getSnapshot().readStatus).toBe('complete');
});

it('connects to a fresh daemon after asynchronous assignment preparation', async () => {
  let ready = false;
  doubles.ensure.mockImplementationOnce(async () => { ready = true; });
  doubles.resolve.mockImplementationOnce(async () => {
    await Promise.resolve();
    // 接続前の非同期処理中に、attachmentのないdaemonが終了する条件。
    if (ready) ready = false;
    return selected;
  });
  const connect = doubles.connect.getMockImplementation()!;
  doubles.connect.mockImplementationOnce((...args) => {
    if (!ready) {
      const socket = new FakeSocket(() => {});
      sockets.push(socket);
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('connect ENOENT: daemon exited during assignment preparation'), { code: 'ENOENT' })));
      return socket;
    }
    return connect(...args);
  });
  const value = client();
  await value.connect();
  expect(value.getSnapshot().connection).toBe('connected');
  expect(sockets[0]!.requests.map(({ method }) => method)).toEqual(['hello', 'open']);
});

it('authenticates the current owner and opens the resolved identity with CLI overrides before applying a complete read', async () => {
  const value = client(); const listener = vi.fn(); const unsubscribe = value.subscribe(listener);
  await value.connect();
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', state: { conversationId: record.id, pending: record.pending } });
  expect(sockets[0]!.requests.map(({ method }) => method)).toEqual(['hello', 'open']);
  expect(sockets[0]!.requests[1]!.params).toEqual({ ...selected, agentOverrides: { provider: 'mock', model: 'chosen' } });
  expect(listener).toHaveBeenCalled(); unsubscribe();
  await value.refresh();
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  expect(sockets[0]!.requests.at(-1)?.method).toBe('snapshot');
});

it('correlates out-of-order submit responses without replaying or queuing mutations', async () => {
  const value = client(); await value.connect();
  const pending: Request[] = [];
  submit = (request) => { pending.push(request); };
  const first = value.submit({ kind: 'message', text: 'first' });
  const second = value.submit({ kind: 'message', text: 'second' });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  const operationId = randomUUID();
  sockets[0]!.response(pending[1]!, { kind: 'busy', operationId });
  sockets[0]!.response(pending[0]!, { kind: 'accepted', operationId });
  expect(await second).toEqual({ kind: 'busy', operationId });
  expect(await first).toEqual({ kind: 'accepted', operationId });
  expect(sockets[0]!.requests.filter(({ method }) => method === 'submit')).toHaveLength(2);
});

it.each([
  { method: 'open', responseAfter: 'start', frameCount: 1 },
  { method: 'open', responseAfter: 'an item', frameCount: 3 },
  { method: 'open', responseAfter: 'completion', frameCount: 5 },
  { method: 'snapshot', responseAfter: 'start', frameCount: 1 },
  { method: 'snapshot', responseAfter: 'an item', frameCount: 3 },
  { method: 'snapshot', responseAfter: 'completion', frameCount: 5 },
])('publishes complete $method items when the response arrives after $responseAfter', async ({ method, frameCount }) => {
  let pending: { request: Request; socket: FakeSocket } | undefined;
  doubles.connect.mockImplementation(() => {
    const socket = new FakeSocket((request, socket) => {
      if (request.method === method) pending = { request, socket };
      else void respond(request, socket);
    });
    sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
  });
  const value = client();
  let operation: Promise<void>;
  if (method === 'open') operation = value.connect();
  else {
    await value.connect();
    await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
    operation = value.refresh();
  }
  await vi.waitFor(() => expect(pending).toBeDefined());
  const { request, socket } = pending!;
  const read = { conversationId: record.id, transferId: randomUUID(), mode: 'initial' as const, revision: 4, stateSequence: 2, operationId: null };
  const state = { conversationId: record.id, assignment: record.assignment, revision: 4, pending: record.pending,
    approval: null, running: null, interrupted: false };
  const items = [
    { kind: 'assignment', assignment: { ...record.assignment, repositoryDirectories: ['/repository'] } },
    { kind: 'display_event', event: { id: 'after-response', message: 'Current conversation information' } },
  ];
  const wire: Buffer[] = [];
  for await (const { frame } of conversationTransferFrames(record.id, read, 'snapshot', (async function* () {
    yield { kind: 'state', state }; yield* items;
  })())) wire.push(encodeConversationFrame(frame));

  socket.emit('data', Buffer.concat(wire.slice(0, frameCount)));
  const response = encodeConversationFrame({ protocolVersion: 1, type: 'response', requestId: request.requestId,
    result: { ...(method === 'open' ? { attachmentId: randomUUID() } : {}), read } });
  socket.emit('data', Buffer.concat([response, ...wire.slice(frameCount)]));
  await operation;

  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete', state, error: null });
  expect(value.getSnapshot().items).toEqual(items);
});

it('identifies an accepted operation before its result arrives in the same chunk', async () => {
  const value = client(); await value.connect();
  let accepted: string | undefined;
  const results: string[] = [];
  value.onOutput((output) => {
    if (output.kind === 'result') {
      expect(output.operationId).toBe(accepted);
      results.push(output.operationId);
    }
  });
  submit = (request, socket) => {
    const operationId = randomUUID();
    void (async () => {
      const frames = [encodeConversationFrame({ protocolVersion: 1, type: 'response', requestId: request.requestId,
        result: { kind: 'accepted', operationId } })];
      const version = { transferId: randomUUID(), revision: 5, stateSequence: 3, operationId };
      for await (const { frame } of conversationTransferFrames(record.id, version, 'output', (async function* () {
        yield { kind: 'result', operationId, result: { kind: 'answer_saved', answerSaved: true, message: 'Saved' } };
      })())) frames.push(encodeConversationFrame(frame));
      socket.emit('data', Buffer.concat(frames));
    })();
  };
  const response = await value.submit({ kind: 'message', text: 'once' }, (id) => { accepted = id; });
  expect(response).toEqual({ kind: 'accepted', operationId: accepted });
  expect(results).toEqual([accepted]);
});

it('rejects a hello for a different owner before opening any conversation', async () => {
  helloOwner = () => ({ ...doubles.owner, identity: { startTime: 'wrong-owner' } });
  const value = client();
  await expect(value.connect()).rejects.toThrow();
  expect(sockets[0]!.requests.map(({ method }) => method)).toEqual(['hello']);
  expect(value.getSnapshot().state).toBeNull();
});

it('re-resolves and reauthenticates after disconnect while rejecting an ambiguous mutation without resending it', async () => {
  const value = client(); await value.connect();
  submit = () => {};
  const result = expect(value.submit({ kind: 'message', text: 'once only' })).rejects.toThrow();
  await vi.waitFor(() => expect(sockets[0]!.requests.at(-1)?.method).toBe('submit'));
  sockets[0]!.destroy(); await result;
  expect(value.getSnapshot().readStatus).toBe('incomplete');
  doubles.owner.identity.startTime = 'incarnation-two';
  await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2000 });
  await vi.waitFor(() => expect(value.getSnapshot().connection).toBe('connected'));
  expect(doubles.resolve).toHaveBeenCalledTimes(2);
  expect(sockets[1]!.requests.map(({ method }) => method)).toEqual(['hello', 'open']);
  expect(value.getSnapshot().state?.conversationId).toBe(record.id);
});

it('closes only the attachment and rejects pending requests without sending abort_turn', async () => {
  const value = client(); await value.connect(); submit = () => {};
  const result = expect(value.submit({ kind: 'message', text: 'accepted elsewhere' })).rejects.toThrow();
  value.close(); await result;
  expect(sockets[0]!.destroyed).toBe(true);
  expect(sockets[0]!.requests.some(({ params }) => params.command?.kind === 'abort_turn')).toBe(false);
  await expect(value.connect()).rejects.toThrow();
});

it('keeps an unanswered request pending until exactly five seconds despite unrelated output', async () => {
  const value = client(); await value.connect(); submit = () => {};
  vi.useFakeTimers();
  let settled = false;
  const pending = value.submit({ kind: 'message', text: 'unknown outcome' }).finally(() => { settled = true; });
  const result = expect(pending).rejects.toThrow('IPC request timed out');
  await vi.advanceTimersByTimeAsync(4000);
  const version = { transferId: randomUUID(), revision: 4, stateSequence: 1, operationId: null };
  for await (const { frame } of conversationTransferFrames(record.id, version, 'output', (async function* () {
    yield { kind: 'notice', id: 'unrelated-notice', message: 'Daemon is still running' };
  })())) sockets[0]!.emit('data', encodeConversationFrame(frame));
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).toBe(false);
  expect(value.getSnapshot().connection).toBe('connected');
  expect(sockets[0]!.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await result;
  expect(value.getSnapshot().connection).toBe('disconnected');
  expect(sockets[0]!.destroyed).toBe(true);
});

it('closes malformed submit responses and releases every pending request', async () => {
  const value = client(); await value.connect();
  submit = (request, socket) => socket.response(request, { kind: 'accepted', operationId: 'not-an-operation-id' });
  await expect(value.submit({ kind: 'message', text: 'invalid response' })).rejects.toThrow();
  expect(sockets[0]!.destroyed).toBe(true);
  expect(value.getSnapshot().connection).toBe('disconnected');
});

it('does not apply stale events from a socket after reconnecting to another socket', async () => {
  const value = client(); await value.connect();
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  const old = sockets[0]!; old.destroy();
  await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2000 });
  await vi.waitFor(() => expect(value.getSnapshot().readStatus).toBe('complete'));
  const current = value.getSnapshot();
  old.emit('data', Buffer.from('invalid old socket data\n'));
  expect(value.getSnapshot()).toEqual(current);
  expect(sockets[1]!.destroyed).toBe(false);
});
