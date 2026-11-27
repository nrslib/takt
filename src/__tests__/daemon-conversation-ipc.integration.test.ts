import { createWatchSource } from './helpers/daemon-watch-source.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Client } from './helpers/conversation-ipc-client.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { conversationDaemon } from './helpers/conversation-daemon.js';
import { deferred, humanTurnText } from './helpers/daemon-turn.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../features/daemon/conversationFrames.js';
import * as conversationFrames from '../features/daemon/conversationFrames.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { writeLegacyConversation, conversationRecord, directorConversationRecord } from './helpers/conversation-fixtures.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import type { ConversationOpen, PortOutput } from '../features/manager/conversationPort.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { askTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import * as goalService from '../infra/goals/service.js';
import { ConversationTransferReceiver } from '../features/manager/conversationTransferReceiver.js';
import type { ConversationDelivery } from '../features/manager/conversationPort.js';
import { createDirectorTurnExecutor } from '../features/director/turnExecutor.js';
import { DIRECTOR_MCP_SERVER_NAME } from '../features/director/mcp.js';
import { jsonResult } from '../features/mcp/response.js';
import { makeProvider } from './test-helpers.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn() }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path }));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({ ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (path: string) => path }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: () => ({ ctx: { providerType: 'mock' } }) }));


const owner = { pid: process.pid, identity: { startTime: 'ipc-test-owner' }, version: 'test', cliPath: '/test/cli.js' };
let directory: string;
let repository: string;
let selected: ConversationOpen;
let fixture: Awaited<ReturnType<typeof conversationDaemon>>;
let service: Awaited<ReturnType<typeof conversationDaemon>>['input'];
let server: Awaited<ReturnType<typeof createConversationIpcServer>>;
let clients: Client[];
const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async (input) => ({ message: 'reply', summary: null,
  sessionId: 'session', assignment: input.assignment }));
let release: (() => void) | undefined;

function client() { const value = new Client(server.endpoint); clients.push(value); return value; }
async function authenticated() {
  const value = client();
  await value.request('hello', { capability: (await readDaemonIpcState(directory))!.capability });
  return value;
}
async function opened(value: Client) { return (await value.request('open', selected)).result!; }
function saveGoal(goal: Goal) {
  const path = join(repository, '.takt', 'goals', goal.id);
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'goal.json'), JSON.stringify(goal));
}

beforeEach(async () => {
  directory = getGlobalConfigDir();
  repository = join(directory, 'repository'); mkdirSync(repository, { recursive: true });
  const assignment: ManagerAssignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  doubles.assignment.mockReset().mockResolvedValue(assignment);
  execute.mockReset().mockImplementation(async (input: ManagerTurnInput) => ({ message: 'reply', summary: null, sessionId: 'session', assignment: input.assignment }));
  clients = []; release = undefined;
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  writeLegacyConversation(directory, record);
  fixture = await conversationDaemon(directory, { resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'context', executor: { execute } }), close: async () => {} });
  service = fixture.input;
  server = await createConversationIpcServer(directory, owner, service);
});
afterEach(async () => {
  release?.();
  for (const value of clients) value.socket.destroy();
  await fixture.close();
  await server.close();
  vi.restoreAllMocks();
});

it('finishes each output transfer before newer state on both attachments', async () => {
  const deliveries: ConversationDelivery[] = [];
  const originalOpen = service.open;
  const opening = vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    deliveries.push(args[1]);
    return originalOpen(...args);
  });
  const first = await authenticated(); const second = await authenticated();
  const openedFirst = await opened(first); const openedSecond = await opened(second);
  await first.items(openedFirst.read.transferId); await second.items(openedSecond.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let paused = 0;
  const originalWrite = Socket.prototype.write;
  const writing = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(chunk).toString('utf8'));
    } catch {
      return originalWrite.call(this, chunk, encoding, complete);
    }
    if (parsed === null || typeof parsed !== 'object') {
      return originalWrite.call(this, chunk, encoding, complete);
    }
    const frame = parsed as { type: string; output?: { kind: string; purpose?: string } };
    if (frame.type === 'event' && frame.output?.kind === 'transfer_start' && frame.output.purpose === 'output') {
      paused++;
      return originalWrite.call(this, chunk, encoding, (error) => { void gate.then(() => complete?.(error)); });
    }
    return originalWrite.call(this, chunk, encoding, complete);
  });
  const notice = { kind: 'notice' as const, id: 'shared-notice', message: 'Shared conversation notice' };
  const initial = first.frames.find(({ output }) => output?.transferId === openedFirst.read.transferId)!.output!;
  const version = { revision: initial.revision, stateSequence: initial.stateSequence, operationId: null };
  const sending = deliveries.map((delivery) => delivery.deliver(selected.conversationId, notice, version));
  try {
    await vi.waitFor(() => expect(paused).toBe(2));
    const state = first.latestState()!;
    const states = deliveries.map((delivery) => delivery.deliver(selected.conversationId,
      { kind: 'pending', state }, { ...version, stateSequence: version.stateSequence + 1 }));
    resume();
    await Promise.all([...sending, ...states]);
    const responses = await Promise.all([first.request('snapshot', { attachmentId: openedFirst.attachmentId }),
      second.request('snapshot', { attachmentId: openedSecond.attachmentId })]);
    await first.items(responses[0]!.result!.read.transferId);
    await second.items(responses[1]!.result!.read.transferId);
    for (const value of [first, second]) {
      const observer = { state: vi.fn(), item: vi.fn(), output: vi.fn(), read: vi.fn(), remove: vi.fn() };
      const receiver = new ConversationTransferReceiver(selected.conversationId, observer);
      expect(() => { for (const frame of value.frames) if (frame.type === 'event') receiver.receive(frame); }).not.toThrow();
      expect(observer.output.mock.calls.filter(([output]) => output.kind === 'notice').map(([output]) => output)).toEqual([notice]);
    }
  } finally { resume(); await Promise.all(sending); writing.mockRestore(); opening.mockRestore(); }
});

