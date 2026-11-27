import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { attachConversationConnection } from '../features/daemon/conversationConnection.js';
import { ManagerImageAttachments } from './../features/manager/imageAttachments.js';
import { createDaemonConversationInput } from '../features/manager/daemonConversationPort.js';
import { DaemonDispatcher } from '../features/daemon/dispatcher.js';
import { deferred, MemoryEventStore } from './helpers/controlledDaemon.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { ConversationTransferReceiver } from '../features/manager/conversationTransferReceiver.js';
import { encodeConversationFrame } from '../features/daemon/conversationFrames.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import type { ConversationOpen, ConversationState, PortOutput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { TurnStart } from '../core/daemon/messages.js';
import type { ConversationProgress } from '../shared/types/conversation-activity.js';
import type { ToolActivityEntry } from '../shared/tool-activity/types.js';

const record = conversationRecord('/repository');
const selected: ConversationOpen = { conversationId: record.id, assignment: record.assignment, binding: record.bindings[0]!, speaker: record.counterpart };
vi.mock('../features/manager/tuiConversationPort.js', () => ({ createTuiConversationPort: (_directory: string, delivery: unknown) => ({
  resolve: async () => selected, delivery,
}) }));

class Connection extends Duplex {
  readonly frames: unknown[] = [];
  block = false;
  blockWhen: ((frame: unknown) => boolean) | undefined;
  release: (() => void) | undefined;
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const frame = JSON.parse(chunk.toString('utf8')) as unknown;
    this.frames.push(frame);
    if (this.block || this.blockWhen?.(frame) === true) { this.block = false; this.blockWhen = undefined; this.release = callback; }
    else callback();
  }
  request(method: string, params: unknown): string {
    const requestId = randomUUID();
    this.push(encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId, method, params }));
    return requestId;
  }
}
const connections: Connection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) { connection.release?.(); connection.destroy(); } vi.restoreAllMocks(); });
const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

async function fixture() {
  const store = new ConversationStateStore('/unused');
  const state = { version: 0, assignment: record.assignment, session: { provider: 'mock', model: null, sessionId: null }, revision: 0, pending: null, approval: null };
  vi.spyOn(store, 'read').mockImplementation(async () => ({ record, state }));
  vi.spyOn(store, 'apply').mockResolvedValue();
  const saved: ToolActivityEntry[] = [];
  vi.spyOn(store, 'appendCompletedTool').mockImplementation(async (_turn, entry) => { saved.push(structuredClone(entry)); });
  vi.spyOn(store, 'readToolHistories').mockImplementation(async () => saved.length === 0 ? [] : [{ operationId: turn.turn.operationId,
    generation: turn.turn.generation, finished: true, history: { entries: structuredClone(saved) } }]);
  const routing = new DaemonRouting('/unused');
  vi.spyOn(routing, 'display').mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repository', repositoryDirectories: [] });
  const notices = new DaemonNotifications('/unused');
  vi.spyOn(notices, 'iterate').mockImplementation(async function* () {});
  const events = new MemoryEventStore();
  const owner = new DaemonConversations(store, routing, notices, (id, output, version, signal) => service.deliver(id, output, version, signal), (error) => { throw error; }, events);
  const starts: TurnStart[] = [];
  const dispatcher = new DaemonDispatcher({ store: events, conversations: owner,
    runner: { async start(input) { await owner.started(input); starts.push(input); }, interrupt() {}, resultCommitted() {}, async close() {} },
    stateRequests: { handle: async () => ({ kind: 'error', code: 'forbidden', message: 'Unused state request' }) },
    resources: { close: async () => {} }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: ({error}) => { throw error; } });
  await dispatcher.restore(0, (async function* () {})());
  const service = createDaemonConversationInput({ configDirectory: '/unused', images: new ManagerImageAttachments({ hasImageReference: async () => false }), onImageCleanupError: (error: unknown) => { throw error; }, ingress: dispatcher, resolveAssignment: async (assignment) => assignment });
  const turn: TurnStart = { turn: { conversationId: record.id, operationId: randomUUID(), generation: 1 }, state,
    event: { eventId: 'first', requestId: 'first', conversationId: record.id, operationId: '', acceptedSequence: 1, lane: 'human',
      occurredAt: new Date().toISOString(), source: 'tui', event: { kind: 'human_command', speaker: record.counterpart, command: { kind: 'message', text: 'first' } } } };
  turn.event.operationId = turn.turn.operationId;
  const progress = (message: ConversationProgress) => owner.progress(turn.turn, message, new AbortController().signal);
  const tool = (type: 'tool_use' | 'tool_result', id: string) => progress({ kind: 'tool_event', eventId: randomUUID(),
    event: type === 'tool_use' ? { type, toolActivity: { callId: 'call', operationId: turn.turn.operationId, generation: 1 }, data: { id, tool: 'Bash', input: {} } }
      : { type, toolActivity: { callId: 'call', operationId: turn.turn.operationId, generation: 1 }, data: { id, content: `${id} done`, isError: false } } });
  const connect = async () => {
    const socket = new Connection(); connections.push(socket);
    attachConversationConnection(socket as unknown as Socket, service, '/unused', 'a'.repeat(64),
      { pid: 1, identity: { startTime: 'test' }, version: 'test', cliPath: '/cli' }, () => {});
    const hello = socket.request('hello', { capability: 'a'.repeat(64) });
    await vi.waitFor(() => expect(socket.frames.some((value) => (value as { requestId: string }).requestId === hello)).toBe(true));
    const opening = socket.request('open', selected);
    await vi.waitFor(() => expect(socket.frames.some((value) => (value as { requestId: string }).requestId === opening)).toBe(true));
    await tick();
    return socket;
  };
  const finish = () => owner.apply({ ...turn.turn, event: turn.event, outcome: { kind: 'completed', result: { kind: 'reply', message: 'reply' } } });
  return { owner, service, turn, progress, tool, connect, finish, routing, dispatcher, starts };
}

