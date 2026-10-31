import { randomUUID } from 'node:crypto';
import * as privateFiles from '../shared/utils/private-file.js';
import * as managerConfig from '../infra/config/managerConfig.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { createConversationService } from '../features/manager/conversationService.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { ConversationSpeakerStore } from '../infra/conversations/speakerStore.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import type { ConversationRecord } from '../infra/conversations/schema.js';
import type { ConversationDelivery, PortOutput, SnapshotRead, SnapshotItem } from '../features/manager/conversationPort.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { conversationId } from '../infra/conversations/identity.js';
import { GoalStore } from '../infra/goals/store.js';
import { EventEmitter } from 'node:events';
import { CodexProvider } from '../infra/providers/codex.js';
import { ClaudeTerminalProvider } from '../infra/providers/claude-terminal.js';
import type { TaskState } from '../infra/task/types.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { mergeTaktGoalPr } from '../features/mcp/goalIntegrationOperations.js';
import * as goalPrMerge from '../features/manager/mergeGoalPr.js';
import { DirectorMessageResultStore } from '../infra/conversations/directorMessageResults.js';
import { DirectorNotificationStore, type DirectorNotification, type DirectorNotificationSubject } from '../infra/conversations/directorNotifications.js';
import { ManagerTurnScheduler } from '../features/manager/managerTurnScheduler.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), register: vi.fn(), notification: vi.fn(), codexRun: vi.fn(), tmux: vi.fn(), transcript: vi.fn(), pasteInput: vi.fn(), taskItems: vi.fn<() => TaskState[]>() }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.notification }));
vi.mock('../infra/managed-providers/loader.js', () => ({ loadManagedSdk: async () => ({
  directory: process.cwd(), modules: [await import('@openai/codex-sdk')], stale: false,
}) }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  startThread() { return { runStreamed: (input: unknown, options: unknown) => doubles.codexRun(undefined, input, options) }; }
  resumeThread(id: string) { return { id, runStreamed: (input: unknown, options: unknown) => doubles.codexRun(id, input, options) }; }
} }));
// The permission trust query is a separate CLI boundary; keep the real hook lifetime.
vi.mock('../infra/codex/hook-trust.js', () => ({ resolveCodexHookTrust: async () => ({ key: 'fixture', trustedHash: 'sha256:fixture' }) }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => doubles.tmux(...args),
  spawn: (command: string, args: string[]) => {
    if (command !== 'tmux' || args[0] !== 'load-buffer') throw new Error('Unexpected child process');
    const child = new EventEmitter();
    return Object.assign(child, { stdin: Object.assign(new EventEmitter(), { end: (text: string) => { doubles.pasteInput(text); queueMicrotask(() => child.emit('close', 0)); } }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }), kill: vi.fn() });
  },
}));
vi.mock('../infra/claude-terminal/transcript-reader.js', () => ({ ProjectClaudeTranscriptReader: class {
  async readBaseline() { return { byteOffset: 0, lineNumberOffset: 0 }; }
  async findSession({ sessionId }: { sessionId: string }) { return { sessionId }; }
  async waitForAssistantResponse(options: unknown) { return doubles.transcript(options); }
} }));
vi.mock('../features/manager/assignment.js', async (original) => ({
  ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path,
}));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(), resolveGitRepositoryDirectory: async (path: string) => path,
}));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.taskItems; } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: () => ({ ctx: { providerType: 'mock', model: 'model-A' } }) }));
vi.mock('../infra/goals/service.js', async (original) => ({
  ...await original<typeof import('../infra/goals/service.js')>(), registerReservedGoal: doubles.register,
}));

const owner = { pid: 1234, identity: { startTime: 'daemon-B' }, version: 'test', cliPath: '/test/cli.js' };
const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>();
const closeRuntime = vi.fn(async () => {});
const resolveRuntime = vi.fn();
let directory: string;
let repository: string;
let assignment: ManagerAssignment;
let store: ConversationStore;
let record: ConversationRecord & { assignment: Exclude<ConversationRecord['assignment'], { kind: 'daemon' }> };
let service: ReturnType<typeof createConversationService>;
let scheduler: ManagerTurnScheduler;
let outputs: PortOutput[];
let delivery: ConversationDelivery;
let lastOperationId: string | undefined;

function open() {
  return service.open({ conversationId: record.id, assignment: record.assignment,
    binding: record.bindings[0]!, speaker: record.counterpart }, delivery);
}
async function state(read: SnapshotRead) {
  const iterator = read.items[Symbol.asyncIterator]();
  try {
    const item = (await iterator.next()).value;
    if (item?.kind !== 'state') throw new Error('State must be first');
    return item.state;
  } finally { await iterator.return?.(); }
}
async function submit(attachmentId: string, command: Parameters<typeof service.submit>[0]['command']) {
  const result = await service.submit({ attachmentId, requestId: 'request', speaker: record.counterpart, command });
  if (result.kind === 'accepted') lastOperationId = result.operationId;
  return result;
}
async function finished() {
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  if (service.attachmentCount > 0 && lastOperationId !== undefined) {
    await vi.waitFor(() => expect(outputs.some((output) => output.kind === 'result' && output.operationId === lastOperationId)).toBe(true));
  }
}
function saveGoal(id: string) {
  const goal = { ...goalRecord(), ...record.pending!.summary, id };
  const path = join(repository, '.takt', 'goals', id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'goal.json'), JSON.stringify(goal));
  return goal;
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.notification.mockReset().mockResolvedValue(undefined);
  doubles.taskItems.mockReset().mockReturnValue([]);
  directory = getGlobalConfigDir();
  repository = join(directory, 'repository');
  mkdirSync(repository, { recursive: true });
  record = { ...conversationRecord(repository), model: 'model-A' };
  assignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  doubles.assignment.mockReset().mockResolvedValue(assignment);
  store = new ConversationStore(directory);
  store.write(record);
  execute.mockReset().mockResolvedValue({ message: 'manager reply', summary: null, sessionId: 'next-session', assignment: record.assignment });
  doubles.register.mockReset().mockImplementation(async ({ id }: { id: string }) => saveGoal(id));
  resolveRuntime.mockReset().mockResolvedValue({ provider: 'mock', model: 'model-A', language: 'en', contextKey: 'context-A', executor: { execute } });
  const runtime = { resolve: resolveRuntime, close: closeRuntime };
  scheduler = new ManagerTurnScheduler();
  service = createConversationService({ configDirectory: directory, owner, runtime, scheduler, onDomainChange: vi.fn() });
  outputs = [];
  lastOperationId = undefined;
  delivery = { deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; } };
});
afterEach(async () => { vi.restoreAllMocks(); await service.close(); });

it('reopens the same conversation with two independent attachments and no provider call', async () => {
  const first = await open();
  const second = await open();
  expect(first.attachmentId).not.toBe(second.attachmentId);
  expect(await state(first.read)).toMatchObject({ conversationId: record.id, revision: 4, pending: record.pending });
  expect(await state(second.read)).toMatchObject({ conversationId: record.id, revision: 4, pending: record.pending });
  expect(service.attachmentCount).toBe(2);
  service.detach(first.attachmentId);
  expect(service.attachmentCount).toBe(1);
  const reopened = await open();
  expect(await state(reopened.read)).toMatchObject({ conversationId: record.id, pending: record.pending });
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { namespace: 'local', id: 'operator' },
  { namespace: 'slack-user', id: '["team","user"]' },
])('restores the proposal and last speaker when recording $namespace fails', async (speaker) => {
  record.lastSpeaker = { namespace: 'agent', id: 'director' };
  store.write(record);
  const opened = await service.open({ conversationId: record.id, assignment: record.assignment,
    binding: record.bindings[0]!, speaker }, delivery);
  const original = store.read(record.id, record.assignment);
  const write = vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('speaker storage failed'); });

  expect(await service.submit({ attachmentId: opened.attachmentId, requestId: 'rejected', speaker,
    command: { kind: 'message', text: 'new request' } })).toMatchObject({ kind: 'error', code: 'storage_error' });

  expect(store.read(record.id, record.assignment)).toEqual(original);
  expect(await state(await service.snapshot(opened.attachmentId))).toMatchObject({ revision: 4, pending: record.pending, running: null });
  expect(execute).not.toHaveBeenCalled();
  expect(outputs).toEqual([]);
  expect(service.activeOperationCount).toBe(0);
  write.mockRestore();
  const human = await open();
  expect(await submit(human.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'accepted' });
  await finished();
  expect(doubles.register).toHaveBeenCalledOnce();
  expect(store.read(record.id, record.assignment)?.approval).toMatchObject({ revision: 4, state: 'registered' });
});

it('recovers the original proposal after both speaker storage and restoration fail', async () => {
  record.lastSpeaker = { namespace: 'agent', id: 'director' };
  store.write(record);
  const opened = await open();
  const original = store.read(record.id, record.assignment);
  vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('speaker storage failed'); });
  const write = ConversationStore.prototype.write;
  let failRestoration = true;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    if (failRestoration && value.running === null) throw new Error('restoration failed');
    write.call(this, value);
  });

  expect(await submit(opened.attachmentId, { kind: 'message', text: 'rejected' })).toMatchObject({ code: 'storage_error' });
  expect(await submit(opened.attachmentId, { kind: 'message', text: 'unavailable' })).toMatchObject({ code: 'storage_error' });
  await expect(service.snapshot(opened.attachmentId)).rejects.toMatchObject({ code: 'storage_error' });
  expect(execute).not.toHaveBeenCalled();
  failRestoration = false;
  expect(await state(await service.snapshot(opened.attachmentId))).toMatchObject({ revision: 4, pending: record.pending, running: null });
  expect(store.read(record.id, record.assignment)).toEqual(original);
  expect(service.activeOperationCount).toBe(0);
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'accepted' });
  await finished();
  expect(doubles.register).toHaveBeenCalledOnce();
});

