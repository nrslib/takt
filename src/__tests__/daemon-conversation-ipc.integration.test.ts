import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Client } from './helpers/conversation-ipc-client.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { createConversationService } from '../features/manager/conversationService.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { encodeConversationFrame, MAX_CONVERSATION_FRAME_BYTES } from '../features/daemon/conversationFrames.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord, directorConversationRecord } from './helpers/conversation-fixtures.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import type { ConversationOpen, PortOutput } from '../features/manager/conversationPort.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { askTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import * as goalService from '../infra/goals/service.js';
import { ConversationTransferReceiver } from '../features/manager/conversationTransferReceiver.js';
import type { ConversationDelivery } from '../features/manager/conversationPort.js';

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
let service: ReturnType<typeof createConversationService>;
let server: Awaited<ReturnType<typeof createConversationIpcServer>>;
let clients: Client[];
const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: 'reply', summary: null,
  sessionId: 'session', assignment: input.assignment }));
let release: (() => void) | undefined;

function client() { const value = new Client(server.endpoint); clients.push(value); return value; }
async function authenticated() {
  const value = client();
  await value.request('hello', { capability: readDaemonIpcState(directory)!.capability });
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
  execute.mockClear();
  clients = []; release = undefined;
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  new ConversationStore(directory).write(record);
  service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(), runtime: {
    resolve: async () => ({ provider: 'mock', model: null, language: 'en', contextKey: 'context', executor: { execute } }), close: async () => {} } });
  server = await createConversationIpcServer(directory, owner, service);
});
afterEach(async () => {
  release?.();
  for (const value of clients) value.socket.destroy();
  await service.close();
  await server.close();
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
    let frame: { type: string; output?: { kind: string; purpose?: string } };
    try {
      frame = JSON.parse(Buffer.from(chunk).toString('utf8')) as typeof frame;
    } catch {
      return originalWrite.call(this, chunk, encoding, complete);
    }
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
    await Promise.all(deliveries.map((delivery) => delivery.deliver(selected.conversationId,
      { kind: 'pending', state }, { ...version, stateSequence: version.stateSequence + 1 })));
    resume();
    await Promise.all(sending);
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

it('bounds admitted requests across input batches while responses are pending', async () => {
  const value = await authenticated(); const initial = await opened(value); await value.items(initial.read.transferId);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const snapshot = service.snapshot.bind(service);
  const reading = vi.spyOn(service, 'snapshot').mockImplementation(async (id) => { await gate; return snapshot(id); });
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
    return { kind: 'busy', operationId: '650e8400-e29b-41d4-a716-446655440001' };
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
  new ConversationStore(directory).write(manager);
  const managerPath = join(directory, 'conversations', `${selected.conversationId}.json`);
  const priorManager = readFileSync(managerPath);
  const director = directorConversationRecord();
  new ConversationStore(directory).write(director);
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
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
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
  expect(new ConversationStore(directory).read(director.id, director.assignment)).toMatchObject({
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
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));

  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]![0].sessionId).toBe('session');
  expect(readFileSync(managerPath)).toEqual(priorManager);
});