it.each([false, true])('keeps queued text ordered and suppresses it after interruption while the socket writer is blocked: %s', async (interrupted) => {
  const connection = await authenticated();
  const open = await opened(connection);
  await connection.items(open.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const write = conversationFrames.writeConversationFrame;
  let blocked = false;
  const writing = vi.spyOn(conversationFrames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const frame = value as { output?: { kind: string; purpose?: string } };
    if (!blocked && frame.output?.kind === 'transfer_start' && frame.output.purpose === 'output') {
      blocked = true; await gate;
    }
    await write(socket, value);
  });
  const operationId = '11111111-1111-4111-8111-111111111111';
  const version = { revision: connection.latestState()!.revision, stateSequence: 10, operationId };
  const controller = new AbortController();
  const sending = service.deliver(selected.conversationId, { kind: 'notice', id: 'blocked', message: 'notice' }, { ...version, operationId: null });
  const pending: Promise<void>[] = [sending];
  try {
    await vi.waitFor(() => expect(blocked).toBe(true));
    for (const [index, message] of ['first', 'second'].entries()) pending.push(service.deliver(selected.conversationId,
      { kind: 'turn_text', operationId, generation: 1, message }, { ...version, stateSequence: 11 + index }, controller.signal));
    pending.push(service.deliver(selected.conversationId, { kind: 'result', operationId,
      result: { kind: 'reply', message: 'final' } }, { ...version, stateSequence: 13 }));
    if (interrupted) controller.abort();
    resume(); await Promise.all(pending);
    const observer = { state: vi.fn(), item: vi.fn(), output: vi.fn(), read: vi.fn(), remove: vi.fn() };
    await vi.waitFor(() => {
      observer.output.mockClear();
      const receiver = new ConversationTransferReceiver(selected.conversationId, observer);
      for (const frame of connection.frames) if (frame.type === 'event') receiver.receive(frame);
      expect(observer.output).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'result' }), expect.anything());
    });
    expect(observer.output.mock.calls.flatMap(([output]) => output.kind === 'turn_text' ? [output.message] : []))
      .toEqual(interrupted ? [] : ['first', 'second']);
  } finally { resume(); await Promise.all(pending); writing.mockRestore(); }
});

it('reports an interrupted started text transfer and still delivers the terminal result', async () => {
  const connection = await authenticated();
  const open = await opened(connection);
  await connection.items(open.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const write = conversationFrames.writeConversationFrame;
  let startedTransferId: string | undefined;
  let blocked = false;
  const writing = vi.spyOn(conversationFrames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const frame = value as { output?: { kind: string; purpose?: string; transferId: string } };
    if (frame.output?.kind === 'transfer_start' && frame.output.purpose === 'output') startedTransferId = frame.output.transferId;
    if (!blocked && frame.output?.kind === 'transfer_data' && frame.output.transferId === startedTransferId) {
      blocked = true;
      await gate;
    }
    await write(socket, value);
  });
  const operationId = '11111111-1111-4111-8111-111111111111';
  const version = { revision: connection.latestState()!.revision, stateSequence: 10, operationId };
  const controller = new AbortController();
  const sendingText = service.deliver(selected.conversationId,
    { kind: 'turn_text', operationId, generation: 1, message: 'intermediate text' }, version, controller.signal);
  try {
    await vi.waitFor(() => expect(blocked).toBe(true));
    const transferId = startedTransferId!;
    await vi.waitFor(() => expect(connection.frames.some(({ output }) => output?.kind === 'transfer_start'
      && output.transferId === transferId)).toBe(true));
    const result = { kind: 'result' as const, operationId, result: { kind: 'reply' as const, message: 'final' } };
    const sendingResult = service.deliver(selected.conversationId, result, { ...version, stateSequence: 11 });
    controller.abort();
    resume();
    await sendingText;
    await sendingResult;
    await vi.waitFor(() => expect(connection.frames.some(({ output }) => output?.kind === 'transfer_error'
      && output.transferId === transferId)).toBe(true));
    const textFrames = connection.frames.filter(({ output }) => output?.transferId === transferId).map(({ output }) => output?.kind);
    expect(textFrames).toEqual(['transfer_start', 'transfer_data', 'transfer_error']);
    expect(connection.frames.some(({ output }) => output?.kind === 'transfer_end' && output.transferId === transferId)).toBe(false);
    const resultTransferId = connection.frames.filter(({ output }) => output?.kind === 'transfer_start'
      && output.purpose === 'output' && output.transferId !== transferId).at(-1)?.output?.transferId;
    expect(resultTransferId).toBeDefined();
    expect(await connection.items(resultTransferId!)).toEqual([result]);
  } finally { resume(); await Promise.allSettled([sendingText]); writing.mockRestore(); }
});

it('sends the initial state before activity that arrives while that state is still being read', async () => {
  execute.mockImplementationOnce(async (input) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const first = await authenticated(); const firstOpen = await opened(first);
  await first.items(firstOpen.read.transferId);
  await first.request('submit', { attachmentId: firstOpen.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'Start turn' } });
  await fixture.executing(1);
  await fixture.dispatcher.drain();
  const snapshot = await fixture.dispatcher.snapshot(selected.conversationId);
  snapshot.cancel();
  expect(snapshot.operationId).not.toBeNull(); expect(snapshot.generation).not.toBeNull();
  let resume!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementationOnce((request, delivery, enqueueSnapshot) =>
    open(request, delivery, (read, attachmentId) => {
      const source = read.items;
      enqueueSnapshot?.({ ...read, items: (async function* () {
        entered(); await gate; yield* source;
      })() }, attachmentId);
    }));
  const second = await authenticated();
  try {
    const secondOpen = await opened(second);
    await reading;
    const activity = { kind: 'activity' as const, operationId: snapshot.operationId!, generation: snapshot.generation!,
      activity: { kind: 'tool' as const, tool: 'InitialTool' } };
    const version = { revision: snapshot.revision, stateSequence: snapshot.stateSequence + 1, operationId: snapshot.operationId };
    const sending = service.deliver(selected.conversationId, activity, version);
    expect(second.latestState()).toBeUndefined();
    // 別のリクエストを往復させ、writer が動いても activity を先行送信しないことを確かめる。
    const forged = second.request('submit', { attachmentId: secondOpen.attachmentId, speaker: { namespace: 'agent', id: 'director' },
      command: { kind: 'message', text: 'Reject forged speaker' } });
    expect(second.frames.filter(({ output }) => output?.purpose === 'output')).toHaveLength(0);
    resume();
    await Promise.all([sending, forged]);
    await second.items(secondOpen.read.transferId);
    const order: string[] = [];
    const observer = { state: vi.fn(() => { order.push('state'); }), item: vi.fn(), remove: vi.fn(), read: vi.fn(),
      output: vi.fn((output: PortOutput) => { if (output.kind === 'activity') order.push('activity'); }) };
    await vi.waitFor(() => {
      order.length = 0; observer.output.mockClear();
      const receiver = new ConversationTransferReceiver(selected.conversationId, observer);
      for (const frame of second.frames) if (frame.type === 'event') receiver.receive(frame);
      expect(observer.output).toHaveBeenCalledWith(activity, expect.objectContaining(version));
    });
    expect(order[0]).toBe('state');
    expect(observer.state).toHaveBeenCalledWith(expect.objectContaining({ running: expect.objectContaining({
      operationId: activity.operationId, generation: activity.generation,
    }) }), expect.anything());
    expect(order.filter((kind) => kind === 'activity')).toEqual(['activity']);
    const endIndex = second.frames.findIndex(({ output }) => output?.kind === 'transfer_end' && output.transferId === secondOpen.read.transferId);
    const activityIndex = second.frames.findIndex(({ output }) => output?.purpose === 'output' && output.stateSequence === version.stateSequence);
    expect(activityIndex).toBeGreaterThan(endIndex);
    expect(second.socket.destroyed).toBe(false);
  } finally { resume(); release!(); await fixture.settled(); }
});