it('captures a complete snapshot state before later conversation updates', async () => {
  const opened = await open();
  const oldRead = await service.snapshot(opened.attachmentId);
  await submit(opened.attachmentId, { kind: 'message', text: 'new request' });
  await finished();
  expect(await state(oldRead)).toMatchObject({ revision: 4, pending: record.pending, running: null });
  expect(await state(await service.snapshot(opened.attachmentId))).toMatchObject({ revision: 5, pending: null, running: null });
});

it.each([false, true])('retains permission denials only for the next human turn, including provider failure=%s, without persisting them', async (failed) => {
  const opened = await open();
  execute.mockImplementationOnce(async (input) => {
    input.onDenial?.('The destination needs human confirmation');
    if (failed) throw new Error('Provider failed after permission denial');
    return { message: 'Waiting', summary: null, sessionId: 'human-session', assignment: record.assignment };
  });
  await submit(opened.attachmentId, { kind: 'message', text: 'First human request' }); await finished();
  await submit(opened.attachmentId, { kind: 'message', text: 'Review the refusal' }); await finished();
  expect(execute.mock.calls[1]![0].prompt).toContain('The destination needs human confirmation');
  expect(execute.mock.calls[1]![0].instruction).toBe('Review the refusal');
  await submit(opened.attachmentId, { kind: 'message', text: 'Continue independently' }); await finished();
  expect(execute.mock.calls[2]![0].prompt).not.toContain('The destination needs human confirmation');
  expect(readFileSync(join(directory, 'conversations', `${record.id}.json`), 'utf8')).not.toContain('The destination needs human confirmation');
});

it('publishes the configured conversation failure notice from the daemon and still terminates the failed operation', async () => {
  const failure = new Error('Provider refused this operation');
  execute.mockRejectedValueOnce(failure);
  doubles.notification.mockResolvedValueOnce('Blocked conversation notice');
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'message', text: 'Please continue' }); await finished();
  expect(doubles.notification).toHaveBeenCalledExactlyOnceWith(repository, undefined, failure);
  expect(outputs).toContainEqual({ kind: 'notice', id: expect.any(String), message: 'Blocked conversation notice' });
  expect(store.read(record.id, record.assignment)?.running).toBeNull();
});

it('includes saved run results in the fresh human business context and bounds large goal memory', async () => {
  record.sessionId = null; store.write(record);
  const workLog = Array.from({ length: 100 }, (_, recordIndex) => ({
    id: '650e8400-e29b-41d4-a716-' + String(recordIndex).padStart(12, '0'),
    recordedAt: '2026-10-14T00:00:00Z', summary: 'task-X result ' + recordIndex + '詳細'.repeat(20000),
  }));
  const goals = Array.from({ length: 100 }, (_, index) => ({ ...goalRecord(),
    id: '550e8400-e29b-41d4-a716-' + String(index).padStart(12, '0'), objective: '目的'.repeat(30000),
    workLog,
  }));
  vi.spyOn(GoalStore.prototype, 'iterate').mockImplementation(async function* () { yield* goals; });
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'message', text: 'Review current work' }); await finished();
  const context = JSON.parse(execute.mock.calls[0]![0].recovery!.context);
  expect(Buffer.byteLength(JSON.stringify(context.goals))).toBeLessThanOrEqual(64 * 1024);
  expect(context.goals.repositories[0]).toMatchObject({ repositoryDirectory: repository, goalCount: 100 });
  expect(context.goals.repositories[0].goals.length).toBeGreaterThan(0);
  expect(context.goals.repositories[0].goals.length).toBeLessThan(100);
  expect(context.goals.repositories[0].goals[0]).toMatchObject({ workLogCount: 100,
    references: { goal: join(repository, '.takt', 'goals', goals[0]!.id, 'goal.json') } });
  expect(context.goals.repositories[0].goals[0].workLog).toHaveLength(3);
  expect(execute.mock.calls[0]![0].recovery!.context).toContain('task-X result');
  expect(execute.mock.calls[0]![0].recovery!.context).not.toContain(goals[0]!.objective);
});

it('preserves an unreadable goal-memory diagnostic instead of inventing an empty successful read', async () => {
  vi.spyOn(GoalStore.prototype, 'iterate').mockImplementation(async function* () { throw new Error('Goal directory cannot be listed'); });
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'message', text: 'Review current work' }); await finished();
  expect(execute.mock.calls[0]![0].recovery!.context).toContain('Goal directory cannot be listed');
  expect(execute.mock.calls[0]![0].recovery!.context).toContain('diagnostics');
  expect(outputs.at(-1)).toMatchObject({ kind: 'result', result: { kind: 'reply' } });
});

it('saves metadata and an unapproved summary without utterances, replies or a reserved goal ID', async () => {
  execute.mockResolvedValueOnce({ message: '返事の本文シマウマ', summary: { ...record.pending!.summary, repositoryDirectory: repository },
    sessionId: 'new-session', assignment: record.assignment });
  const opened = await open();
  expect((await submit(opened.attachmentId, { kind: 'message', text: 'あいことばキリン' })).kind).toBe('accepted');
  await finished();
  const saved = store.read(record.id, record.assignment)!;
  expect(saved).toMatchObject({ id: record.id, assignment: record.assignment, counterpart: record.counterpart,
    lastSpeaker: record.counterpart, bindings: record.bindings, provider: 'mock', model: 'model-A', sessionId: 'new-session',
    revision: 5, pending: { revision: 5, summary: record.pending!.summary }, approval: null, running: null });
  const persisted: unknown = JSON.parse(readFileSync(join(directory, 'conversations', `${record.id}.json`), 'utf8'));
  expect(Object.keys(persisted as object).sort()).toEqual(Object.keys(record).sort());
  for (const secret of ['あいことばキリン', '返事の本文シマウマ']) expect(JSON.stringify(persisted)).not.toContain(secret);
  expect(doubles.register).not.toHaveBeenCalled();
});

it('rejects an old revision after a newer message without goal registration', async () => {
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'message', text: 'revise the proposal' });
  await finished();
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'error', code: 'stale_summary' });
  expect(doubles.register).not.toHaveBeenCalled();
});

it.each([7, 9])('registers all %i large constraints under the same reserved ID and returns that registration on repeated approval', async (count) => {
  record.pending!.summary = { ...record.pending!.summary, startBranch: 'main', integrationBranch: 'release',
    outOfScope: ['CSV; 通知', 'CSV","通知', 'CSV', 'CSV'],
    constraints: Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a')) };
  store.write(record);
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 }); await finished();
  const reservation = store.read(record.id, record.assignment)!.approval!;
  expect(doubles.register).toHaveBeenCalledExactlyOnceWith({ ...record.pending!.summary, cwd: repository, id: reservation.goalId }, expect.any(AbortSignal));
  expect(new GoalStore(repository).find(reservation.goalId)).toMatchObject(record.pending!.summary);
  await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 }); await finished();
  expect(doubles.register).toHaveBeenCalledOnce();
  expect(outputs.at(-1)).toMatchObject({ kind: 'result', result: { kind: 'goal_registered', goal: { id: reservation.goalId } } });
});

it('withdraws immediately and refuses an old withdrawal without clearing a newer proposal', async () => {
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'dismiss_summary', revision: 4 }); await finished();
  expect(store.read(record.id, record.assignment)?.pending).toBeNull();
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'error', code: 'stale_summary' });
  execute.mockResolvedValueOnce({ message: 'New proposal', summary: { ...record.pending!.summary, repositoryDirectory: repository },
    sessionId: 'human-session', assignment: record.assignment });
  await submit(opened.attachmentId, { kind: 'message', text: 'Replace the proposal' }); await finished();
  const latest = store.read(record.id, record.assignment)!.pending;
  expect(await submit(opened.attachmentId, { kind: 'dismiss_summary', revision: 4 })).toMatchObject({ kind: 'error', code: 'stale_summary' });
  expect(store.read(record.id, record.assignment)?.pending).toEqual(latest);
  expect(doubles.register).not.toHaveBeenCalled();
});

it('persists its reservation before acceptance and registration, retains it after failure and reuses its ID', async () => {
  const opened = await open();
  doubles.register.mockImplementationOnce(async ({ id }: { id: string }) => {
    expect(store.read(record.id, record.assignment)).toMatchObject({ approval: { state: 'reserved', revision: 4, goalId: id }, pending: record.pending });
    throw new Error('creation failed');
  });
  expect((await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).kind).toBe('accepted');
  expect(store.read(record.id, record.assignment)!.approval).toMatchObject({ state: 'reserved', revision: 4 });
  await finished();
  const reserved = store.read(record.id, record.assignment)!.approval!;
  expect(await submit(opened.attachmentId, { kind: 'message', text: 'replace' })).toMatchObject({ kind: 'error', code: 'registration_recovery' });
  expect((await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4, requirePending: true })).kind).toBe('accepted');
  await finished();
  expect(doubles.register.mock.calls.map(([input]) => input.id)).toEqual([reserved.goalId, reserved.goalId]);
  expect(store.read(record.id, record.assignment)).toMatchObject({ approval: { ...reserved, state: 'registered' }, pending: null, running: null });
  await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 });
  await finished();
  expect(doubles.register).toHaveBeenCalledTimes(2);
  expect(outputs.filter((output) => output.kind === 'result' && output.result.kind === 'goal_registered')).toHaveLength(2);
});

it('does not accept or register when the reservation write fails', async () => {
  const opened = await open();
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'error', code: 'storage_error' });
  expect(store.read(record.id, record.assignment)!.approval).toBeNull();
  expect(doubles.register).not.toHaveBeenCalled();
  expect(await state(await service.snapshot(opened.attachmentId))).toMatchObject({ running: null, pending: record.pending });
});