function readConnection(socket: Connection) {
  const delivered: string[] = [];
  const states: ConversationState[] = [];
  const items: unknown[] = [];
  const removed: string[] = [];
  const outputs: Array<Exclude<PortOutput, { kind: 'snapshot' }>> = [];
  const receiver = new ConversationTransferReceiver(record.id, { state: (state) => { states.push(state); delivered.push(state.running === null ? 'idle' : 'running'); },
    item: (item) => { items.push(item); }, remove(key) { removed.push(key); }, read: (status) => { if (status === 'complete') delivered.push('snapshot'); },
    output: (output) => { outputs.push(output); delivered.push(output.kind); } });
  for (const frame of socket.frames) if ((frame as { type: string }).type === 'event') receiver.receive(frame);
  return { delivered, states, items, removed, outputs };
}

it('keeps the waiting message count in a snapshot sent after an epic or inquiry change', async () => {
  const f = await fixture(); const socket = await f.connect();
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const submit = (text: string) => f.service.submit({ attachmentId: opened.result.attachmentId, requestId: randomUUID(),
    speaker: selected.speaker, command: { kind: 'message', text } });
  await submit('first'); await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  expect(await submit('waiting')).toMatchObject({ kind: 'accepted', queuedMessageCount: 1 });
  const snapshots = () => readConnection(socket).delivered.filter((value) => value === 'snapshot').length;
  const before = snapshots();

  await f.owner.refresh(record.id);

  await vi.waitFor(() => expect(snapshots()).toBe(before + 1));
  expect(readConnection(socket).states.at(-1)).toMatchObject({ queuedMessageCount: 1 });
});

it('captures the waiting message count with messages accepted while the snapshot is preparing', async () => {
  const f = await fixture(); const socket = await f.connect();
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const submit = (text: string) => f.service.submit({ attachmentId: opened.result.attachmentId, requestId: randomUUID(),
    speaker: selected.speaker, command: { kind: 'message', text } });
  await submit('first'); await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>();
  const display = f.routing.display.bind(f.routing);
  vi.mocked(f.routing.display).mockImplementationOnce(async (assignment) => { entered.resolve(); await release.promise; return display(assignment); });
  const reading = f.service.snapshot(opened.result.attachmentId);
  try {
    await entered.promise;
    expect(await submit('accepted during snapshot')).toMatchObject({ kind: 'accepted', queuedMessageCount: 1 });
    release.resolve();
    const snapshot = await reading;
    const items = []; for await (const item of snapshot.items) items.push(item);
    snapshot.complete();
    expect(items.flatMap((item) => item.kind === 'user_message' && item.pending ? [item.message] : []))
      .toEqual(['accepted during snapshot']);
    expect(items.find((item) => item.kind === 'state')).toMatchObject({ state: { queuedMessageCount: 1 } });
  } finally { release.resolve(); await reading; }
});