it('bounds admitted requests across input batches while responses are pending', async () => {
  const value = await authenticated(); const initial = await opened(value); await value.items(initial.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const snapshot = service.snapshot.bind(service);
  const reading = vi.spyOn(service, 'snapshot').mockImplementation(async (id, request) => { await gate; return snapshot(id, request); });
  const frames = Array.from({ length: 1000 }, (_, index) => encodeConversationFrame({ protocolVersion: 1, type: 'request',
    requestId: `bounded-${index}`, method: 'snapshot', params: { attachmentId: initial.attachmentId } }));
  try {
    value.socket.write(Buffer.concat(frames));
    await vi.waitFor(() => expect(reading.mock.calls.length).toBeGreaterThan(1));
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    const bound = Math.ceil(2 * 16 * 1024 / Math.min(...frames.map((frame) => frame.length))) + 1;
    expect(reading.mock.calls.length).toBeLessThanOrEqual(bound);
    resume();
    await vi.waitFor(() => expect(value.frames.filter((frame) => frame.requestId?.startsWith('bounded-'))).toHaveLength(frames.length), { timeout: 10000 });
    expect(value.socket.destroyed).toBe(false);
  } finally { resume(); reading.mockRestore(); }
});

it('admits a second large request but bounds further pending frames', async () => {
  const value = await authenticated(); const initial = await opened(value); await value.items(initial.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const submitting = vi.spyOn(service, 'submit').mockImplementation(async () => {
    await gate;
    return { kind: 'error', code: 'queue_full', message: 'Queue capacity reached' };
  });
  const frames = Array.from({ length: 3 }, (_, index) => encodeConversationFrame({ protocolVersion: 1, type: 'request',
    requestId: `large-pending-${index}`, method: 'submit', params: { attachmentId: initial.attachmentId,
      speaker: selected.speaker, command: { kind: 'message', text: 'x'.repeat(128 * 1024) } } }));
  try {
    value.socket.write(Buffer.concat(frames));
    await vi.waitFor(() => expect(submitting).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(submitting).toHaveBeenCalledTimes(2);
    resume();
    await vi.waitFor(() => expect(value.frames.filter((frame) => frame.requestId?.startsWith('large-pending-'))).toHaveLength(frames.length));
    expect(value.socket.destroyed).toBe(false);
  } finally { resume(); submitting.mockRestore(); }
});

it('continues the daemon-owned director session over IPC after detach without changing the manager record', async () => {
  const manager = { ...conversationRecord(repository), sessionId: 'manager-session', bindings: [selected.binding] };
  writeLegacyConversation(directory, manager);
  const managerPath = join(directory, 'conversations', `${selected.conversationId}.json`);
  const priorManager = readFileSync(managerPath);
  const director = directorConversationRecord();
  writeLegacyConversation(directory, director);
  selected = { conversationId: director.id, assignment: director.assignment, binding: director.bindings[0]!, speaker: director.counterpart };
  const first = await authenticated();
  const initial = await opened(first);
  expect((await first.items(initial.read.transferId))[0]).toMatchObject({
    kind: 'state', state: { conversationId: director.id, assignment: director.assignment },
  });
  expect(execute).not.toHaveBeenCalled();

  const accepted = (await first.request('submit', { attachmentId: initial.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'manager の状況を確認してください' } })).result!;
  expect(accepted.kind).toBe('accepted');
  await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);
  await vi.waitFor(async () => {
    const replies: unknown[] = [];
    for (const frame of first.frames) {
      const output = frame.output;
      if (output?.kind !== 'transfer_start' || output.purpose !== 'output' || output.operationId !== accepted.operationId) continue;
      if (!first.frames.some((frame) => frame.output?.kind === 'transfer_end' && frame.output.transferId === output.transferId)) continue;
      replies.push(...await first.items(output.transferId));
    }
    expect(replies).toContainEqual({ kind: 'result', operationId: accepted.operationId, result: { kind: 'reply', message: 'reply' } });
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].sessionId).toBeUndefined();
  expect((await new ConversationStateStore(directory).read(director.id))?.record).toMatchObject({
    agent: 'director', sessionId: 'session', running: null,
  });
  await first.request('detach', { attachmentId: initial.attachmentId });
  first.socket.destroy();

  const second = await authenticated();
  const reopened = await opened(second);
  expect((await second.items(reopened.read.transferId))[0]).toMatchObject({
    kind: 'state', state: { conversationId: director.id, assignment: director.assignment, running: null },
  });
  const next = (await second.request('submit', { attachmentId: reopened.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: '続けてください' } })).result!;
  expect(next.kind).toBe('accepted');
  await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);

  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]![0].sessionId).toBe('session');
  expect(readFileSync(managerPath)).toEqual(priorManager);
});

it('opens one director conversation independently of repository and workspace manager assignments', async () => {
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  const port = createTuiConversationPort(directory, delivery);
  const director = directorConversationRecord();
  writeLegacyConversation(directory, director);
  const repositoryManager = await port.resolve({ kind: 'repository', repositoryDirectory: repository });
  const first = { conversationId: director.id, assignment: director.assignment, binding: director.bindings[0]!, speaker: director.counterpart };
  const firstOpen = await service.open(first, delivery);
  const firstItems = firstOpen.read.items[Symbol.asyncIterator]();
  const firstState = (await firstItems.next()).value;
  await firstItems.return?.();
  firstOpen.read.cancel();
  const workspace = { kind: 'workspace' as const, workspaceId: '11111111-1111-4111-8111-111111111111',
    name: 'workspace', repositoryDirectories: [repository, join(directory, 'second-repository')] };
  doubles.assignment.mockResolvedValue(workspace);
  const workspaceManager = await port.resolve({ kind: 'workspace', workspaceId: workspace.workspaceId });
  writeLegacyConversation(directory, ConversationRecordSchema.parse({ ...conversationRecord(repository), agent: 'manager',
    id: workspaceManager.conversationId, assignment: workspaceManager.assignment, bindings: [workspaceManager.binding], pending: null }));
  const secondOpen = await service.open(first, delivery);
  const secondItems = secondOpen.read.items[Symbol.asyncIterator]();
  const secondState = (await secondItems.next()).value;
  await secondItems.return?.();
  secondOpen.read.cancel();

  expect(firstState).toMatchObject({ kind: 'state', state: { conversationId: director.id, assignment: director.assignment } });
  expect(secondState).toEqual(firstState);
  expect(secondOpen.read.conversationId).toBe(firstOpen.read.conversationId);
  expect(secondOpen.read.conversationId).not.toBe(repositoryManager.conversationId);
  expect(secondOpen.read.conversationId).not.toBe(workspaceManager.conversationId);
  expect((await fixture.store.read(secondOpen.read.conversationId))?.record.agent).toBe('director');
  expect(execute).not.toHaveBeenCalled();
});