it.each(['abort_turn', 'close'] as const)('keeps the reserved proposal when %s interrupts registration, then registers the same ID on reapproval', async (kind) => {
  const opened = await open();
  let release!: () => void;
  let registrationSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  doubles.register.mockImplementationOnce(async (_input, signal: AbortSignal) => {
    registrationSignal = signal;
    await gate;
    signal.throwIfAborted();
    throw new Error('An aborted registration must not reach creation');
  });
  const accepted = await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 });
  if (accepted.kind !== 'accepted') throw new Error('Approval was not accepted');
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(registrationSignal).toBeDefined());
    if (kind === 'close') closing = service.close();
    else expect(await submit(opened.attachmentId, { kind: 'abort_turn', operationId: accepted.operationId })).toEqual(accepted);
    expect(registrationSignal!.aborted).toBe(true);
    expect(service.activeOperationCount).toBe(1);
  } finally { release(); }
  await closing;
  await finished();
  const saved = store.read(record.id, record.assignment)!;
  expect(saved).toMatchObject({ revision: 4, pending: record.pending, approval: { state: 'reserved', revision: 4 }, running: null });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', operationId: accepted.operationId, result: expect.objectContaining({ kind: 'error' }) }));
  expect(new GoalStore(repository).find(saved.approval!.goalId)).toBeUndefined();
  if (kind === 'close') service = createConversationService({ configDirectory: directory, owner,
    runtime: { resolve: resolveRuntime, close: closeRuntime }, onDomainChange: vi.fn() });
  const reopened = await open();
  const registeredBefore = doubles.register.mock.calls.length;
  expect(await submit(reopened.attachmentId, { kind: 'approve_summary', revision: 3 })).toMatchObject({ kind: 'error' });
  expect(doubles.register).toHaveBeenCalledTimes(registeredBefore);
  expect((await submit(reopened.attachmentId, { kind: 'approve_summary', revision: 4 })).kind).toBe('accepted');
  await finished();
  expect(doubles.register.mock.calls.map(([input]) => input.id)).toEqual([saved.approval!.goalId, saved.approval!.goalId]);
  expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 5, pending: null, approval: { ...saved.approval, state: 'registered' }, running: null });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({ kind: 'goal_registered', goal: expect.objectContaining({ id: saved.approval!.goalId }) }) }));
});

it('preserves the registered receipt and result when approval is cancelled after goal publication', async () => {
  const opened = await open();
  let release!: () => void;
  let goalId: string | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  doubles.register.mockImplementationOnce(async ({ id }: { id: string }) => {
    const goal = saveGoal(id);
    goalId = id;
    await gate;
    return goal;
  });
  const accepted = await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 });
  if (accepted.kind !== 'accepted') throw new Error('Approval was not accepted');
  try {
    await vi.waitFor(() => expect(goalId).toBeDefined());
    await submit(opened.attachmentId, { kind: 'abort_turn', operationId: accepted.operationId });
  } finally { release(); }
  await finished();
  expect(store.read(record.id, record.assignment)).toMatchObject({ pending: null, approval: { state: 'registered', goalId }, running: null });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', operationId: accepted.operationId,
    result: expect.objectContaining({ kind: 'goal_registered', goal: expect.objectContaining({ id: goalId }) }) }));
});

it('keeps an accepted operation running after detach and exposes its saved pending on reconnect', async () => {
  let finish!: (value: Awaited<ReturnType<typeof execute>>) => void;
  execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const first = await open();
    const second = await open();
    const accepted = await submit(first.attachmentId, { kind: 'message', text: 'first' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const busyCommands: Parameters<typeof service.submit>[0]['command'][] = [
      { kind: 'message', text: 'rejected' }, { kind: 'approve_summary', revision: 4 }, { kind: 'dismiss_summary', revision: 4 },
      { kind: 'answer_question', target: { goalId: goalRecord().id, repositoryDirectory: repository },
        questionId: '650e8400-e29b-41d4-a716-446655440001', answer: { text: 'CSV' } },
      ...(['pause_goal', 'resume_goal', 'abort_goal'] as const).map((kind) => ({ kind, goalId: goalRecord().id })),
    ];
    for (const command of busyCommands) expect(await submit(second.attachmentId, command))
      .toEqual({ kind: 'busy', operationId: 'operationId' in accepted ? accepted.operationId : '' });
    service.detach(first.attachmentId); service.detach(second.attachmentId);
    expect(execute.mock.calls[0]![0].abortSignal.aborted).toBe(false);
    expect(service.activeOperationCount).toBe(1);
    finish({ message: 'done', summary: { ...record.pending!.summary, repositoryDirectory: repository }, sessionId: 'finished-session', assignment: record.assignment });
    await finished();
    const reopened = await open();
    expect(await state(reopened.read)).toMatchObject({ conversationId: record.id, revision: 5, pending: { revision: 5, summary: record.pending!.summary }, running: null });
    expect(execute).toHaveBeenCalledOnce();
    expect(doubles.register).not.toHaveBeenCalled();
  } finally {
    finish?.({ message: 'done', summary: null, sessionId: 'finished-session', assignment: record.assignment });
  }
});

it('accepts a director speaker during a human turn and runs its saved message before the next request', async () => {
  const human = await open();
  const speaker = { namespace: 'agent', id: 'director' };
  const director = await service.open({ conversationId: record.id, assignment: record.assignment,
    binding: { port: 'director', key: 'daemon-director', counterpart: record.counterpart }, speaker }, delivery);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async () => {
    await gate;
    return { message: 'human reply', summary: null, sessionId: 'human-session', assignment: record.assignment };
  });
  try {
    const first = await submit(human.attachmentId, { kind: 'message', text: 'human request' });
    expect(first.kind).toBe('accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const queued = await service.submit({ attachmentId: director.attachmentId, requestId: 'director-request', speaker,
      command: { kind: 'message', text: 'queued director request' } });
    expect(queued.kind).toBe('accepted');
    if (queued.kind !== 'accepted') throw new Error('Director message must be accepted');
    expect(queued.operationId).not.toBe('operationId' in first ? first.operationId : undefined);
    release();
    await finished();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['human request', 'queued director request']);
    expect(store.read(record.id, record.assignment)?.lastSpeaker).toEqual(speaker);
    const second = await service.submit({ attachmentId: director.attachmentId, requestId: 'explicit-director-request', speaker,
      command: { kind: 'message', text: 'explicit director request' } });
    expect(second.kind).toBe('accepted');
    if (second.kind === 'accepted') lastOperationId = second.operationId;
    await finished();

    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['human request', 'queued director request', 'explicit director request']);
    expect(store.read(record.id, record.assignment)?.lastSpeaker).toEqual(speaker);
    expect(outputs).toContainEqual({ kind: 'result', operationId: 'operationId' in second ? second.operationId : undefined,
      result: { kind: 'reply', message: 'manager reply' } });
  } finally { release(); }
});

it('rejects a director speaker submitted through a human attachment without running or changing its record', async () => {
  const human = await open();
  const before = readFileSync(join(directory, 'conversations', `${record.id}.json`));

  const rejected = await service.submit({ attachmentId: human.attachmentId, requestId: 'spoofed-director',
    speaker: { namespace: 'agent', id: 'director' }, command: { kind: 'message', text: 'director request' } });

  expect(rejected).toMatchObject({ kind: 'error', code: 'invalid_input' });
  expect(execute).not.toHaveBeenCalled();
  expect(service.activeOperationCount).toBe(0);
  expect(readFileSync(join(directory, 'conversations', `${record.id}.json`))).toEqual(before);
});

it.each([
  { pid: 999, startTime: 'daemon-A' }, { pid: owner.pid, startTime: 'daemon-A' },
  { pid: owner.pid, startTime: owner.identity.startTime },
])('repairs restored running ownership %j without replaying input or losing the reservation', async ({ pid, startTime }) => {
  record.running = { operationId: '22222222-2222-4222-8222-222222222222', kind: 'approve_summary', owner: { pid, identity: { startTime } } };
  record.approval = { state: 'reserved', revision: 4, goalId: '11111111-1111-4111-8111-111111111111', repositoryDirectory: repository };
  store.write(record);
  const opened = await open();
  expect(await state(opened.read)).toMatchObject({ interrupted: true, running: null, pending: record.pending, approval: record.approval });
  expect(store.read(record.id, record.assignment)).toMatchObject({ sessionId: null, running: null, pending: record.pending, approval: record.approval });
  expect(execute).not.toHaveBeenCalled();
  expect((await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).kind).toBe('accepted');
  await finished();
});

it('rejects a mismatched conversation ID before reading or writing its record', async () => {
  const read = vi.spyOn(ConversationStore.prototype, 'read');
  const write = vi.spyOn(ConversationStore.prototype, 'write');
  await expect(service.open({ conversationId: `manager-${'0'.repeat(64)}`, assignment: record.assignment,
    binding: record.bindings[0]!, speaker: record.counterpart }, delivery)).rejects.toMatchObject({ code: 'invalid_assignment' });
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it('rechecks membership on the same loaded workspace before reserving or approving its earlier proposal', async () => {
  const workspace = { kind: 'workspace' as const, workspaceId: '11111111-1111-4111-8111-111111111111' };
  record.assignment = workspace; record.id = conversationId(workspace); store.write(record);
  doubles.assignment.mockResolvedValue({ ...workspace, name: 'Workspace', repositoryDirectories: [repository] });
  const opened = await open();
  expect(await state(opened.read)).toMatchObject({ pending: record.pending, revision: 4 });
  doubles.assignment.mockResolvedValue({ ...workspace, name: 'Workspace', repositoryDirectories: [] });
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).toMatchObject({ kind: 'error', code: 'invalid_assignment' });
  expect(store.read(record.id, workspace)).toMatchObject({ approval: null, pending: record.pending, revision: 4, running: null });
  expect(doubles.register).not.toHaveBeenCalled();
});

it('keeps a registered receipt without recreating its removed goal', async () => {
  record.pending = null; record.revision = 5;
  record.approval = { state: 'registered', revision: 4, goalId: '11111111-1111-4111-8111-111111111111', repositoryDirectory: repository };
  store.write(record);
  const opened = await open();
  expect((await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).kind).toBe('accepted');
  await finished();
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({ kind: 'error', code: 'registration_recovery' }) }));
  expect(doubles.register).not.toHaveBeenCalled();
  expect(store.read(record.id, record.assignment)!.approval).toEqual(record.approval);
});