it('opens one director conversation independently of repository and workspace manager assignments', async () => {
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  const port = createTuiConversationPort(directory, delivery);
  const director = directorConversationRecord();
  const store = new ConversationStore(directory);
  store.write(director);
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
  store.write(ConversationRecordSchema.parse({ ...conversationRecord(repository), agent: 'manager',
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
  expect(store.read(secondOpen.read.conversationId, director.assignment)?.agent).toBe('director');
  expect(execute).not.toHaveBeenCalled();
});

it('keeps an accepted director turn alive after its last TUI disconnects', async () => {
  const director = directorConversationRecord();
  new ConversationStore(directory).write(director);
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
  expect(service.activeOperationCount).toBe(1);

  release!();
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));

  expect(execute).toHaveBeenCalledOnce();
  expect(new ConversationStore(directory).read(director.id, director.assignment)).toMatchObject({
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
  expect(service.activeOperationCount).toBe(0);
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
  expect(service.activeOperationCount).toBe(0);
  expect(readFileSync(path)).toEqual(saved);
  expect(service.attachmentCount).toBe(1);
  expect(authorized.socket.destroyed).toBe(false);

  const accepted = (await authorized.request('submit', params)).result!;
  expect(accepted.kind).toBe('accepted');
  await vi.waitFor(async () => {
    const completed = authorized.frames.filter(({ output }) => output?.kind === 'transfer_start'
      && output.purpose === 'output' && output.operationId === accepted.operationId
      && authorized.frames.some((frame) => frame.output?.kind === 'transfer_end' && frame.output.transferId === output.transferId));
    const outputs: unknown[] = [];
    for (const frame of completed) outputs.push(...await authorized.items(frame.output!.transferId));
    expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId, result: { kind: 'reply', message: 'reply' } });
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].prompt).toBe(params.command.text);
  expect(service.activeOperationCount).toBe(0);
  expect(service.attachmentCount).toBe(1);
  expect(authorized.socket.destroyed).toBe(false);
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toMatchObject({
    revision: 5, pending: null, running: null, sessionId: 'session', lastSpeaker: selected.speaker,
  });
});

it.each(['bad-capability', 'version', 'json', 'utf8', 'oversize'] as const)('closes %s input without conversation side effects', async (invalid) => {
  const value = client();
  const capability = readDaemonIpcState(directory)!.capability;
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
  new ConversationStore(directory).write(record);
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
      objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus, repositoryDirectory: repository })));
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
  const question = await saveManagerToolPermissionInquiry({ configDirectory: directory, owner,
    request: { cwd: repository, toolName: 'Bash', toolInput: { command: 'git status' } }, reason: 'Confirm this operation' });
  const value = await authenticated(); const first = await opened(value);
  const before = (await value.items(first.read.transferId)) as Array<{ kind: string; inquiry: unknown }>;
  expect(before.filter(({ kind }) => kind === 'inquiry').map(({ inquiry }) => inquiry)).toEqual([{ target: { goalId: null, owner }, question }]);
  expect(question.options).toBeUndefined();
  await new StandaloneInquiryStore(directory, owner).withdraw(question.id, 'No longer needed');
  const refreshed = (await value.request('snapshot', { attachmentId: first.attachmentId })).result!;
  const after = (await value.items(refreshed.read.transferId)) as Array<{ kind: string }>;
  expect(after.some(({ kind }) => kind === 'inquiry')).toBe(false);
});

it('rejects a simultaneous message without queueing it and completes the accepted operation after both clients disconnect', async () => {
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
    command: { kind: 'message', text: 'rejected' } })).result).toEqual({ kind: 'busy', operationId: accepted.operationId });
  first.socket.destroy(); second.socket.destroy();
  await vi.waitFor(() => expect(service.attachmentCount).toBe(0));
  expect(input!.abortSignal.aborted).toBe(false); expect(service.activeOperationCount).toBe(1);
  release!(); await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(execute).toHaveBeenCalledOnce();
  const third = await authenticated(); const reopened = await opened(third);
  expect((await third.items(reopened.read.transferId))[0]).toMatchObject({ kind: 'state', state: { revision: 5, pending: null, running: null } });
  const saved = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  expect(saved.sessionId).toBe('saved-session');
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
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    if (delayed) {
      await vi.waitFor(() => expect(submitted).toHaveBeenCalledTimes(count));
      expect(writing).toHaveBeenCalledOnce();
      expect(written).not.toHaveBeenCalled();
      release!();
      await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
      expect(execute).toHaveBeenCalledOnce();
      finishWrite();
    }
    await vi.waitFor(() => expect(value.frames.filter((frame) => requestIds.includes(frame.requestId ?? ''))).toHaveLength(count));
    const accepted = value.frames.find((frame) => frame.requestId === requestIds[0])!.result!;
    expect(accepted.kind).toBe('accepted');
    for (const id of requestIds.slice(1)) expect(value.frames.find((frame) => frame.requestId === id)!.result).toEqual({ kind: 'busy', operationId: accepted.operationId });
    expect(value.socket.destroyed).toBe(false);
    expect(written).toHaveBeenCalledTimes(count);
    expect(execute.mock.calls[0]![0].prompt).toBe(requestIds[0]);
    release!(); await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
    expect(execute).toHaveBeenCalledOnce();
    expect(submitted.mock.calls.map(([id, result]) => ({ id, kind: result.kind }))).toEqual([
      ...requestIds.slice(1).map((id) => ({ id, kind: 'busy' })), { id: requestIds[0], kind: 'accepted' },
    ]);
  } finally { finishWrite(); submit.mockRestore(); writer.mockRestore(); }
});

it('accepts a complete message spanning input batches and rejects concurrent messages without truncation', async () => {
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
  await vi.waitFor(() => expect(value.frames.filter((frame) => frame.requestId?.startsWith('large-burst-'))).toHaveLength(3));
  const accepted = value.frames.find((frame) => frame.requestId === 'large-burst-0')!.result!;
  expect(accepted.kind).toBe('accepted');
  for (const id of ['large-burst-1', 'large-burst-2']) expect(value.frames.find((frame) => frame.requestId === id)!.result).toEqual({ kind: 'busy', operationId: accepted.operationId });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(execute.mock.calls[0]![0].prompt).toBe(text);
  release!(); await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(execute).toHaveBeenCalledOnce();
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
  expect(execute).not.toHaveBeenCalled(); expect(service.activeOperationCount).toBe(0);
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
    id: goal.id, objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus, repositoryDirectory: repository,
  } });
  expect(service.attachmentCount).toBe(1);
});