it('keeps an accepted director turn alive after its last TUI disconnects', async () => {
  const director = directorConversationRecord();
  writeLegacyConversation(directory, director);
  selected = { conversationId: director.id, assignment: director.assignment, binding: director.bindings[0]!, speaker: director.counterpart };
  const value = await authenticated();
  const initial = await opened(value);
  await value.items(initial.read.transferId);
  execute.mockImplementationOnce(async (input) => {
    await new Promise<void>((resolve) => { release = resolve; });
    expect(input.abortSignal?.aborted).toBe(false);
    return { message: 'director finished', summary: null, sessionId: 'director-finished', assignment: input.assignment };
  });
  const accepted = (await value.request('submit', { attachmentId: initial.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: '確認を続けてください' } })).result!;
  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  value.socket.destroy();
  await vi.waitFor(() => expect(service.attachmentCount).toBe(0));
  expect(fixture.activeOperationCount).toBe(1);

  release!();
  await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);

  expect(execute).toHaveBeenCalledOnce();
  expect((await new ConversationStateStore(directory).read(director.id))?.record).toMatchObject({
    agent: 'director', sessionId: 'director-finished', running: null,
  });
});

it('requires capability authentication and confirms readiness against the exact current owner', async () => {
  const value = client();
  value.socket.write(encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId: 'unauthorized', method: 'open', params: selected }));
  await vi.waitFor(() => expect(value.socket.destroyed).toBe(true));
  expect(service.attachmentCount).toBe(0); expect(execute).not.toHaveBeenCalled();
  expect(await isConversationIpcReady(directory, owner)).toBe(true);
  expect(await isConversationIpcReady(directory, { ...owner, identity: { startTime: 'old-owner' } })).toBe(false);
  if (process.platform !== 'win32') expect(statSync(server.endpoint).mode & 0o777).toBe(0o600);
});

it('closes an unauthenticated submit without side effects and preserves the authenticated connection for the same command', async () => {
  const authorized = await authenticated();
  const first = await opened(authorized);
  await authorized.items(first.read.transferId);
  const path = join(directory, 'conversations', `${selected.conversationId}.json`);
  const saved = readFileSync(path);
  expect(service.attachmentCount).toBe(1);
  expect(fixture.activeOperationCount).toBe(0);
  const params = { attachmentId: first.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'authenticated message' } };
  const unauthorized = client();
  const closed = vi.fn();
  unauthorized.socket.once('close', closed);
  unauthorized.socket.write(encodeConversationFrame({ protocolVersion: 1, type: 'request',
    requestId: 'unauthenticated-submit', method: 'submit', params }));
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(unauthorized.frames).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  expect(fixture.activeOperationCount).toBe(0);
  expect(readFileSync(path)).toEqual(saved);
  expect(service.attachmentCount).toBe(1);
  expect(authorized.socket.destroyed).toBe(false);

  const accepted = (await authorized.request('submit', params)).result!;
  expect(accepted.kind).toBe('accepted');
  await fixture.settled();
  await vi.waitFor(async () => {
    const completed = authorized.frames.filter(({ output }) => output?.kind === 'transfer_start'
      && output.purpose === 'output' && output.operationId === accepted.operationId
      && authorized.frames.some((frame) => frame.output?.kind === 'transfer_end' && frame.output.transferId === output.transferId));
    const outputs: unknown[] = [];
    for (const frame of completed) outputs.push(...await authorized.items(frame.output!.transferId));
    expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId, result: { kind: 'reply', message: 'reply' } });
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(humanTurnText(execute.mock.calls[0]![0].prompt)).toBe(params.command.text);
  await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);
  expect(service.attachmentCount).toBe(1);
  expect(authorized.socket.destroyed).toBe(false);
  expect((await new ConversationStateStore(directory).read(selected.conversationId))?.record).toMatchObject({
    revision: 5, pending: null, running: null, sessionId: 'session', lastSpeaker: selected.speaker,
  });
});

it.each(['bad-capability', 'version', 'json', 'utf8', 'oversize'] as const)('closes %s input without conversation side effects', async (invalid) => {
  const value = client();
  const capability = (await readDaemonIpcState(directory))!.capability;
  const wrong = `${capability[0] === 'a' ? 'b' : 'a'}${capability.slice(1)}`;
  const bytes = invalid === 'json' ? Buffer.from('{broken}\n')
    : invalid === 'utf8' ? Buffer.from([0xc3, 0x28, 10])
      : invalid === 'oversize' ? Buffer.alloc(MAX_CONVERSATION_FRAME_BYTES + 1, 97)
        : encodeConversationFrame({ protocolVersion: invalid === 'version' ? 2 : 1, type: 'request', requestId: 'bad', method: 'hello', params: { capability: wrong } });
  value.socket.write(bytes);
  await vi.waitFor(() => expect(value.socket.destroyed).toBe(true));
  expect(service.attachmentCount).toBe(0); expect(execute).not.toHaveBeenCalled();
});

it.each([7, 9])('transfers the complete pending summary with %i large constraints under the physical frame bound', async (count) => {
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  record.pending!.summary.constraints = Array.from({ length: count }, (_, index) => `${index}:`.padEnd(128 * 1024, 'a'));
  writeLegacyConversation(directory, record);
  const value = await authenticated();
  const result = await opened(value);
  const items = await value.items(result.read.transferId);
  expect(items[0]).toMatchObject({ kind: 'state', state: { conversationId: selected.conversationId, pending: record.pending } });
  expect(value.sizes.every((bytes) => bytes <= MAX_CONVERSATION_FRAME_BYTES)).toBe(true);
  expect(value.frames.filter(({ output }) => output?.kind === 'transfer_data').length).toBeGreaterThan(3);
});