it('rejects an unsafe stored proposal before reserving an ID or registering a goal', async () => {
  record.pending!.summary.objective = 'unsafe\u001b[31m'; store.write(record);
  const opened = await open();
  expect((await submit(opened.attachmentId, { kind: 'approve_summary', revision: 4 })).kind).toBe('error');
  expect(store.read(record.id, record.assignment)!.approval).toBeNull(); expect(doubles.register).not.toHaveBeenCalled();
});

it('clears the persisted session when the model changes and again when the same runtime context changes', async () => {
  const opened = await open();
  resolveRuntime.mockResolvedValueOnce({ provider: 'mock', model: 'model-B', language: 'en', contextKey: 'context-B', executor: { execute } });
  await submit(opened.attachmentId, { kind: 'message', text: 'model changed' }); await finished();
  expect(execute.mock.calls[0]![0].sessionId).toBeUndefined();
  expect(store.read(record.id, record.assignment)).toMatchObject({ model: 'model-B', sessionId: 'next-session' });
  resolveRuntime.mockResolvedValueOnce({ provider: 'mock', model: 'model-B', language: 'en', contextKey: 'context-C', executor: { execute } });
  await submit(opened.attachmentId, { kind: 'message', text: 'context changed' }); await finished();
  expect(execute.mock.calls[1]![0].sessionId).toBeUndefined();
});

it('drains an in-progress admission during shutdown without accepting or invoking the provider afterwards', async () => {
  const opened = await open();
  let finishResolution!: (value: ManagerAssignment) => void;
  doubles.assignment.mockImplementationOnce(() => new Promise((resolve) => { finishResolution = resolve; }));
  const submitting = submit(opened.attachmentId, { kind: 'message', text: 'races with shutdown' });
  service.stopAccepting();
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  try {
    await Promise.resolve(); expect(closed).toBe(false);
  } finally { finishResolution(assignment); }
  expect(await submitting).toMatchObject({ kind: 'error', code: 'shutting_down' });
  await closing; expect(execute).not.toHaveBeenCalled(); expect(store.read(record.id, record.assignment)!.running).toBeNull();
});

it.each(['message', 'approve_summary'] as const)('refuses %s at revision exhaustion without wrapping or creating a reservation', async (kind) => {
  record.revision = Number.MAX_SAFE_INTEGER; record.pending!.revision = record.revision; store.write(record);
  const opened = await open();
  const result = await submit(opened.attachmentId, kind === 'message' ? { kind, text: 'new input' } : { kind, revision: record.revision });
  expect(result.kind).toBe('error'); expect(service.activeOperationCount).toBe(0);
  expect(store.read(record.id, record.assignment)).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, pending: record.pending, approval: null, running: null });
  expect(execute).not.toHaveBeenCalled(); expect(doubles.register).not.toHaveBeenCalled();
});

it('keeps a failed session invalidation unavailable until executor cleanup has finished', async () => {
  const opened = await open();
  let release!: () => void; let cleaning = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const write = ConversationStore.prototype.write;
  let fail = true;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    if (fail && value.sessionId === null) { fail = false; throw new Error('invalidation write failed'); }
    return write.call(this, value);
  });
  execute.mockImplementationOnce(async (input) => {
    try { await input.recovery!.invalidateSession(); return { message: 'unexpected', summary: null, sessionId: undefined, assignment: record.assignment }; }
    finally { cleaning = true; await gate; }
  });
  try {
    await submit(opened.attachmentId, { kind: 'message', text: 'resume' });
    await vi.waitFor(() => expect(cleaning).toBe(true));
    await expect(service.snapshot(opened.attachmentId)).rejects.toMatchObject({ code: 'storage_error' });
    expect(service.activeOperationCount).toBe(1);
    expect(await submit(opened.attachmentId, { kind: 'message', text: 'cannot overlap cleanup' })).toMatchObject({ code: 'storage_error' });
  } finally { release(); }
  await finished();
  expect(store.read(record.id, record.assignment)).toMatchObject({ running: null, sessionId: null });
  expect(execute).toHaveBeenCalledOnce();
});

it('holds a failed terminal save unavailable and recovers persistence before accepting another operation', async () => {
  const opened = await open();
  const write = ConversationStore.prototype.write;
  let fail = true;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    if (fail && value.running === null) throw new Error('terminal write failed');
    return write.call(this, value);
  });
  await submit(opened.attachmentId, { kind: 'message', text: 'first' });
  await vi.waitFor(() => expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({ code: 'storage_error' }) })));
  expect(service.activeOperationCount).toBe(1);
  expect(await submit(opened.attachmentId, { kind: 'message', text: 'unavailable' })).toMatchObject({ code: 'storage_error' });
  fail = false;
  expect(await state(await service.snapshot(opened.attachmentId))).toMatchObject({ running: null, revision: 5 });
  expect(service.activeOperationCount).toBe(0);
  await submit(opened.attachmentId, { kind: 'message', text: 'retry' }); await finished();
  expect(execute).toHaveBeenCalledTimes(2);
});

it('keeps cancellation tied to its operation ID and refuses late output before admitting the next turn', async () => {
  const opened = await open();
  let release: (() => void) | undefined;
  const defer = () => execute.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ message: 'done', summary: { ...record.pending!.summary, repositoryDirectory: repository }, sessionId: 'new-session', assignment: record.assignment });
  }));
  try {
    defer();
    const first = await submit(opened.attachmentId, { kind: 'message', text: 'first' });
    if (first.kind !== 'accepted') throw new Error('First turn was not accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(await submit(opened.attachmentId, { kind: 'abort_turn', operationId: first.operationId })).toEqual(first);
    expect(execute.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 6, pending: null, sessionId: null });
    release!(); await finished();
    expect(store.read(record.id, record.assignment)!.pending).toBeNull();
    defer();
    const second = await submit(opened.attachmentId, { kind: 'message', text: 'second' });
    if (second.kind !== 'accepted') throw new Error('Second turn was not accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(second.operationId).not.toBe(first.operationId);
    expect(await submit(opened.attachmentId, { kind: 'abort_turn', operationId: first.operationId })).toMatchObject({ code: 'invalid_input' });
    expect(execute.mock.calls[1]![0].abortSignal.aborted).toBe(false);
    release!(); await finished();
    expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 7, pending: { revision: 7 }, running: null });
  } finally { release?.(); }
});

it('finishes a captured repository turn after promotion, announces the changed assignment and requires reopening', async () => {
  const opened = await open();
  execute.mockImplementationOnce(async () => {
    doubles.assignment.mockResolvedValue({ kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111', name: 'Workspace', repositoryDirectories: [repository] });
    return { message: 'finished captured turn', summary: { ...record.pending!.summary, repositoryDirectory: repository }, sessionId: 'captured-session', assignment: record.assignment };
  });
  await submit(opened.attachmentId, { kind: 'message', text: 'promote' }); await finished();
  expect(store.read(record.id, record.assignment)).toMatchObject({ assignment: record.assignment, revision: 5, pending: { revision: 5, repositoryDirectory: repository } });
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'notice', message: expect.stringContaining('assignment') }));
  expect(await submit(opened.attachmentId, { kind: 'approve_summary', revision: 5 })).toMatchObject({ code: 'invalid_assignment' });
  expect(doubles.register).not.toHaveBeenCalled();
});

it.each(['fresh-session', undefined])('reconstructs an explicitly rejected provider session and stores its returned ID (%s)', async (freshSessionId) => {
  const call = vi.fn<ProviderAgent['call']>();
  call.mockResolvedValueOnce({ persona: 'manager', status: 'error', content: '', timestamp: new Date(),
    error: 'rejected resume', failureCategory: 'session_continuation_unsupported' });
  call.mockImplementationOnce(async (prompt, options) => {
    expect(store.read(record.id, record.assignment)!.sessionId).toBeNull();
    expect(options.sessionId).toBeUndefined();
    const context = JSON.parse(prompt.split('Business context (not approval): ')[1]!);
    expect(context.pending).toEqual(record.pending);
    expect(context.assignment.repositoryDirectories).toEqual([repository]);
    expect(context.goals.repositories[0].goals[0].id).toBe(goalRecord().id);
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { message: 'fresh reply', summary: null }, sessionId: freshSessionId };
  });
  saveGoal(goalRecord().id);
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', provider: makeProvider({ setup: () => ({ call }) }), model: 'model-A', lang: 'en' },
    strategy: { systemPrompt: 'manager fixture' } });
  execute.mockImplementation((value) => executor.execute(value));
  const opened = await open();
  await submit(opened.attachmentId, { kind: 'message', text: 'continue' });
  await finished();
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0]![1].sessionId).toBe('provider-session');
  expect(store.read(record.id, record.assignment)!.sessionId).toBe(freshSessionId ?? null);
  expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'fresh reply' } }));
});