it('delivers an accepted response before its terminal result and keeps a responsive client attached', async () => {
  const value = await authenticated(); const first = await opened(value); await value.items(first.read.transferId);
  const accepted = await value.request('submit', { attachmentId: first.attachmentId, speaker: selected.speaker, command: { kind: 'message', text: 'hello' } });
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
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
  const original = service.open;
  const open = vi.spyOn(service, 'open').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    const source = result.read.items;
    result.read.items = (async function* () {
      const iterator = source[Symbol.asyncIterator]();
      try {
        yield (await iterator.next()).value!;
        await gate;
        for (let index = 0; index < 256; index++) {
          pulled++;
          yield { kind: 'goal' as const, goal: { ...goalRecord(), objective: `${index}:`.padEnd(128 * 1024, 'a'), repositoryDirectory: repository } };
        }
      } finally { closed++; await iterator.return?.(); }
    })();
    return result;
  });
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

it.each(['complete', 'replace'] as const)('delivers newer state while an older read is pending and does not roll it back when the old read must %s', async (mode) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sourceClosed = false;
  const original = service.open;
  const open = vi.spyOn(service, 'open').mockImplementationOnce(async (...args) => {
    const result = await original(...args); const source = result.read.items;
    result.read.items = (async function* () {
      try { for await (const item of source) { yield item; if (item.kind === 'state') await gate; } }
      finally { sourceClosed = true; }
    })(); return result;
  });
  try {
    const value = await authenticated(); const first = await opened(value);
    await vi.waitFor(() => expect(value.latestState()).toMatchObject({ revision: 4, pending: { revision: 4 } }));
    expect((await value.request('submit', { attachmentId: first.attachmentId, speaker: selected.speaker,
      command: { kind: 'message', text: 'revision five' } })).result!.kind).toBe('accepted');
    await vi.waitFor(() => expect(value.latestState()).toMatchObject({ revision: 5, pending: null, running: null }));
    expect(value.frames.some(({ output }) => output?.kind === 'transfer_end' && output.transferId === first.read.transferId)).toBe(false);
    let replacementId: string | undefined;
    if (mode === 'replace') {
      const replacement = (await value.request('snapshot', { attachmentId: first.attachmentId })).result!;
      replacementId = replacement.read.transferId;
      expect(replacementId).not.toBe(first.read.transferId);
      await value.items(replacementId);
    }
    release();
    if (mode === 'complete') await value.items(first.read.transferId);
    await vi.waitFor(() => expect(sourceClosed).toBe(true));
    if (replacementId !== undefined) {
      const index = value.frames.findIndex(({ output }) => output?.kind === 'transfer_start' && output.transferId === replacementId);
      expect(value.frames.slice(index + 1).some(({ output }) => output?.transferId === first.read.transferId)).toBe(false);
    }
    expect(value.latestState()).toMatchObject({ revision: 5, pending: null, running: null });
  } finally { release(); open.mockRestore(); }
});

it('keeps a newer running transition within revision four when an older idle snapshot finishes', async () => {
  let finishRead!: () => void; let finishGoal: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { finishRead = resolve; });
  const original = service.open;
  const open = vi.spyOn(service, 'open').mockImplementationOnce(async (...args) => {
    const result = await original(...args); const source = result.read.items;
    result.read.items = (async function* () {
      for await (const item of source) { yield item; if (item.kind === 'state') await gate; }
    })(); return result;
  });
  const register = vi.spyOn(goalService, 'registerReservedGoal').mockImplementationOnce((input) => new Promise((resolve) => {
    finishGoal = () => resolve({ ...goalRecord(), id: input.id, objective: input.objective,
      outOfScope: input.outOfScope, acceptanceCriteria: input.acceptanceCriteria, constraints: input.constraints });
  }));
  try {
    const value = await authenticated(); const first = await opened(value);
    await vi.waitFor(() => expect(value.latestState()).toMatchObject({ revision: 4, running: null }));
    const accepted = (await value.request('submit', { attachmentId: first.attachmentId, speaker: selected.speaker,
      command: { kind: 'approve_summary', revision: 4 } })).result!;
    expect(accepted.kind).toBe('accepted');
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(value.latestState()).toMatchObject({ revision: 4, running: { operationId: accepted.operationId } }));
    finishRead(); await value.items(first.read.transferId);
    expect(value.latestState()).toMatchObject({ revision: 4, running: { operationId: accepted.operationId } });
    finishGoal!();
    await vi.waitFor(() => expect(value.latestState()).toMatchObject({ revision: 5, running: null }));
  } finally { finishRead(); finishGoal?.(); register.mockRestore(); open.mockRestore(); }
});