it.each([7, 9])('transfers all %i large goals in directory order without the array API', async (count) => {
  const goals = Array.from({ length: count }, (_, index) => ({ ...goalRecord(),
    id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, objective: `${index}:`.padEnd(128 * 1024, 'a') }));
  for (const goal of [...goals].reverse()) saveGoal(goal);
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('Array reads are forbidden'));
  try {
    const value = await authenticated(); const result = await opened(value);
    const items = (await value.items(result.read.transferId)) as Array<{ kind: string; goal: unknown }>;
    expect(items.filter(({ kind }) => kind === 'goal').map(({ goal }) => goal)).toEqual(goals.map((goal) => ({ id: goal.id,
      objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus, awaitingHumanMerge: false, repositoryDirectory: repository })));
    expect(list).not.toHaveBeenCalled();
    expect(value.sizes.every((bytes) => bytes <= MAX_CONVERSATION_FRAME_BYTES)).toBe(true);
  } finally { list.mockRestore(); }
});

it.each([7, 9])('transfers all %i large options created through the real goal-question operation', async (count) => {
  const goal = goalRecord(); saveGoal(goal);
  const options = Array.from({ length: count }, (_, index) => `${index}:`.padEnd(128 * 1024, 'a'));
  const producer = await askTaktGoalQuestion({ cwd: repository, goalId: goal.id, body: 'Choose', options }, {}, new AbortController().signal);
  expect(producer.isError).not.toBe(true);
  const saved = (await new GoalStore(repository).get(goal.id)).questions![0]!;
  const value = await authenticated(); const result = await opened(value);
  const items = (await value.items(result.read.transferId)) as Array<{ kind: string; inquiry: unknown }>;
  expect(items.filter(({ kind }) => kind === 'inquiry').map(({ inquiry }) => inquiry)).toEqual([
    { target: { goalId: goal.id, repositoryDirectory: repository }, question: saved, objective: goal.objective },
  ]);
  expect(saved.options).toEqual(options);
  expect(value.sizes.every((bytes) => bytes <= MAX_CONVERSATION_FRAME_BYTES)).toBe(true);
});

it('transfers the exact normal standalone approval and removes that inquiry on refresh after withdrawal', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const question = await new StandaloneInquiryStore(directory, owner).create({ body: 'Confirm this operation' });
  const value = await authenticated(); const first = await opened(value);
  const before = (await value.items(first.read.transferId)) as Array<{ kind: string; inquiry: unknown }>;
  expect(before.filter(({ kind }) => kind === 'inquiry').map(({ inquiry }) => inquiry)).toEqual([{ target: { goalId: null, owner }, question }]);
  expect(question.options).toBeUndefined();
  await new StandaloneInquiryStore(directory, owner).withdraw(question.id, 'No longer needed');
  const refreshed = (await value.request('snapshot', { attachmentId: first.attachmentId })).result!;
  const after = (await value.items(refreshed.read.transferId)) as Array<{ kind: string }>;
  expect(after.some(({ kind }) => kind === 'inquiry')).toBe(false);
});

it('queues a simultaneous message and completes both operations after both clients disconnect', async () => {
  let input: ManagerTurnInput | undefined;
  execute.mockImplementationOnce((value) => new Promise((resolve) => {
    input = value; release = () => resolve({ message: 'finished', summary: null, sessionId: 'saved-session', assignment: value.assignment });
  }));
  const first = await authenticated(); const second = await authenticated();
  const firstOpen = await opened(first); const secondOpen = await opened(second);
  await first.items(firstOpen.read.transferId); await second.items(secondOpen.read.transferId);
  const accepted = (await first.request('submit', { attachmentId: firstOpen.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'accepted' } })).result!;
  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => expect(input).toBeDefined());
  expect((await second.request('submit', { attachmentId: secondOpen.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'queued' } })).result).toMatchObject({ kind: 'accepted', queuedMessageCount: 1 });
  first.socket.destroy(); second.socket.destroy();
  await vi.waitFor(() => expect(service.attachmentCount).toBe(0));
  expect(input!.abortSignal.aborted).toBe(false); expect(fixture.activeOperationCount).toBe(1);
  release!(); await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);
  expect(execute.mock.calls.map(([input]) => humanTurnText(input.prompt))).toEqual(['accepted', 'queued']);
  const third = await authenticated(); const reopened = await opened(third);
  expect((await third.items(reopened.read.transferId))[0]).toMatchObject({ kind: 'state', state: { revision: 6, pending: null, running: null } });
  const saved = (await new ConversationStateStore(directory).read(selected.conversationId))?.record;
  expect(saved!.sessionId).toBe('session');
});