it.each(([
  ['codex', 'resume'], ['claude-terminal', 'resume'],
  ['codex', 'generic'], ['claude-terminal', 'generic'],
  ['codex', 'other-id'], ['claude-terminal', 'other-id'],
  ['codex', 'body'], ['claude-terminal', 'body'],
  ['codex', 'tool'], ['codex', 'second-failure'],
] as const).flatMap(([providerType, outcome]) =>
  (outcome === 'resume' ? ['current', 'goal-status', 'execution-status', 'task-status'] as const : ['current'] as const)
    .map((state) => ({ providerType, outcome, state }))),
)('connects $providerType rejection to durable recovery and delivery ($outcome, $state)', async ({ providerType, outcome, state: stateVariant }) => {
  const savedId = '00000000-0000-4000-8000-000000000099';
  record = { ...record, provider: providerType, sessionId: savedId };
  store.write(record);
  saveGoal(goalRecord().id);
  let attempts = 0;
  const prompts: string[] = [];
  const ids: Array<string | undefined> = [];
  const checkFresh = (prompt: string) => {
    expect(store.read(record.id, record.assignment)!.sessionId).toBeNull();
    const context = JSON.parse(prompt.split('Business context (not approval): ')[1]!);
    expect(context.pending).toEqual(record.pending);
    expect(context.assignment.repositoryDirectories).toEqual([repository]);
    expect(context.goals.repositories[0].goals).toEqual([
      expect.objectContaining({
        id: goalRecord().id,
        status: stateVariant === 'goal-status' ? 'created' : 'awaiting_merge',
        executionStatus: stateVariant === 'execution-status' ? 'active' : 'paused',
        taskCount: 1,
        taskStates: stateVariant === 'task-status' ? { running: 1 } : { pending: 1 },
      }),
    ]);
    expect(prompt).toContain('continue');
  };
  doubles.codexRun.mockImplementation(async (id: string | undefined, prompt: string) => {
    attempts++;
    prompts.push(prompt); ids.push(id);
    if (id === undefined) checkFresh(prompt);
    const failureId = outcome === 'other-id' ? 'another-session' : savedId;
    const diagnostic = `Error: thread/resume: thread/resume failed: no rollout found for thread id ${failureId} (code -32600)`;
    return { events: (async function* () {
      if (outcome === 'body' || (attempts === 2 && outcome !== 'second-failure')) {
        yield { type: 'thread.started', thread_id: id ?? 'fresh-session' };
        yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: JSON.stringify({ message: outcome === 'body' ? 'session_continuation_unsupported' : 'fresh reply', summary: null }) } };
        yield { type: 'turn.completed' };
      } else {
        if (outcome === 'tool') yield { type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'test' } };
        throw new Error(outcome === 'generic' || attempts === 2 ? 'Authentication failed' : `Codex Exec exited with code 1: Reading prompt from stdin...\n${diagnostic}\n`);
      }
    })() };
  });
  let currentId: string | undefined;
  let freshTerminalId: string | undefined;
  let captures = 0;
  doubles.tmux.mockImplementation((_command: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    let stdout = '';
    if (args[0] === 'new-session') {
      attempts++;
      const resumeIndex = args.indexOf('--resume');
      currentId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
      ids.push(currentId);
      if (currentId === undefined) freshTerminalId = args[args.indexOf('--session-id') + 1];
      captures = 0;
    } else if (args[0] === 'display-message') {
      stdout = outcome === 'body' ? '0:' : '1:1';
    } else if (args[0] === 'capture-pane') {
      captures++;
      stdout = currentId !== undefined && outcome !== 'body'
        ? outcome === 'generic' ? 'Authentication failed' : `No conversation found with session ID: ${outcome === 'other-id' ? 'another-session' : currentId}`
        : captures % 3 === 0 ? 'prompt pasted' : '❯';
    }
    callback(null, { stdout, stderr: '' });
  });
  doubles.transcript.mockImplementation(() => ({
    sessionId: currentId ?? freshTerminalId,
    assistantText: JSON.stringify({ message: outcome === 'body' ? 'session_continuation_unsupported' : 'fresh reply', summary: null }),
    events: outcome === 'body' ? [
      { type: 'tool_use', id: 'tool', tool: 'Bash', input: {} },
      { type: 'tool_result', id: 'tool', content: `No conversation found with session ID: ${savedId}`, isError: false },
    ] : [],
  }));
  const provider = providerType === 'codex' ? new CodexProvider() : new ClaudeTerminalProvider();
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType, provider, model: 'model-A', lang: 'en' },
    ...(providerType === 'codex' ? { permissionJudge: { resolution: { provider: 'codex', model: undefined, providerOptions: {} }, language: 'en' as const, systemPrompt: 'judge', managerPersona: 'manager', managerPolicy: 'policy' } } : {}),
    strategy: { systemPrompt: 'manager fixture' } });
  execute.mockImplementation((value) => executor.execute(value));
  resolveRuntime.mockResolvedValue({ provider: providerType, model: 'model-A', language: 'en', contextKey: 'context-A', executor: { execute } });
  doubles.pasteInput.mockImplementation((text: string) => {
    prompts.push(text);
    if (currentId === undefined) checkFresh(text);
  });
  const opened = await open();
  const currentGoal = GoalSchema.parse({
    ...goalRecord(), ...record.pending!.summary,
    status: stateVariant === 'goal-status' ? 'created' : 'awaiting_merge',
    executionStatus: stateVariant === 'execution-status' ? 'active' : 'paused',
    completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main',
      summary: 'Ready for human merge', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0,
        files: [{ path: 'result.ts', additions: 1, deletions: 0 }], truncated: false, totalsTruncated: false },
    },
  });
  writeFileSync(join(repository, '.takt', 'goals', currentGoal.id, 'goal.json'), JSON.stringify(currentGoal));
  const taskStatus = stateVariant === 'task-status' ? 'running' : 'pending';
  doubles.taskItems.mockReturnValue([{
    goalId: currentGoal.id, kind: taskStatus, status: taskStatus,
    name: 'current-goal-task', createdAt: '2026-10-24T00:00:00.000Z',
    filePath: join(repository, '.takt', 'tasks', 'current-goal-task.md'),
  }]);
  await submit(opened.attachmentId, { kind: 'message', text: 'continue' });
  await finished();
  const persisted = store.read(record.id, record.assignment)!;
  expect(ids[0]).toBe(savedId);
  if (outcome === 'resume') {
    expect(attempts).toBe(2);
    expect(ids[1]).toBeUndefined();
    expect(prompts).toHaveLength(providerType === 'codex' ? 2 : 1);
    expect(persisted.sessionId).toBe(providerType === 'codex' ? 'fresh-session' : freshTerminalId);
    expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'fresh reply' } }));
  } else if (outcome === 'body') {
    expect(attempts).toBe(1);
    expect(persisted.sessionId).toBe(savedId);
    expect(outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'session_continuation_unsupported' } }));
  } else {
    expect(attempts).toBe(outcome === 'second-failure' ? 2 : 1);
    expect(persisted.sessionId).toBe(outcome === 'tool' || outcome === 'second-failure' ? null : savedId);
    expect(outputs.some((output) => output.kind === 'result' && output.result.kind === 'error')).toBe(true);
  }
});

it.each([1, 4])('caches goal projections after a completed initial read with %i inquiries per goal', async (count) => {
  const goals = [5, 6, 7].map((prefix) => ({ ...goalRecord(), id: `${prefix}50e8400-e29b-41d4-a716-446655440000`,
    questions: Array.from({ length: count }, (_, index) => ({ ...createInquiry({ body: `Question ${prefix}/${index}` }),
      createdAt: `2026-10-24T00:00:0${index}.000Z` })),
  }));
  for (const goal of goals) await new GoalStore(repository).create(goal);
  const reads = vi.spyOn(privateFiles, 'readPrivateFileState');
  const config = vi.spyOn(managerConfig, 'resolveManagerConfig');
  const opened = await open();
  const items: SnapshotItem[] = [];
  for await (const item of opened.read.items) items.push(item);
  opened.read.complete();
  expect(config).toHaveBeenCalledExactlyOnceWith(repository);
  expect(reads.mock.calls.map(([path]) => path).filter((path) => basename(path) === 'goal.json').sort())
    .toEqual(goals.map((goal) => join(repository, '.takt', 'goals', goal.id, 'goal.json')).sort());
  expect(items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual(goals.map((goal) => goal.id));
  expect(items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry.question.id] : []))
    .toEqual(Array.from({ length: count }, (_, index) => goals.map((goal) => goal.questions[index]!.id)).flat());
  reads.mockClear();
  const delta = await service.snapshot(opened.attachmentId);
  const changes: SnapshotItem[] = [];
  for await (const item of delta.items) changes.push(item);
  expect(changes).toEqual([]);
  delta.complete();
  expect(reads.mock.calls.filter(([path]) => basename(path) === 'goal.json')).toHaveLength(0);
});

const directorActor = { namespace: 'agent', id: 'director' } as const;
async function openDirector() {
  const opened = await service.open({ conversationId: record.id, assignment: record.assignment,
    binding: { port: 'director', key: record.id, counterpart: record.counterpart }, speaker: directorActor }, delivery);
  opened.read.cancel();
  return opened.attachmentId;
}
function tell(attachmentId: string, text: string) {
  return service.submit({ attachmentId, requestId: randomUUID(), speaker: directorActor, command: { kind: 'message', text } });
}
function holdNextTurn() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async () => {
    await gate;
    return { message: 'held reply', summary: null, sessionId: 'held-session', assignment: record.assignment };
  });
  return release;
}

it('persists a director message during a human turn and executes it once after that turn finishes', async () => {
  const director = await openDirector();
  const human = await open();
  const release = holdNextTurn();
  try {
    const current = await submit(human.attachmentId, { kind: 'message', text: 'held human input' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const before = store.read(record.id, record.assignment)!;
    const queued = await tell(director, 'durable director input');
    expect(queued.kind).toBe('accepted');
    if (queued.kind !== 'accepted' || current.kind !== 'accepted') throw new Error('Messages must be accepted');
    expect(queued.operationId).not.toBe(current.operationId);
    const saved = store.read(record.id, record.assignment)!;
    expect(JSON.stringify(saved)).toContain('durable director input');
    expect(JSON.stringify(saved)).toContain(queued.operationId);
    expect(JSON.stringify(saved)).toContain(JSON.stringify(directorActor));
    expect(JSON.stringify(saved)).toContain(conversationId({ kind: 'daemon' }));
    expect(saved).toMatchObject({ running: before.running, lastSpeaker: before.lastSpeaker,
      revision: before.revision, pending: before.pending, approval: before.approval });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].abortSignal.aborted).toBe(false);
    release();
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: queued.operationId,
      result: { kind: 'reply', message: 'manager reply' } }));
    await finished();
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['held human input', 'durable director input']);
    expect(execute.mock.calls[1]![0]).toMatchObject({ conversationOperationId: queued.operationId });
    expect(execute.mock.calls[1]![0].prompt).toContain('Speaker: {"namespace":"agent","id":"director"}');
    expect(JSON.stringify(store.read(record.id, record.assignment))).not.toContain('durable director input');
    expect(JSON.stringify(store.read(record.id, record.assignment))).not.toContain('held human input');
  } finally { release(); }
});