it('counts a message scheduled after an idle snapshot started as waiting in that snapshot', async () => {
  const f = await fixture(); const socket = await f.connect();
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const entered = deferred<void>(); const release = deferred<void>();
  const display = f.routing.display.bind(f.routing);
  vi.mocked(f.routing.display).mockImplementationOnce(async (assignment) => { entered.resolve(); await release.promise; return display(assignment); });
  const reading = f.service.snapshot(opened.result.attachmentId);
  try {
    await entered.promise;
    await f.service.submit({ attachmentId: opened.result.attachmentId, requestId: randomUUID(),
      speaker: selected.speaker, command: { kind: 'message', text: 'accepted while idle' } });
    release.resolve();
    const snapshot = await reading;
    const items = []; for await (const item of snapshot.items) items.push(item);
    snapshot.complete();
    expect(items.flatMap((item) => item.kind === 'user_message' && item.pending ? [item.message] : []))
      .toEqual(['accepted while idle']);
    expect(items.find((item) => item.kind === 'state')).toMatchObject({ state: { running: null, queuedMessageCount: 1 } });
  } finally { release.resolve(); await reading; await vi.waitFor(() => expect(f.starts).toHaveLength(1)); }
});

it('keeps state, text, parallel completions and replies FIFO when a write is blocked', async () => {
  const f = await fixture(); const socket = await f.connect();
  await f.owner.started(f.turn);
  await f.progress({ kind: 'turn_text', message: 'thinking' });
  await f.tool('tool_use', 'a'); await f.tool('tool_use', 'b');
  socket.block = true;
  const pending = f.tool('tool_result', 'b');
  await vi.waitFor(() => expect(socket.release).toBeDefined());
  const later = f.tool('tool_result', 'a');
  // A slow write must not retain the conversation serialization interval.
  await f.finish();
  socket.release!(); await Promise.all([pending, later]); await tick();
  const received = readConnection(socket);
  expect(received.delivered).toEqual(['idle', 'snapshot', 'user_message', 'running', 'turn_text', 'tool_started', 'tool_started',
    'tool_completed', 'tool_completed', 'idle', 'result']);
  expect(received.outputs.filter((output) => output.kind === 'tool_completed').map((output) => output.entry.toolId)).toEqual(['b', 'a']);
});

it('freezes the snapshot and registers the subscriber before a completion can enter the next interval', async () => {
  const f = await fixture(); await f.owner.started(f.turn); await f.tool('tool_use', 'a');
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const display = f.routing.display.bind(f.routing);
  vi.mocked(f.routing.display).mockImplementationOnce(async (assignment) => { entered(); await gate; return display(assignment); });
  const connecting = f.connect(); await reading;
  const completing = f.tool('tool_result', 'a');
  resume(); const socket = await connecting; await completing; await tick();
  const received = readConnection(socket);
  expect(received.items.filter((item) => (item as { kind: string }).kind === 'tool_history')).toMatchObject([
    { kind: 'tool_history', history: { operationId: f.turn.turn.operationId, generation: f.turn.turn.generation,
      history: { entries: [{ toolId: 'a', status: 'running', output: '' }] } } },
  ]);
  expect(received.outputs.filter((event) => event.kind === 'tool_completed')).toHaveLength(1);
  const completed = await f.connect();
  const replay = readConnection(completed);
  expect(replay.items).toMatchObject([{ kind: 'tool_history', history: { history: { entries: [{ toolId: 'a', status: 'success' }] } } }, { kind: 'assignment' }]);
  expect(replay.outputs).toEqual([]);
});

function snapshotStarts(socket: Connection, start: number): string[] {
  return socket.frames.slice(start).flatMap((frame) => {
    const output = (frame as { output?: { kind: string; purpose?: string; transferId: string } }).output;
    return output?.kind === 'transfer_start' && output.purpose === 'snapshot' ? [output.transferId] : [];
  });
}

function snapshotDeliveries(service: ReturnType<typeof createDaemonConversationInput>): Array<Promise<void>> {
  const deliveries: Array<Promise<void>> = [];
  const deliver = service.deliver.bind(service);
  vi.spyOn(service, 'deliver').mockImplementation((id, output, version, signal) => {
    const delivered = deliver(id, output, version, signal);
    if (output.kind === 'snapshot') deliveries.push(delivered);
    return delivered;
  });
  return deliveries;
}