it.each([{ count: 2, delayed: false }, { count: 3, delayed: false }, { count: 2, delayed: true }, { count: 3, delayed: true }])('keeps all responses to $count simultaneous messages on the same connection (delayed writer: $delayed)', async ({ count, delayed }) => {
  execute.mockImplementationOnce((input) => new Promise((resolve) => {
    release = () => resolve({ message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment });
  }));
  const value = await authenticated(); const first = await opened(value); await value.items(first.read.transferId);
  const requestIds = Array.from({ length: count }, (_, index) => `burst-${index}`);
  let finishWrite!: () => void;
  const gate = new Promise<void>((resolve) => { finishWrite = resolve; });
  const writing = vi.fn();
  const written = vi.fn();
  const originalWrite = Socket.prototype.write;
  const writer = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const bytes = Buffer.from(chunk);
    const response = bytes.subarray(0, 64).toString('utf8').includes('"type":"response"')
      ? JSON.parse(bytes.toString('utf8')) as { type?: string; requestId?: string } : {};
    const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    if (response.type === 'response' && requestIds.includes(response.requestId ?? '')) {
      writing(response.requestId);
      expect(this.writableLength + bytes.length).toBeLessThanOrEqual(MAX_CONVERSATION_FRAME_BYTES);
      return originalWrite.call(this, chunk, encoding, (error) => {
        const finish = () => { written(response.requestId); complete?.(error); };
        if (delayed) void gate.then(finish); else finish();
      });
    }
    return originalWrite.call(this, chunk, encoding, complete);
  });
  const originalSubmit = service.submit;
  const submitted = vi.fn();
  const submit = vi.spyOn(service, 'submit').mockImplementation(async (input) => {
    const result = await originalSubmit(input);
    submitted(input.requestId, result);
    return result;
  });
  try {
    value.socket.write(Buffer.concat(requestIds.map((requestId) => encodeConversationFrame({ protocolVersion: 1, type: 'request',
      requestId, method: 'submit', params: { attachmentId: first.attachmentId, speaker: selected.speaker,
        command: { kind: 'message', text: requestId } } }))));
    await fixture.executing(1);
    expect(execute).toHaveBeenCalledOnce();
    if (delayed) {
      await vi.waitFor(() => expect(submitted).toHaveBeenCalledTimes(count));
      expect(writing).toHaveBeenCalledOnce();
      expect(written).not.toHaveBeenCalled();
      release!();
      await fixture.settled();
      expect(fixture.activeOperationCount).toBe(0);
      expect(execute).toHaveBeenCalledTimes(count);
      finishWrite();
    }
    await vi.waitFor(() => expect(value.frames.filter((frame) => requestIds.includes(frame.requestId ?? ''))).toHaveLength(count));
    const accepted = value.frames.find((frame) => frame.requestId === requestIds[0])!.result!;
    expect(accepted.kind).toBe('accepted');
    for (const [index, id] of requestIds.slice(1).entries()) expect(value.frames.find((frame) => frame.requestId === id)!.result).toMatchObject({ kind: 'accepted', queuedMessageCount: index + 1 });
    expect(value.socket.destroyed).toBe(false);
    expect(written).toHaveBeenCalledTimes(count);
    expect(humanTurnText(execute.mock.calls[0]![0].prompt)).toBe(requestIds[0]);
    release!(); await fixture.settled();
    expect(fixture.activeOperationCount).toBe(0);
    expect(execute.mock.calls.map(([input]) => humanTurnText(input.prompt))).toEqual(requestIds);
    expect(submitted.mock.calls.map(([id, result]) => ({ id, kind: result.kind })).sort((a, b) => requestIds.indexOf(a.id) - requestIds.indexOf(b.id)))
      .toEqual(requestIds.map((id) => ({ id, kind: 'accepted' })));
  } finally { finishWrite(); submit.mockRestore(); writer.mockRestore(); }
});

it('accepts a complete message spanning input batches and queues concurrent messages without truncation', async () => {
  const text = 'x'.repeat(128 * 1024);
  execute.mockImplementationOnce((input) => new Promise((resolve) => {
    release = () => resolve({ message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment });
  }));
  const value = await authenticated(); const first = await opened(value); await value.items(first.read.transferId);
  value.socket.write(Buffer.concat([text, 'second', 'third'].map((message, index) => encodeConversationFrame({
    protocolVersion: 1, type: 'request', requestId: `large-burst-${index}`, method: 'submit', params: {
      attachmentId: first.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: message },
    },
  }))));
  await vi.waitFor(() => expect(value.frames.filter((frame) => frame.requestId?.startsWith('large-burst-'))).toHaveLength(3), { timeout: 10000 });
  const accepted = value.frames.find((frame) => frame.requestId === 'large-burst-0')!.result!;
  expect(accepted.kind).toBe('accepted');
  for (const [index, id] of ['large-burst-1', 'large-burst-2'].entries()) expect(value.frames.find((frame) => frame.requestId === id)!.result).toMatchObject({ kind: 'accepted', queuedMessageCount: index + 1 });
  await fixture.executing(1);
    expect(execute).toHaveBeenCalledOnce();
  expect(humanTurnText(execute.mock.calls[0]![0].prompt)).toBe(text);
  release!(); await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);
  expect(execute.mock.calls.map(([input]) => humanTurnText(input.prompt))).toEqual([text, 'second', 'third']);
  expect(value.socket.destroyed).toBe(false);
});

it('uses a fresh transfer ID and an empty delta after an unchanged completed read', async () => {
  const value = await authenticated();
  const first = await opened(value);
  const second = (await value.request('snapshot', { attachmentId: first.attachmentId })).result!;
  expect(second.read.transferId).not.toBe(first.read.transferId);
  expect(await value.items(second.read.transferId)).toEqual([]);
  expect(value.latestState()).toMatchObject({ revision: 4 });
});

it('returns assignment-change rejection without waiting for a notice behind that request response', async () => {
  const value = await authenticated(); const first = await opened(value); await value.items(first.read.transferId);
  doubles.assignment.mockResolvedValue({ kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111', name: 'Workspace', repositoryDirectories: [repository] });
  expect((await value.request('submit', { attachmentId: first.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'old assignment' } })).result).toMatchObject({ kind: 'error', code: 'invalid_assignment' });
  expect(execute).not.toHaveBeenCalled(); expect(fixture.activeOperationCount).toBe(0);
});

it('reports a failed display read as incomplete and permits a complete refresh after repair', async () => {
  const goal = goalRecord(); saveGoal(goal);
  writeFileSync(join(repository, '.takt', 'goals', goal.id, 'goal.json'), '{broken');
  const value = await authenticated(); const first = await opened(value);
  await vi.waitFor(() => expect(value.frames.some(({ output }) => output?.kind === 'transfer_error' && output.transferId === first.read.transferId)).toBe(true));
  expect(value.frames.some(({ output }) => output?.kind === 'transfer_end' && output.transferId === first.read.transferId)).toBe(false);
  saveGoal(goal);
  const repaired = (await value.request('snapshot', { attachmentId: first.attachmentId })).result!;
  expect((await value.items(repaired.read.transferId))).toContainEqual({ kind: 'goal', goal: {
    id: goal.id, objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus, awaitingHumanMerge: false, repositoryDirectory: repository,
  } });
  expect(service.attachmentCount).toBe(1);
});

it('delivers an accepted response before its terminal result and keeps a responsive client attached', async () => {
  const value = await authenticated(); const first = await opened(value); await value.items(first.read.transferId);
  const accepted = await value.request('submit', { attachmentId: first.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'hello' } });
  await fixture.settled();
  expect(fixture.activeOperationCount).toBe(0);
  await vi.waitFor(() => expect(value.frames.filter(({ output }) => output?.purpose === 'output').length).toBeGreaterThanOrEqual(2));
  const start = value.frames.findIndex((frame) => frame === accepted);
  const transfers = value.frames.slice(start + 1).filter(({ output }) => output?.kind === 'transfer_start');
  const received: unknown[] = [];
  for (const transfer of transfers) received.push(...await value.items(transfer.output!.transferId));
  expect(received).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'reply' } } satisfies Partial<PortOutput>));
  expect(service.attachmentCount).toBe(1);
});

