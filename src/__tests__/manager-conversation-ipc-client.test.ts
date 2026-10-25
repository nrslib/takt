import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { conversationTransferFrames, encodeConversationFrame } from '../features/daemon/conversationFrames.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';

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
  const read = { conversationId: record.id, transferId: randomUUID(), revision: 4, stateSequence: 1, operationId: null };
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

it('releases a request when its bounded timeout expires', async () => {
  const value = client(); await value.connect(); submit = () => {};
  vi.useFakeTimers();
  const result = expect(value.submit({ kind: 'message', text: 'unknown outcome' })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5000); await result;
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
  expect(value.getSnapshot()).toBe(current);
  expect(sockets[1]!.destroyed).toBe(false);
});