it('drops a delivered snapshot read that has not started when a newer read is delivered on the same connection', async () => {
  const f = await fixture(); const socket = await f.connect(); await f.owner.started(f.turn);
  const deliveries = snapshotDeliveries(f.service);
  socket.block = true;
  const writing = f.progress('blocked');
  await vi.waitFor(() => expect(socket.release).toBeDefined());
  const start = socket.frames.length;
  await f.owner.refresh(record.id);
  await f.owner.refresh(record.id);
  await vi.waitFor(() => expect(deliveries).toHaveLength(2));
  await Promise.all(deliveries);

  socket.release!(); await writing;
  await vi.waitFor(() => expect(snapshotStarts(socket, start)).toHaveLength(1));
  await tick();

  expect(snapshotStarts(socket, start)).toHaveLength(1);
  expect(readConnection(socket).delivered.filter((value) => value === 'snapshot')).toHaveLength(2);
});

it('completes a requested read when a delivered read is queued before the requested read is sent', async () => {
  const f = await fixture(); const socket = await f.connect(); await f.owner.started(f.turn);
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const reads: Array<Promise<SnapshotRead>> = [];
  const snapshot = f.service.snapshot.bind(f.service);
  vi.spyOn(f.service, 'snapshot').mockImplementation((attachmentId, request) => {
    const read = snapshot(attachmentId, request);
    reads.push(read);
    return read;
  });
  const deliveries = snapshotDeliveries(f.service);
  socket.block = true;
  const writing = f.progress('blocked');
  await vi.waitFor(() => expect(socket.release).toBeDefined());
  const requested = socket.request('snapshot', { attachmentId: opened.result.attachmentId });
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  const read = await reads[0]!;
  await f.owner.refresh(record.id);
  await vi.waitFor(() => expect(deliveries).toHaveLength(1));
  await Promise.all(deliveries);

  socket.release!(); await writing;
  await vi.waitFor(() => expect(socket.frames.some((frame) => (frame as { requestId?: string }).requestId === requested)).toBe(true));
  await tick();

  const statuses: Array<{ status: string; transferId: string }> = [];
  const receiver = new ConversationTransferReceiver(record.id, { state() {}, item() {}, remove() {}, output() {},
    read: (status, transferId) => { statuses.push({ status, transferId }); } });
  for (const frame of socket.frames) {
    const value = frame as { type: string; result?: { read?: Parameters<ConversationTransferReceiver['expectRead']>[0] } };
    if (value.type === 'response' && value.result?.read !== undefined) receiver.expectRead(value.result.read);
    else if (value.type === 'event') receiver.receive(frame);
  }
  expect(statuses.filter((entry) => entry.transferId === read.transferId).map((entry) => entry.status)).toEqual(['reading', 'complete']);
  expect(statuses.at(-1)?.status).toBe('complete');
});

it('compares a read queued behind a read that is already being sent with that read', async () => {
  const f = await fixture(); const socket = await f.connect(); await f.owner.started(f.turn);
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const reads: Array<Promise<SnapshotRead>> = [];
  const snapshot = f.service.snapshot.bind(f.service);
  vi.spyOn(f.service, 'snapshot').mockImplementation((attachmentId, request) => {
    const read = snapshot(attachmentId, request);
    reads.push(read);
    return read;
  });
  await f.tool('tool_use', 'a');
  socket.blockWhen = (frame) => {
    const output = (frame as { output?: { kind: string; purpose?: string } }).output;
    return output?.kind === 'transfer_start' && output.purpose === 'snapshot';
  };
  const start = socket.frames.length;
  socket.request('snapshot', { attachmentId: opened.result.attachmentId });
  await vi.waitFor(() => expect(socket.release).toBeDefined());
  await f.finish();
  const second = socket.request('snapshot', { attachmentId: opened.result.attachmentId });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  const [sending, latest] = await Promise.all(reads);

  socket.release!();
  await vi.waitFor(() => expect(socket.frames.some((frame) => (frame as { requestId?: string }).requestId === second)).toBe(true));
  await tick();

  expect(snapshotStarts(socket, start)).toEqual([sending!.transferId, latest!.transferId]);
  const tools = JSON.stringify(['tool_history', f.turn.turn.operationId, f.turn.turn.generation]);
  expect(readConnection(socket).removed).toEqual([tools]);
});

it('disconnects a slow connection at capacity and reconnects with the completed entry once', async () => {
  const f = await fixture(); const socket = await f.connect(); await f.owner.started(f.turn); await f.tool('tool_use', 'a');
  socket.block = true;
  const writing = f.progress('blocked');
  await vi.waitFor(() => expect(socket.release).toBeDefined());
  const burst = Array.from({ length: 20 }, (_, index) => f.progress(`message-${index}`));
  await Promise.all([writing, ...burst]);
  expect(socket.destroyed).toBe(true);
  await f.tool('tool_result', 'a'); await f.finish();
  const reconnected = await f.connect(); const replay = readConnection(reconnected);
  expect(JSON.stringify(replay.items)).toContain('a done');
  expect(replay.outputs).toEqual([]);
});