it('stops pulling display payloads under real socket backpressure and closes the read on disconnect', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pulled = 0; let closed = 0;
  const original = service.open.bind(service);
  const open = vi.spyOn(service, 'open').mockImplementationOnce((request, delivery, enqueueSnapshot) =>
    original(request, delivery, (read, attachmentId) => {
      const source = read.items;
      enqueueSnapshot?.({ ...read, items: (async function* () {
        const iterator = source[Symbol.asyncIterator]();
        try {
          yield (await iterator.next()).value!;
          await gate;
          for (let index = 0; index < 256; index++) {
            pulled++;
            yield { kind: 'goal' as const, goal: { ...goalRecord(), awaitingHumanMerge: false, objective: `${index}:`.padEnd(128 * 1024, 'a'), repositoryDirectory: repository } };
          }
        } finally { closed++; await iterator.return?.(); }
      })() }, attachmentId);
    }));
  try {
    const value = await authenticated(); await opened(value);
    value.socket.pause(); release();
    await vi.waitFor(() => expect(pulled).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pulled).toBeLessThan(256);
    value.socket.destroy();
    await vi.waitFor(() => expect(closed).toBe(1));
    expect(service.attachmentCount).toBe(0);
  } finally { release(); open.mockRestore(); }
});

it.each(['answered', 'withdrawn'] as const)('keeps the TUI attached when the watched inquiry becomes %s', async (status) => {
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const question = { id: '650e8400-e29b-41d4-a716-446655440001', body: 'Question', recipient: 'human' as const, kind: 'question' as const,
    status: 'pending' as const, createdAt: '2026-11-03T00:00:00Z' };
  const goal = { ...goalRecord(), questions: [question] }; saveGoal(goal);
  const value = await authenticated(); const attachment = await opened(value); await value.items(attachment.read.transferId);
  const source = createWatchSource(fixture.conversations, (notice) => fixture.dispatcher.inquiry(notice), (error) => { throw error; });
  await source.inquiries(); await fixture.conversations.close();
  saveGoal({ ...goal, questions: [{ ...question, status, ...(status === 'answered'
    ? { answer: { answeredBy: 'human' as const, text: 'answer', source: 'tui' as const, answeredAt: '2026-11-03T00:01:00Z' } }
    : { withdrawnAt: '2026-11-03T00:01:00Z' }) }] });
  await source.inquiries(); await fixture.conversations.close();
  const response = await value.request('snapshot', { attachmentId: attachment.attachmentId });
  const items = await value.items(response.result!.read.transferId);
  expect(items.filter((item) => typeof item === 'object' && item !== null && 'kind' in item && item.kind === 'inquiry')).toEqual([]);
  const observer = { state: vi.fn(), item: vi.fn(), output: vi.fn(), read: vi.fn(), remove: vi.fn() };
  const receiver = new ConversationTransferReceiver(selected.conversationId, observer);
  expect(() => { for (const frame of value.frames) if (frame.type === 'event') receiver.receive(frame); }).not.toThrow();
  expect(value.socket.destroyed).toBe(false);
});

it('keeps a PR mismatch inspection reply out of the goal work log', async () => {
  const goal = { ...goalRecord(), createdAt: '2026-11-01T00:00:00Z' }; saveGoal(goal);
  const eventId = 'pr-mismatch-inspection';
  expect(await fixture.dispatcher.accept({ eventId, requestId: eventId, conversationId: selected.conversationId, source: 'watcher',
    occurredAt: '2026-11-03T00:00:00Z', event: { kind: 'watch_observation', observation: { kind: 'pr_mismatch', targetId: goal.id,
      generation: 'old', observedAt: '2026-11-03T00:00:00Z', repositoryDirectory: repository, goalId: goal.id, url: 'https://github.com/test/project/pull/1', reason: 'head branch mismatch' } } })).toMatchObject({ kind: 'accepted' });
  await fixture.settled();
  expect(execute).toHaveBeenCalledOnce();
  expect((await new GoalStore(repository).get(goal.id)).workLog).toEqual([]);
});

function receivedOutputs(value: Client): Array<Exclude<PortOutput, { kind: 'snapshot' }>> {
  const pending = new Map<string, { purpose: string; parts: Buffer[] }>();
  const outputs: Array<Exclude<PortOutput, { kind: 'snapshot' }>> = [];
  for (const frame of value.frames) {
    const output = frame.output;
    if (output?.kind === 'transfer_start') pending.set(output.transferId, { purpose: output.purpose!, parts: [] });
    if (output === undefined) continue;
    const transfer = pending.get(output.transferId);
    if (transfer === undefined) continue;
    if (output.kind === 'transfer_data') {
      transfer.parts.push(Buffer.from(output.data, 'base64'));
      if (output.finalFragment) {
        if (transfer.purpose === 'output') outputs.push(JSON.parse(Buffer.concat(transfer.parts).toString('utf8')) as Exclude<PortOutput, { kind: 'snapshot' }>);
        transfer.parts = [];
      }
    }
    if (output.kind === 'transfer_end') pending.delete(output.transferId);
  }
  return outputs;
}