it('saves even an idle director input before atomically removing it and setting the running director operation', async () => {
  const director = await openDirector();
  const writes: ConversationRecord[] = [];
  const write = ConversationStore.prototype.write;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    write.call(this, value);
    writes.push(structuredClone(value));
  });
  const release = holdNextTurn();
  try {
    const accepted = await tell(director, 'idle durable input');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const queuedIndex = writes.findIndex((value) => JSON.stringify(value).includes('idle durable input'));
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    const startedIndex = writes.findIndex((value) => value.running?.operationId === accepted.operationId);
    expect(startedIndex).toBeGreaterThan(queuedIndex);
    expect(writes[queuedIndex]).toMatchObject({ running: null, revision: 4, pending: record.pending });
    for (const value of writes.slice(queuedIndex, startedIndex)) {
      expect(JSON.stringify(value)).toContain('idle durable input');
      expect(value.running).toBeNull();
    }
    expect(writes[startedIndex]).toMatchObject({ lastSpeaker: directorActor, running: { operationId: accepted.operationId },
      revision: 4, pending: record.pending });
    expect(JSON.stringify(writes[startedIndex])).not.toContain('idle durable input');
  } finally { release(); }
  await finished();
});

it('keeps the active human operation and revision four proposal unchanged when a director message is saved', async () => {
  const director = await openDirector();
  const human = await open();
  const goal = { ...goalRecord(), status: 'awaiting_merge' as const,
    pullRequest: { number: 1950, url: 'https://github.invalid/pr/1950' }, completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } };
  await new GoalStore(repository).create(goal);
  const merge = vi.spyOn(goalPrMerge, 'mergeGoalPr').mockResolvedValue({ success: true, prNumber: 1950, exitCode: 0, output: 'merged', truncated: false });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  doubles.register.mockImplementationOnce(async ({ id }: { id: string }) => { await gate; return saveGoal(id); });
  try {
    const current = await submit(human.attachmentId, { kind: 'approve_summary', revision: 4 });
    expect(current.kind).toBe('accepted');
    if (current.kind !== 'accepted') throw new Error('Human operation must be accepted');
    await vi.waitFor(() => expect(doubles.register).toHaveBeenCalledOnce());
    const before = store.read(record.id, record.assignment)!;
    expect(before).toMatchObject({ revision: 4, pending: record.pending, lastSpeaker: record.counterpart,
      running: { operationId: current.operationId } });
    const accepted = await tell(director, 'director waiting for human registration');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Director message must be saved');
    expect(store.read(record.id, record.assignment)).toMatchObject({ running: before.running, revision: 4,
      pending: before.pending, approval: before.approval, lastSpeaker: record.counterpart });
    const refused = await mergeTaktGoalPr({ cwd: repository, goalId: goal.id, prNumber: 1950,
      conversationOperationId: current.operationId }, { allowedProjectRoot: repository,
      managerConversation: { configDirectory: directory, assignment: record.assignment } }, new AbortController().signal);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('requires an active message from the director');
    expect(merge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
      result: { kind: 'reply', message: 'manager reply' } }), { timeout: 5000 });
    await finished();
    expect(execute).toHaveBeenCalledOnce();
  } finally { release(); }
});

it('executes director inputs in saved order with distinct IDs and never executes a rejected human input', async () => {
  const director = await openDirector();
  const human = await open();
  execute.mockImplementation(async (input) => ({ message: `reply:${input.instruction}`, summary: null,
    sessionId: 'session', assignment: record.assignment }));
  const release = holdNextTurn();
  try {
    const current = await submit(human.attachmentId, { kind: 'message', text: 'human turn' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const first = await tell(director, 'first director input');
    const second = await tell(director, 'second director input');
    expect(first.kind).toBe('accepted'); expect(second.kind).toBe('accepted');
    if (first.kind !== 'accepted' || second.kind !== 'accepted' || current.kind !== 'accepted') throw new Error('Messages must be accepted');
    expect(new Set([current.operationId, first.operationId, second.operationId]).size).toBe(3);
    expect(await submit(human.attachmentId, { kind: 'message', text: 'rejected human input' })).toMatchObject({ kind: 'busy' });
    expect(JSON.stringify(store.read(record.id, record.assignment))).not.toContain('rejected human input');
    release();
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: second.operationId,
      result: { kind: 'reply', message: 'reply:second director input' } }));
    await finished();
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['human turn', 'first director input', 'second director input']);
    const savedResults = new DirectorMessageResultStore(directory);
    for (const [accepted, text] of [[first, 'first director input'], [second, 'second director input']] as const) {
      expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId, result: { kind: 'reply', message: `reply:${text}` } });
      expect(savedResults.read(accepted.operationId)).toMatchObject({ operationId: accepted.operationId,
        result: { kind: 'reply', message: `reply:${text}` } });
    }
  } finally { release(); }
});

it('returns busy without saving a human input while a director message is queued and no turn is persisted as running', async () => {
  const human = await open();
  const director = await openDirector();
  const eventId = randomUUID();
  let release: (() => void) | undefined = await scheduler.acquire(record.id, eventId, new AbortController().signal);
  try {
    const accepted = await tell(director, 'pending director input');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Director input must be accepted');
    expect(store.read(record.id, record.assignment)).toMatchObject({ running: null,
      directorMessages: [{ operationId: accepted.operationId, text: 'pending director input' }] });
    expect(await submit(human.attachmentId, { kind: 'message', text: 'rejected while only queued' }))
      .toEqual({ kind: 'busy', operationId: eventId });
    expect(JSON.stringify(store.read(record.id, record.assignment))).not.toContain('rejected while only queued');
    expect(execute).not.toHaveBeenCalled();
    release();
    release = undefined;
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
      result: { kind: 'reply', message: 'manager reply' } }));
    await finished();
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['pending director input']);
  } finally { release?.(); }
});

it.each(['reply', 'summary', 'failure'] as const)('keeps the human proposal through a director %s and continues the same conversation', async (outcome) => {
  const human = await open();
  const director = await openDirector();
  const before = store.read(record.id, record.assignment)!;
  if (outcome === 'failure') execute.mockRejectedValueOnce(new Error('director provider failed'));
  else execute.mockResolvedValueOnce({ message: 'director reply', summary: outcome === 'summary'
    ? { ...record.pending!.summary, objective: 'director must not replace this proposal', repositoryDirectory: repository } : null,
    sessionId: 'director-session', assignment: record.assignment });
  const accepted = await tell(director, 'director interruption');
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
  await vi.waitFor(() => expect(outputs.some((output) => output.kind === 'result' && output.operationId === accepted.operationId)).toBe(true));
  expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 4, pending: before.pending, approval: before.approval, running: null });
  expect(await submit(human.attachmentId, { kind: 'message', text: 'continue human consultation' })).toMatchObject({ kind: 'accepted' });
  await finished();
  expect(JSON.parse(execute.mock.calls[1]![0].recovery!.context).pending).toEqual(before.pending);
  const speakers = [];
  for await (const value of new ConversationSpeakerStore(directory).iterate(record.id)) speakers.push(value);
  expect(speakers).toEqual(expect.arrayContaining([
    expect.objectContaining({ operationId: accepted.operationId, actor: directorActor }),
    expect.objectContaining({ operationId: lastOperationId, actor: record.counterpart }),
  ]));
});

it('invalidates an aborted director session while retaining the human proposal for the next human turn', async () => {
  const human = await open();
  const director = await openDirector();
  const release = holdNextTurn();
  try {
    const accepted = await tell(director, 'director turn to abort');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(await submit(human.attachmentId, { kind: 'abort_turn', operationId: accepted.operationId })).toEqual(accepted);
    release();
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
      result: expect.objectContaining({ kind: 'error', code: 'interrupted', message: expect.stringContaining(accepted.operationId) }) }));
    await finished();
    expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 4, pending: record.pending, sessionId: null });
    expect((await submit(human.attachmentId, { kind: 'message', text: 'continue after interruption' })).kind).toBe('accepted');
    await finished();
    expect(execute.mock.calls[1]![0].sessionId).toBeUndefined();
    expect(JSON.parse(execute.mock.calls[1]![0].recovery!.context).pending).toEqual(record.pending);
  } finally { release(); }
});

it('refuses a failed director queue save and never runs that input after storage recovers', async () => {
  const director = await openDirector();
  const human = await open();
  const release = holdNextTurn();
  try {
    await submit(human.attachmentId, { kind: 'message', text: 'held turn' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const original = store.read(record.id, record.assignment);
    const write = ConversationStore.prototype.write;
    const failing = vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
      if (JSON.stringify(value).includes('unsaved director input')) throw new Error('queue storage failed');
      return write.call(this, value);
    });
    expect(await tell(director, 'unsaved director input')).toMatchObject({ kind: 'error', code: 'storage_error' });
    expect(store.read(record.id, record.assignment)).toEqual(original);
    failing.mockRestore();
    release(); await finished();
    const read = await service.snapshot(human.attachmentId); read.cancel();
    expect(await tell(director, 'saved after recovery')).toMatchObject({ kind: 'accepted' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await finished();
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['held turn', 'saved after recovery']);
  } finally { release(); }
});

it('reports a speaker storage failure after director acceptance without discarding the human proposal', async () => {
  const director = await openDirector();
  const before = store.read(record.id, record.assignment)!;
  vi.spyOn(ConversationSpeakerStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('speaker storage failed'); });
  const accepted = await tell(director, 'accepted before speaker storage');
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Saved director message must be accepted');
  await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
    result: expect.objectContaining({ kind: 'error', code: 'storage_error' }) }));
  expect(execute).not.toHaveBeenCalled();
  expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 4, pending: before.pending,
    approval: before.approval, running: null });
});

it.each([false, true])('interrupts a started director operation when shutdown arrives during assignment preparation (validation fails=%s)', async (validationFails) => {
  const director = await openDirector();
  let release!: () => void;
  let preparing = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  doubles.assignment.mockResolvedValueOnce(assignment).mockImplementationOnce(async () => {
    preparing = true;
    await gate;
    if (validationFails) throw new Error('Assignment became unavailable');
    return assignment;
  });
  try {
    const accepted = await tell(director, 'stop during preparation');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('Director input must be accepted');
    await vi.waitFor(() => expect(preparing).toBe(true), { timeout: 5000 });
    expect(store.read(record.id, record.assignment)?.running?.operationId).toBe(accepted.operationId);
    service.stopAccepting();
    const closing = service.close();
    release();
    await closing;
    expect(execute).not.toHaveBeenCalled();
    expect(new DirectorMessageResultStore(directory).read(accepted.operationId)?.result).toMatchObject({ kind: 'error', code: 'interrupted' });
    expect(store.read(record.id, record.assignment)).toMatchObject({ running: null, directorMessages: [], revision: 4, pending: record.pending });
  } finally { release(); }
});