it('keeps a connection that reads promptly while a request is being processed and delivers the response and outputs', async () => {
  const f = await fixture(); const socket = await f.connect(); await f.owner.started(f.turn);
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const entered = deferred<void>(); const release = deferred<void>();
  const accept = f.dispatcher.accept.bind(f.dispatcher);
  vi.spyOn(f.dispatcher, 'accept').mockImplementationOnce(async (event) => { entered.resolve(); await release.promise; return accept(event); });
  const submitted = socket.request('submit', { attachmentId: opened.result.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'held' } });
  await entered.promise;
  const messages = Array.from({ length: 20 }, (_, index) => `message-${index}`);
  // 読み取りが遅くない接続として、進捗ごとに書き込みが進む機会を与える。
  for (const message of messages) { await f.progress(message); await tick(); }
  expect(socket.destroyed).toBe(false);

  release.resolve();
  await vi.waitFor(() => expect(socket.frames.some((frame) => (frame as { requestId?: string }).requestId === submitted)).toBe(true));
  expect(socket.destroyed).toBe(false);
  expect(readConnection(socket).outputs.flatMap((output) => output.kind === 'progress' ? [output.message] : [])).toEqual(messages);
});

it('settles dispatcher progress at enqueue and disconnects a stalled connection without accumulating upstream deliveries', async () => {
  const f = await fixture(); const socket = await f.connect();
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  socket.request('submit', { attachmentId: opened.result.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'first' } });
  await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  const turn = f.starts[0]!.turn;
  socket.block = true;
  let completed = false;
  const progress = f.dispatcher.post({ kind: 'turn_progress', turn, message: 'blocked' }).then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(socket.release).toBeDefined());
    await vi.waitFor(() => expect(completed).toBe(true));
    for (let index = 0; index < 20; index++) await f.dispatcher.post({ kind: 'turn_progress', turn, message: `message-${index}` });
    expect(socket.destroyed).toBe(true);
    await f.dispatcher.post({ kind: 'turn_finished', turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
    expect(f.dispatcher.activeTurnCount).toBe(0);
  } finally {
    socket.release?.();
    await progress;
    await f.dispatcher.post({ kind: 'turn_finished', turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
    await f.dispatcher.control({ kind: 'stop' });
  }
});

it('keeps a message queued before the first tool start after the first reply through the dispatcher and connection', async () => {
  const f = await fixture(); const socket = await f.connect();
  const opened = socket.frames.find((frame) => (frame as { result?: { attachmentId?: string } }).result?.attachmentId !== undefined) as { result: { attachmentId: string } };
  const submit = (text: string) => socket.request('submit', { attachmentId: opened.result.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text } });
  submit('first'); await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  const second = submit('second');
  await vi.waitFor(() => expect(socket.frames.some((frame) => (frame as {requestId: string}).requestId === second)).toBe(true));
  expect(f.starts).toHaveLength(1);
  const first = f.starts[0]!;
  await f.dispatcher.post({ kind: 'turn_progress', turn: first.turn, message: { kind: 'tool_event', eventId: randomUUID(), event: {
    type: 'tool_use', toolActivity: { callId: 'call', operationId: first.turn.operationId, generation: first.turn.generation },
    data: { id: 'tool', tool: 'Bash', input: {} },
  } } });
  await f.dispatcher.post({ kind: 'turn_progress', turn: first.turn, message: { kind: 'tool_event', eventId: randomUUID(), event: {
    type: 'tool_result', toolActivity: { callId: 'call', operationId: first.turn.operationId, generation: first.turn.generation },
    data: { id: 'tool', content: 'tool done', isError: false },
  } } });
  await f.dispatcher.post({ kind: 'turn_finished', turn: first.turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'reply first' } } });
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  await f.dispatcher.post({ kind: 'turn_finished', turn: f.starts[1]!.turn, outcome: { kind: 'completed', result: { kind: 'reply', message: 'reply second' } } });
  await tick();
  const messages = readConnection(socket).outputs.flatMap((output) => output.kind === 'user_message' ? [output.message]
    : output.kind === 'tool_completed' ? [output.entry.result!]
    : output.kind === 'result' && 'message' in output.result ? [output.result.message] : []);
  expect(messages).toEqual(['first', 'tool done', 'reply first', 'second', 'reply second']);
});