it('streams director tool activity to TUI and restores completed tool results after detach', async () => {
  const director = directorConversationRecord();
  writeLegacyConversation(directory, director);
  selected = { conversationId: director.id, assignment: director.assignment, binding: director.bindings[0]!, speaker: director.counterpart };
  const gate = deferred<void>();
  release = () => gate.resolve();
  const tool = `mcp__${DIRECTOR_MCP_SERVER_NAME}__takt_tell_manager`;
  const args = { managerId: `manager-${'a'.repeat(64)}`, text: 'Check the queue.', origin: 'director' };
  const failure = 'Manager is unavailable';
  const acceptedHandoff = JSON.stringify(jsonResult({ kind: 'accepted', operationId: '61111111-1111-4111-8111-111111111111',
    eventId: 'manager-message', acceptedSequence: 1, managerId: args.managerId }));
  const reply = 'The second handoff was accepted.';
  const provider = makeProvider({ setup: () => ({ async call(_prompt, { onStream }) {
    onStream?.({ type: 'thinking', data: { thinking: 'Thinking through the handoff' } });
    onStream?.({ type: 'tool_use', data: { id: 'first', tool, input: args } });
    await gate.promise;
    onStream?.({ type: 'tool_result', data: { content: failure, isError: true } });
    onStream?.({ type: 'tool_use', data: { id: 'second', tool, input: args } });
    onStream?.({ type: 'tool_result', data: { id: 'second', content: acceptedHandoff, isError: false } });
    onStream?.({ type: 'text', data: { text: reply } });
    return { persona: 'director', status: 'done', content: reply, timestamp: new Date() };
  } }) });
  const executor = createDirectorTurnExecutor({ cwd: directory, systemPrompt: 'director',
    ctx: { provider, providerType: 'mock', lang: 'en', model: undefined } }, { type: 'http', url: 'http://127.0.0.1/' });
  execute.mockImplementationOnce(executor.execute);

  const first = await authenticated();
  const initial = await opened(first);
  await first.items(initial.read.transferId);
  const accepted = (await first.request('submit', { attachmentId: initial.attachmentId, speaker: selected.speaker,
    command: { kind: 'message', text: 'Tell the manager.' } })).result!;
  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(() => {
    const outputs = receivedOutputs(first);
    expect(outputs.filter((value) => value.kind === 'activity').map((output) => output.activity))
      .toEqual([{ kind: 'thinking' }, { kind: 'tool', tool }]);
    expect(outputs).toContainEqual(expect.objectContaining({ kind: 'tool_started', entry: expect.objectContaining({
      status: 'running', tool, input: args, context: expect.objectContaining({ operationId: accepted.operationId }),
    }) }));
  });
  await first.request('detach', { attachmentId: initial.attachmentId });
  first.socket.destroy();

  const second = await authenticated();
  const reopened = await opened(second);
  expect(await second.items(reopened.read.transferId)).toContainEqual(expect.objectContaining({ kind: 'tool_history',
    history: expect.objectContaining({ operationId: accepted.operationId, finished: false,
      history: { entries: [expect.objectContaining({ toolId: 'first', status: 'running', tool })] } }),
  }));
  await vi.waitFor(() => expect(receivedOutputs(second)).toContainEqual(expect.objectContaining({ kind: 'activity',
    operationId: accepted.operationId, activity: { kind: 'tool', tool } })));

  gate.resolve();
  await fixture.settled();
  await vi.waitFor(() => {
    const outputs = receivedOutputs(second);
    expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId, result: { kind: 'reply', message: reply } });
    expect(outputs.filter((output) => output.kind === 'tool_completed').map(({ entry }) => [entry.toolId, entry.status, entry.result]))
      .toEqual([['first', 'failure', failure], ['second', 'success', acceptedHandoff]]);
    expect(outputs.filter((output) => output.kind === 'activity').map(({ activity }) => activity)).toContainEqual({ kind: 'responding' });
  });
  const third = await authenticated();
  const saved = await opened(third);
  expect(await third.items(saved.read.transferId)).toContainEqual(expect.objectContaining({ kind: 'tool_history',
    history: expect.objectContaining({ operationId: accepted.operationId, finished: true, history: { entries: [
      expect.objectContaining({ toolId: 'first', status: 'failure', result: failure }),
      expect.objectContaining({ toolId: 'second', status: 'success', result: acceptedHandoff }),
    ] } }),
  }));
});

it('delivers a queued message only after the previous tools and reply, including parallel tool completion order', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  release = resume;
  let calls = 0;
  execute.mockImplementation(async (input) => {
    if (++calls === 1) {
      enter(); await gate;
      await input.onActivity?.({ kind: 'thinking' });
      await input.onText?.('investigating');
      for (const id of ['a', 'b']) await input.onToolEvent?.({ type: 'tool_use', toolActivity: { callId: 'call' }, data: { id, tool: 'Bash', input: { command: id } } });
      await input.onToolEvent?.({ type: 'tool_output', toolActivity: { callId: 'call' }, data: { id: 'a', tool: 'Bash', output: 'a output\n' } });
      for (const id of ['b', 'a']) await input.onToolEvent?.({ type: 'tool_result', toolActivity: { callId: 'call' }, data: { id, content: `${id} done`, isError: false } });
    }
    return { message: `reply-${calls}`, summary: null, sessionId: 'session', assignment: input.assignment };
  });
  const value = await authenticated();
  const attachment = await opened(value); await value.items(attachment.read.transferId);
  await value.request('submit', { attachmentId: attachment.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'first' } });
  await entered;
  await value.request('submit', { attachmentId: attachment.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'second' } });
  expect(receivedOutputs(value).filter((event) => event.kind === 'user_message')).toMatchObject([{ message: 'first' }]);
  resume(); await fixture.settled();
  await vi.waitFor(() => expect(receivedOutputs(value).filter((event) => event.kind === 'result')).toHaveLength(2));
  const log = receivedOutputs(value).flatMap((event) => event.kind === 'user_message' ? [event.message]
    : event.kind === 'turn_text' ? [event.message]
    : event.kind === 'tool_completed' ? [event.entry.result!]
    : event.kind === 'result' && 'message' in event.result ? [event.result.message] : []);
  expect(log).toEqual(['first', 'investigating', 'b done', 'a done', 'reply-1', 'second', 'reply-2']);
});

it.each(['running', 'completed'] as const)('captures and enqueues a frozen %s snapshot atomically with subscription', async (phase) => {
  let input!: ManagerTurnInput;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; }); release = resume;
  execute.mockImplementation(async (value) => { input = value; enter(); await gate; return { message: 'done', summary: null, sessionId: 'session', assignment: value.assignment }; });
  const first = await authenticated(); const attachment = await opened(first); await first.items(attachment.read.transferId);
  await first.request('submit', { attachmentId: attachment.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'start' } });
  await entered;
  await input.onToolEvent?.({ type: 'tool_use', toolActivity: { callId: 'call' }, data: { id: 'tool', tool: 'Bash', input: {} } });
  await input.onToolEvent?.({ type: 'tool_output', toolActivity: { callId: 'call' }, data: { id: 'tool', tool: 'Bash', output: 'private in-flight output\n' } });
  if (phase === 'completed') await input.onToolEvent?.({ type: 'tool_result', toolActivity: { callId: 'call' }, data: { id: 'tool', content: 'whole result', isError: false } });
  const second = await authenticated(); const reopened = await opened(second);
  const items = await second.items(reopened.read.transferId);
  expect(JSON.stringify(items)).not.toContain('private in-flight output');
  if (phase === 'running') {
    expect(items.filter((item) => (item as { kind: string }).kind === 'tool_history')).toMatchObject([
      { kind: 'tool_history', history: { finished: false, history: { entries: [{ toolId: 'tool', tool: 'Bash', input: {}, output: '', status: 'running' }] } } },
    ]);
    await input.onToolEvent?.({ type: 'tool_result', toolActivity: { callId: 'call' }, data: { id: 'tool', content: 'whole result', isError: false } });
    await vi.waitFor(() => expect(receivedOutputs(second).filter((event) => event.kind === 'tool_completed')).toHaveLength(1));
  } else {
    expect(JSON.stringify(items)).toContain('whole result');
    expect(receivedOutputs(second).filter((event) => event.kind === 'tool_completed')).toEqual([]);
  }
  resume(); await fixture.settled();
});