it.each(['result', 'record'] as const)('retains ownership of a rejected director input through a failed terminal %s save without executing it on recovery', async (failure) => {
  const director = await openDirector();
  doubles.assignment.mockResolvedValueOnce(assignment).mockRejectedValueOnce(new Error('Assignment is unavailable'));
  let fail = true;
  let failures = 0;
  if (failure === 'record') {
    const write = ConversationStore.prototype.write;
    vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
      if (fail && value.running === null && value.directorMessages?.length === 0) {
        failures++;
        throw new Error('Cannot save terminal record');
      }
      write.call(this, value);
    });
  } else {
    const write = DirectorMessageResultStore.prototype.write;
    vi.spyOn(DirectorMessageResultStore.prototype, 'write').mockImplementation(function (this: DirectorMessageResultStore, value) {
      if (fail) { failures++; throw new Error('Cannot save terminal result'); }
      write.call(this, value);
    });
  }
  const accepted = await tell(director, 'must not execute after rejection');
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Director input must first be saved');
  await vi.waitFor(() => expect(failures).toBeGreaterThan(0), { timeout: 5000 });
  const saved = store.read(record.id, record.assignment)!;
  const resultStore = new DirectorMessageResultStore(directory);
  expect(saved.running?.operationId === accepted.operationId
    || saved.directorMessages?.some((message) => message.operationId === accepted.operationId)
    || resultStore.read(accepted.operationId) !== undefined).toBe(true);
  fail = false;
  doubles.assignment.mockResolvedValue(assignment);
  await service.maintain();
  await vi.waitFor(() => expect({ active: service.activeOperationCount, instructions: execute.mock.calls.map(([input]) => input.instruction) })
    .toEqual({ active: 0, instructions: [] }), { timeout: 5000 });
  expect(resultStore.read(accepted.operationId)?.result).toMatchObject({ kind: 'error', code: 'operation_failed' });
  expect(store.read(record.id, record.assignment)).toMatchObject({ running: null, directorMessages: [], revision: 4, pending: record.pending });
  expect(outputs.filter((output) => output.kind === 'result' && output.operationId === accepted.operationId)).toHaveLength(1);
});

it('retains the queued input when starting cannot be saved and retries storage before executing the provider', async () => {
  const director = await openDirector();
  const human = await open();
  const write = ConversationStore.prototype.write;
  let failedStarts = 0;
  const failing = vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    if (value.running?.directorConversationId !== undefined) {
      failedStarts++;
      throw new Error('Cannot persist the director start');
    }
    write.call(this, value);
  });
  const accepted = await tell(director, 'retain until start is saved');
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Director input must first be saved');
  await vi.waitFor(() => expect(failedStarts).toBe(1));
  expect(execute).not.toHaveBeenCalled();
  expect(store.read(record.id, record.assignment)).toMatchObject({ running: null, revision: 4, pending: record.pending,
    directorMessages: [{ operationId: accepted.operationId, text: 'retain until start is saved' }] });
  expect((await submit(human.attachmentId, { kind: 'message', text: 'must not overtake storage recovery' })).kind).not.toBe('accepted');
  failing.mockRestore();
  await service.maintain();
  await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
    result: { kind: 'reply', message: 'manager reply' } }));
  await finished();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('retain until start is saved');
});

it.each(['active', 'paused', 'aborted', 'created', 'wrong-pr'] as const)('checks merge authority and the latest goal state when a queued director request starts (%s)', async (state) => {
  const director = await openDirector();
  const human = await open();
  const goal = { ...goalRecord(), executionStatus: 'active' as const, status: 'awaiting_merge' as const,
    pullRequest: { number: 1950, url: 'https://github.invalid/pr/1950' }, completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } };
  const goals = new GoalStore(repository); await goals.create(goal);
  const merge = vi.spyOn(goalPrMerge, 'mergeGoalPr').mockResolvedValue({ success: true, prNumber: 1950, exitCode: 0, output: 'merged', truncated: false });
  const deps = { allowedProjectRoot: repository, managerConversation: { configDirectory: directory, assignment: record.assignment } };
  const invoke = (operationId: string) => mergeTaktGoalPr({ cwd: repository, goalId: goal.id,
    prNumber: state === 'wrong-pr' ? 1949 : 1950, conversationOperationId: operationId }, deps, new AbortController().signal);
  const release = holdNextTurn();
  try {
    const current = await submit(human.attachmentId, { kind: 'message', text: 'human holding merge authority' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const before = store.read(record.id, record.assignment)!;
    const accepted = await tell(director, 'merge goal PR #1950');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted' || current.kind !== 'accepted') throw new Error('Messages must be accepted');
    expect(store.read(record.id, record.assignment)).toMatchObject({ running: before.running, lastSpeaker: before.lastSpeaker,
      revision: before.revision, pending: before.pending });
    expect((await invoke(current.operationId)).isError).toBe(true);
    expect((await invoke(accepted.operationId)).isError).toBe(true);
    if (state === 'paused' || state === 'aborted') await goals.update(goal.id, (value) => ({ ...value, executionStatus: state }));
    if (state === 'created') await goals.update(goal.id, (value) => ({ ...value, status: 'created' }));
    execute.mockImplementationOnce(async (input) => {
      expect((await invoke(current.operationId)).isError).toBe(true);
      const result = await invoke(input.conversationOperationId!);
      expect(result.isError).toBe(state === 'active' ? undefined : true);
      if (state !== 'active') expect(JSON.stringify(result.content)).toContain({
        paused: 'Goal is paused', aborted: 'Goal is aborted', created: 'Goal is not awaiting a merge',
        'wrong-pr': 'PR number does not match the saved goal PR',
      }[state]);
      return { message: 'merge checked', summary: null, sessionId: 'merge-session', assignment: record.assignment };
    });
    release();
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
      result: { kind: 'reply', message: 'merge checked' } }));
    await finished();
    expect((await invoke(accepted.operationId)).isError).toBe(true);
    expect(merge).toHaveBeenCalledTimes(state === 'active' ? 1 : 0);
  } finally { release(); }
});

it('retains a saved director reply after restart between result persistence and clearing running', async () => {
  const director = await openDirector();
  const release = holdNextTurn();
  const resultStore = new DirectorMessageResultStore(directory);
  let failing: ReturnType<typeof vi.spyOn> | undefined;
  let firstId: string;
  try {
    const first = await tell(director, 'completed director operation');
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('Director message must be accepted');
    firstId = first.operationId;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect((await tell(director, 'next director operation')).kind).toBe('accepted');
    const write = ConversationStore.prototype.write;
    failing = vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
      if (value.running === null) throw new Error('terminal record unavailable');
      write.call(this, value);
    });
    release();
    await vi.waitFor(() => expect(resultStore.read(firstId)?.result).toEqual({ kind: 'reply', message: 'held reply' }));
    expect(store.read(record.id, record.assignment)?.running?.operationId).toBe(firstId);
  } finally { release(); failing?.mockRestore(); }
  await service.close();
  service = createConversationService({ configDirectory: directory, owner: { ...owner, identity: { startTime: 'daemon-C' } },
    runtime: { resolve: resolveRuntime, close: closeRuntime }, onDomainChange: vi.fn() });
  await service.restore();
  await vi.waitFor(() => expect(execute.mock.calls.map(([input]) => input.instruction))
    .toEqual(['completed director operation', 'next director operation']));
  await vi.waitFor(() => expect(store.read(record.id, record.assignment)?.running).toBeNull());
  expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['completed director operation', 'next director operation']);
  expect(new DirectorMessageResultStore(directory).read(firstId!)?.result).toEqual({ kind: 'reply', message: 'held reply' });
  expect(doubles.notification).not.toHaveBeenCalled();
  expect(store.read(record.id, record.assignment)).toMatchObject({ revision: 4, pending: record.pending });
});

it.each([false, true])('restores an already saved director reply with one notification and no interruption (notification already saved=%s)', async (notificationSaved) => {
  const operationId = randomUUID();
  const source = conversationId({ kind: 'daemon' });
  store.write({ ...record, lastSpeaker: directorActor,
    running: { operationId, kind: 'message', owner: { pid: owner.pid, identity: owner.identity }, directorConversationId: source } });
  const saved = { operationId, conversationId: record.id, directorConversationId: source,
    result: { kind: 'reply' as const, message: 'completed before stopping' } };
  new DirectorMessageResultStore(directory).write(saved);
  if (notificationSaved) {
    await service.restore();
    const notifications = await savedDirectorNotifications();
    expect(notifications).toHaveLength(1);
    await service.close();
    store.write({ ...record, lastSpeaker: directorActor,
      running: { operationId, kind: 'message', owner: { pid: owner.pid, identity: owner.identity }, directorConversationId: source } });
    service = createConversationService({ configDirectory: directory, owner,
      runtime: { resolve: resolveRuntime, close: closeRuntime }, onDomainChange: vi.fn() });
  }
  await service.restore();
  const opened = await open();
  expect(await state(opened.read)).toMatchObject({ running: null, interrupted: false, pending: record.pending });
  expect(new DirectorMessageResultStore(directory).read(operationId)).toEqual(saved);
  expect(execute).not.toHaveBeenCalled();
  expect(doubles.notification).not.toHaveBeenCalled();
  expect(await savedDirectorNotifications()).toEqual([{ id: expect.any(String), message: expect.stringContaining(operationId) }]);
  expect((await savedDirectorNotifications())[0]!.message).toContain(saved.result.message);
});

async function savedDirectorNotifications() {
  const notifications = [];
  for await (const notification of new DirectorNotificationStore(directory).iterate()) notifications.push(notification);
  return notifications;
}

describe('human interruption delivery during director notification recovery', () => {
  const webhookUrl = 'https://example.test/interrupted-manager';
  const fetchNotification = vi.fn<typeof fetch>();
  const source = conversationId({ kind: 'daemon' });
  const directorStorageError = new Error('Director notification storage unavailable');

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../features/manager/turnFailureNotification.js')>(
      '../features/manager/turnFailureNotification.js');
    doubles.notification.mockImplementation(actual.notifyManagerTurnFailure);
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', webhookUrl);
    fetchNotification.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchNotification);
    mkdirSync(join(repository, '.takt'), { recursive: true });
    writeFileSync(join(repository, '.takt', 'config.yaml'), 'language: en\nmanager:\n  notifications:\n    blocked: true\n');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function saveInterruptedConversation() {
    const operationId = randomUUID();
    const nextOperationId = randomUUID();
    const saved = { ...record, lastSpeaker: directorActor,
      running: { operationId, kind: 'message' as const, owner: { pid: owner.pid, identity: owner.identity }, directorConversationId: source },
      directorMessages: [{ operationId: nextOperationId, directorConversationId: source, speaker: directorActor, text: 'D2' }] };
    store.write(saved);
    return { operationId, nextOperationId, saved };
  }

  async function restoreThrough(entry: 'restore' | 'open') {
    if (entry === 'restore') await service.restore();
    else { const opened = await open(); opened.read.cancel(); }
  }

  async function restartService() {
    await service.close();
    service = createConversationService({ configDirectory: directory, owner,
      runtime: { resolve: resolveRuntime, close: closeRuntime }, onDomainChange: vi.fn() });
  }

  function failDirectorNotification() {
    return vi.spyOn(DirectorNotificationStore.prototype, 'create').mockImplementation(() => { throw directorStorageError; });
  }

  it.each([
    { entry: 'restore' as const, notificationFails: false }, { entry: 'restore' as const, notificationFails: true },
    { entry: 'open' as const, notificationFails: false }, { entry: 'open' as const, notificationFails: true },
  ])('delivers a new interruption through $entry and continues D2 after notification failure=$notificationFails', async ({ entry, notificationFails }) => {
    const { operationId, saved } = saveInterruptedConversation();
    const failing = notificationFails ? failDirectorNotification() : undefined;
    if (notificationFails) {
      await expect(restoreThrough(entry)).rejects.toBe(directorStorageError);
      expect(store.read(record.id, record.assignment)).toEqual(saved);
      expect(execute).not.toHaveBeenCalled();
      expect(await savedDirectorNotifications()).toEqual([]);
    } else await restoreThrough(entry);

    const interrupted = new DirectorMessageResultStore(directory).read(operationId);
    expect(interrupted).toMatchObject({ operationId, conversationId: record.id, directorConversationId: source,
      result: { kind: 'error', code: 'interrupted', message: expect.stringContaining(operationId) } });
    expect(fetchNotification).toHaveBeenCalledOnce();
    const [url, request] = fetchNotification.mock.calls[0]!;
    expect(url).toBe(webhookUrl);
    expect(request).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(String(request?.body)) as { text: string };
    expect(body.text).toContain(operationId);
    expect(body.text).toContain(interrupted!.result.message);

    if (notificationFails) {
      await restartService();
      await expect(service.restore()).rejects.toBe(directorStorageError);
      expect(store.read(record.id, record.assignment)).toEqual(saved);
      expect(execute).not.toHaveBeenCalled();
      expect(fetchNotification).toHaveBeenCalledOnce();
      failing!.mockRestore();
      await restartService();
      await service.restore();
    }
    await vi.waitFor(() => expect(store.read(record.id, record.assignment)?.running).toBeNull());
    expect(execute.mock.calls.map(([input]) => input.instruction)).toEqual(['D2']);
    expect(new DirectorMessageResultStore(directory).read(operationId)).toEqual(interrupted);
    const director = await service.open({ conversationId: source, assignment: { kind: 'daemon' }, speaker: record.counterpart,
      binding: { port: 'tui', key: source, counterpart: record.counterpart }, agentOverrides: { provider: 'mock' } }, delivery);
    const messages: string[] = [];
    for await (const item of director.read.items) if (item.kind === 'display_event') messages.push(item.event.message);
    director.read.complete();
    const notices = messages.filter((message) => message.includes(operationId));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(interrupted!.result.message);
    expect(fetchNotification).toHaveBeenCalledOnce();
  });

  it.each(['restore', 'open'] as const)('does not notify when the interruption result cannot be saved through %s', async (entry) => {
    const { operationId, saved } = saveInterruptedConversation();
    const error = new Error('Result storage unavailable');
    vi.spyOn(DirectorMessageResultStore.prototype, 'write').mockImplementation(() => { throw error; });
    const create = failDirectorNotification();
    await expect(restoreThrough(entry)).rejects.toBe(error);
    expect(new DirectorMessageResultStore(directory).read(operationId)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(fetchNotification).not.toHaveBeenCalled();
    expect(store.read(record.id, record.assignment)).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'reply' as const, message: 'Saved reply' },
    { kind: 'error' as const, code: 'operation_failed', message: 'Saved failure' },
    { kind: 'error' as const, code: 'interrupted', message: 'Saved interruption' },
  ])('does not notify again for a saved $message when director notification storage fails', async (result) => {
    const { operationId, saved } = saveInterruptedConversation();
    const persisted = { operationId, conversationId: record.id, directorConversationId: source, result };
    const results = new DirectorMessageResultStore(directory);
    results.write(persisted);
    failDirectorNotification();
    await expect(service.restore()).rejects.toBe(directorStorageError);
    expect(results.read(operationId)).toEqual(persisted);
    expect(fetchNotification).not.toHaveBeenCalled();
    expect(store.read(record.id, record.assignment)).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it('honors disabled blocked notifications while retaining the director storage failure', async () => {
    const { saved } = saveInterruptedConversation();
    writeFileSync(join(repository, '.takt', 'config.yaml'), 'language: en\nmanager:\n  notifications:\n    blocked: false\n');
    failDirectorNotification();
    await expect(service.restore()).rejects.toBe(directorStorageError);
    expect(fetchNotification).not.toHaveBeenCalled();
    expect(store.read(record.id, record.assignment)).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the director storage failure when the human webhook delivery fails', async () => {
    const { saved } = saveInterruptedConversation();
    fetchNotification.mockRejectedValueOnce(new Error('Webhook unavailable'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    failDirectorNotification();
    await expect(service.restore()).rejects.toBe(directorStorageError);
    expect(fetchNotification).toHaveBeenCalledOnce();
    expect(store.read(record.id, record.assignment)).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not notify before the recovered running state can be saved', async () => {
    const { operationId, saved } = saveInterruptedConversation();
    vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(() => { throw new Error('Conversation storage unavailable'); });
    await expect(service.restore()).rejects.toMatchObject({ code: 'storage_error' });
    expect(new DirectorMessageResultStore(directory).read(operationId)?.result).toMatchObject({ code: 'interrupted' });
    expect(await savedDirectorNotifications()).toHaveLength(1);
    expect(fetchNotification).not.toHaveBeenCalled();
    expect(store.read(record.id, record.assignment)).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });
});

it('keeps separate notifications for distinct director operations returning identical replies', async () => {
  const director = await openDirector();
  const operationIds: string[] = [];
  for (const text of ['first instruction', 'second instruction']) {
    const accepted = await tell(director, text);
    if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
    operationIds.push(accepted.operationId);
    await vi.waitFor(() => expect(outputs).toContainEqual({ kind: 'result', operationId: accepted.operationId,
      result: { kind: 'reply', message: 'manager reply' } }));
  }
  const notifications = await savedDirectorNotifications();
  expect(notifications).toHaveLength(2);
  for (const operationId of operationIds) {
    expect(notifications.filter((notification) => notification.message.includes(operationId)))
      .toEqual([{ id: expect.any(String), message: expect.stringContaining('manager reply') }]);
  }
});

it.each(['notification', 'record'] as const)('recovers the director notification after a failed %s save without rerunning the provider', async (failure) => {
  const director = await openDirector();
  const release = holdNextTurn();
  let fail = false;
  let failures = 0;
  const create: (this: DirectorNotificationStore, message: string, subject?: DirectorNotificationSubject) => DirectorNotification | undefined
    = DirectorNotificationStore.prototype.create;
  vi.spyOn(DirectorNotificationStore.prototype, 'create').mockImplementation(function (this: DirectorNotificationStore, message, subject?) {
    if (failure === 'notification' && fail) { failures++; throw new Error('notification unavailable'); }
    return subject === undefined ? create.call(this, message) : create.call(this, message, subject);
  });
  const write = ConversationStore.prototype.write;
  vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
    if (failure === 'record' && fail && value.id === record.id && value.running === null) {
      failures++; throw new Error('terminal record unavailable');
    }
    write.call(this, value);
  });
  try {
    const accepted = await tell(director, 'complete once despite storage failure');
    if (accepted.kind !== 'accepted') throw new Error('Director message must be accepted');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    fail = true;
    release();
    await vi.waitFor(() => expect(failures).toBeGreaterThan(0));
    expect(new DirectorMessageResultStore(directory).read(accepted.operationId)?.result).toEqual({ kind: 'reply', message: 'held reply' });
    expect(store.read(record.id, record.assignment)?.running?.operationId).toBe(accepted.operationId);
    expect(await savedDirectorNotifications()).toHaveLength(failure === 'notification' ? 0 : 1);
    expect(outputs.filter((output) => output.kind === 'result' && output.operationId === accepted.operationId)).toEqual([]);
    fail = false;
    await service.maintain();
    await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
    await service.maintain();
    expect(await savedDirectorNotifications()).toEqual([{ id: expect.any(String), message: expect.stringContaining(accepted.operationId) }]);
    expect((await savedDirectorNotifications())[0]!.message).toContain('held reply');
    expect(store.read(record.id, record.assignment)?.running).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  } finally { fail = false; release(); }
});
