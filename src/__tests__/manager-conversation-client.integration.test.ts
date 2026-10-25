import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { ManagerView } from '../features/manager/ManagerView.js';
import * as selectionDialog from '../features/manager/ManagerSelectionDialog.js';
import * as summaryDialog from '../features/manager/ManagerSummaryDialog.js';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import * as frames from '../features/daemon/conversationFrames.js';
import * as goalService from '../infra/goals/service.js';
import type { SnapshotRead } from '../features/manager/conversationPort.js';
import { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import { createConversationService } from '../features/manager/conversationService.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { askTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalStore } from '../infra/goals/store.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import type { Goal } from '../infra/goals/schema.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { getLabel } from '../shared/i18n/index.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), resolve: vi.fn(), ensure: vi.fn(), plan: vi.fn() }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.ensure }));
vi.mock('../infra/daemon/owner.js', async (original) => ({ ...await original<typeof import('../infra/daemon/owner.js')>(), isDaemonOwnerRunning: () => true }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path }));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({ ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (path: string) => path }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));

let directory: string;
let repository: string;
let assignment: ManagerAssignment;
let server: Awaited<ReturnType<typeof createConversationIpcServer>>;
let service: ReturnType<typeof createConversationService>;
let client: ConversationIpcClient;
const owner = { pid: process.pid, identity: { startTime: 'client-integration-owner' }, version: 'test', cliPath: '/test/cli.js' };
const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment }));
function saveGoal(goal: Goal) {
  const path = join(repository, '.takt', 'goals', goal.id);
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'goal.json'), JSON.stringify(goal));
}
beforeEach(async () => {
  vi.clearAllMocks();
  doubles.plan.mockReturnValue({ ctx: { providerType: 'mock' } });
  directory = getGlobalConfigDir(); repository = join(directory, 'repository'); mkdirSync(repository, { recursive: true });
  assignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  doubles.assignment.mockResolvedValue(assignment);
  const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
  const record = conversationRecord(repository); record.bindings = [selected.binding];
  new ConversationStore(directory).write(record);
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } });
  service = createConversationService({ configDirectory: directory, owner, onDomainChange: vi.fn(), runtime: { resolve: doubles.resolve, close: async () => {} } });
  writeDaemonOwner(directory, owner);
  server = await createConversationIpcServer(directory, owner, service);
  client = new ConversationIpcClient(assignment, { provider: 'mock', model: 'chosen-model' });
});
afterEach(async () => { cleanup(); client.close(); await service.close(); await server.close(); vi.restoreAllMocks(); });
async function complete() { await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('complete')); }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function heldRead(read: SnapshotRead, entered: ReturnType<typeof gate>, released: ReturnType<typeof gate>): SnapshotRead {
  return { ...read, items: (async function* () {
    for await (const item of read.items) {
      yield item;
      if (item.kind === 'state') { entered.release(); await released.promise; }
    }
  })() };
}

it.each(['response', 'transfer'] as const)('approves the displayed proposal once while a background %s is held', async (phase) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  await client.connect(); await complete();
  const entered = gate(); const released = gate();
  const snapshot = service.snapshot.bind(service);
  vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
    const read = await snapshot(id);
    if (phase === 'transfer') return heldRead(read, entered, released);
    entered.release(); await released.promise; return read;
  });
  const registration = vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async ({ id, objective, outOfScope, acceptanceCriteria, constraints }) => {
    const goal = { ...goalRecord(), id, objective, outOfScope, acceptanceCriteria, constraints }; saveGoal(goal); return goal;
  });
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summaryHint', 'en')));
  const submissions = vi.spyOn(client, 'submit');
  const refreshing = client.refresh();
  try {
    await entered.promise;
    await vi.waitFor(() => expect(service.snapshot).toHaveBeenCalled());
    expect.soft(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect.soft(app.lastFrame()).toContain(getLabel('manager.summaryHint', 'en'));
    app.stdin.write('\x0f');
    await vi.waitFor(() => expect(submissions).toHaveBeenCalledExactlyOnceWith({ kind: 'approve_summary', revision: 4 }, undefined));
    expect(connection.mock.calls.filter(([bytes]) => String(bytes).includes('"kind":"approve_summary"'))).toHaveLength(1);
    // The server finishes the current input batch before accepting another one.
    if (phase === 'response') released.release();
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
    const record = conversationRecord(repository);
    await vi.waitFor(() => expect(new ConversationStore(directory).read(record.id, record.assignment)?.approval)
      .toMatchObject({ revision: 4, state: 'registered' }));
    expect(registration).toHaveBeenCalledOnce();
  } finally { released.release(); await refreshing.catch(() => {}); app.unmount(); }
});

it('does not send approval before the initial transfer ends and enables it on the same screen after completion', async () => {
  const entered = gate(); const released = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    const opened = await open(...args);
    return { ...opened, read: heldRead(opened.read, entered, released) };
  });
  await client.connect();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  const submissions = vi.spyOn(client, 'submit');
  try {
    await entered.promise;
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('CSV出力');
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
    });
    app.stdin.write('\x0f');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain(getLabel('manager.summaryHint', 'en'));
    released.release(); await complete();
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summaryHint', 'en')));
    app.stdin.write('\x0f');
    await vi.waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    expect(submissions.mock.calls[0]![0]).toEqual({ kind: 'approve_summary', revision: 4 });
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
  } finally { released.release(); app.unmount(); }
});

it.each(['read failure', 'disconnect'] as const)('blocks approval after a background %s until a fresh transfer completes on the same screen', async (failure) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  await client.connect(); await complete();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summaryHint', 'en')));
  const submissions = vi.spyOn(client, 'submit');
  const entered = gate(); const released = gate();
  let refreshing: Promise<void> | undefined;
  try {
    if (failure === 'read failure') {
      const goal = goalRecord(); saveGoal(goal);
      writeFileSync(join(repository, '.takt', 'goals', goal.id, 'goal.json'), '{broken');
      await Promise.allSettled([client.refresh()]);
      await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
      saveGoal(goal);
      const snapshot = service.snapshot.bind(service);
      vi.spyOn(service, 'snapshot').mockImplementation(async (id) => heldRead(await snapshot(id), entered, released));
      refreshing = client.refresh();
    } else {
      const open = service.open.bind(service);
      vi.spyOn(service, 'open').mockImplementation(async (...args) => {
        const opened = await open(...args);
        return { ...opened, read: heldRead(opened.read, entered, released) };
      });
      const index = connection.mock.calls.findIndex(([bytes]) => String(bytes).includes('"method":"open"'));
      (connection.mock.contexts[index] as net.Socket).destroy();
    }
    await entered.promise;
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
      expect(app.lastFrame()).toContain('CSV出力');
    });
    app.stdin.write('\x0f');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain(getLabel('manager.summaryHint', 'en'));
    released.release(); await refreshing; await complete();
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.summaryHint', 'en')));
    app.stdin.write('\x0f');
    await vi.waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    expect(submissions.mock.calls[0]![0]).toEqual({ kind: 'approve_summary', revision: 4 });
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
  } finally { released.release(); await refreshing?.catch(() => {}); app.unmount(); }
});

it.each([
  { kind: 'approve_summary', concurrent: false }, { kind: 'approve_summary', concurrent: true },
  { kind: 'dismiss_summary', concurrent: false }, { kind: 'dismiss_summary', concurrent: true },
] as const)('restores a complete latest proposal after stale $kind (concurrent refresh: $concurrent)', async ({ kind, concurrent }) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  const notifications = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation((input, delivery) => open(input, {
    deliver: async (...args) => { await notifications.promise; return delivery.deliver(...args); },
  }));
  const pending = { ...conversationRecord(repository).pending!, revision: 5,
    summary: { objective: 'Latest proposal five', outOfScope: [], acceptanceCriteria: ['Latest accepted'], constraints: [] } };
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: {
    execute: async () => ({ message: 'updated', summary: pending.summary, sessionId: 'session', assignment }),
  } });
  const registration = vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async ({ id }) => {
    const goal = { ...goalRecord(), ...pending.summary, id }; saveGoal(goal); return goal;
  });
  const trace: Array<{ kind: string; transferId?: string; requestId?: string }> = [];
  const write = frames.writeConversationFrame;
  vi.spyOn(frames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const frame = value as { type: string; requestId?: string; result?: { read?: { transferId: string } }; output?: { kind: string; transferId: string } };
    trace.push({ kind: frame.output?.kind ?? frame.type, requestId: frame.requestId,
      transferId: frame.output?.transferId ?? frame.result?.read?.transferId });
    return write(socket, value);
  });
  const transferFrames = frames.conversationTransferFrames;
  vi.spyOn(frames, 'conversationTransferFrames').mockImplementation((id, metadata, ...args) => {
    const iterator = transferFrames(id, metadata, ...args);
    const stop = iterator.return.bind(iterator);
    iterator.return = (value) => { trace.push({ kind: 'cancel', transferId: metadata.transferId }); return stop(value); };
    return iterator;
  });
  const reads: Array<{ read: SnapshotRead; release(): void }> = [];
  const snapshot = service.snapshot.bind(service);
  let app: ReturnType<typeof render> | undefined;
  try {
    await client.connect(); await complete();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('CSV出力'));
    // この競合は明示 refresh だけを入力とし、定期 refresh は停止して比較する。
    for (const [index, [, milliseconds]] of intervals.mock.calls.entries()) {
      if (milliseconds === 500) clearInterval(intervals.mock.results[index]!.value as ReturnType<typeof setInterval>);
    }
    const selected = await createTuiConversationPort(directory, { deliver: async () => ({ kind: 'delivered' }) }).resolve(assignment);
    const other = await open(selected, { deliver: async () => ({ kind: 'delivered' }) });
    await other.read.items[Symbol.asyncIterator]().return?.();
    await service.submit({ attachmentId: other.attachmentId, requestId: randomUUID(), speaker: selected.speaker,
      command: { kind: 'message', text: 'Produce the next proposal' } });
    const store = new ConversationStore(directory);
    await vi.waitFor(() => expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending, running: null }));
    expect(client.getSnapshot().state?.pending?.revision).toBe(4);
    vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
      const read = await snapshot(id); const wait = gate(); reads.push({ read, release: wait.release });
      await wait.promise; trace.push({ kind: 'snapshot_resolved', transferId: read.transferId }); return read;
    });
    const openWrite = connection.mock.calls.findIndex(([bytes]) => String(bytes).includes('"method":"open"'));
    const socket = connection.mock.contexts[openWrite] as net.Socket;
    const submissions = vi.spyOn(client, 'submit');
    if (concurrent) socket.cork();
    app.stdin.write(kind === 'approve_summary' ? '\x0f' : '\x1b[27u');
    await vi.waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    let refreshed: Promise<void> | undefined;
    if (concurrent) { refreshed = client.refresh(); socket.uncork(); }
    const stale = await submissions.mock.results[0]!.value;
    expect(stale).toMatchObject({ kind: 'error', code: 'stale_summary' });
    refreshed ??= client.refresh();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending, approval: null, running: null });
    expect(registration).not.toHaveBeenCalled();
    reads[0]!.release();
    await refreshed;
    await complete();
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(pending.summary.objective));
    expect(client.getSnapshot().state?.pending).toEqual(pending);
    const transferId = reads[0]!.read.transferId;
    const transfer = trace.filter((entry) => entry.transferId === transferId).map(({ kind }) => kind);
    expect(transfer.indexOf('response')).toBeGreaterThanOrEqual(0);
    expect(transfer.indexOf('response')).toBeLessThan(transfer.indexOf('transfer_start'));
    expect(transfer.indexOf('transfer_start')).toBeLessThan(transfer.indexOf('transfer_end'));
    expect(transfer).not.toContain('cancel');
    expect(submissions.mock.calls.map(([command]) => command)).toEqual([{ kind, revision: 4 }]);
    expect(store.read(selected.conversationId, selected.assignment)?.approval).toBeNull();
    expect(registration).not.toHaveBeenCalled();
    expect((await new GoalStore(repository).list()).goals).toEqual([]);
    app.stdin.write(kind === 'approve_summary' ? '\x0f' : '\x1b[27u');
    await vi.waitFor(() => expect(submissions).toHaveBeenCalledTimes(2));
    expect(submissions.mock.calls[1]![0]).toEqual({ kind, revision: 5 });
    expect(await submissions.mock.results[1]!.value).toMatchObject({ kind: 'accepted' });
    await vi.waitFor(() => expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending: null, running: null }));
    if (kind === 'approve_summary') {
      const receipt = store.read(selected.conversationId, selected.assignment)!.approval!;
      expect(receipt).toMatchObject({ revision: 5, state: 'registered' });
      expect((await new GoalStore(repository).get(receipt.goalId)).objective).toBe(pending.summary.objective);
      expect(registration).toHaveBeenCalledOnce();
    } else {
      expect(store.read(selected.conversationId, selected.assignment)?.approval).toBeNull();
      expect((await new GoalStore(repository).list()).goals).toEqual([]);
      expect(registration).not.toHaveBeenCalled();
    }
  } finally {
    app?.unmount();
    for (const read of reads) read.release();
    notifications.release();
  }
});
async function displayedSelection(key: string, kind: 'answer' | 'goal' | 'notice') {
  const component = vi.spyOn(selectionDialog, 'ManagerSelectionDialog');
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment,
    initialDiagnostics: [], onExit() {} }));
  app.stdin.write(key);
  await vi.waitFor(() => expect(component.mock.calls.some(([props]) => props.selection.kind === kind)).toBe(true));
  return { selection: [...component.mock.calls].reverse().find(([props]) => props.selection.kind === kind)![0].selection,
    frame: () => app.lastFrame() };
}

it('re-resolves an invalidated repository attachment into its new workspace without replaying a rejected mutation', async () => {
  await client.connect(); await complete();
  const original = client.getSnapshot().state!.conversationId;
  assignment = { kind: 'workspace', workspaceId: randomUUID(), name: 'Promoted workspace', repositoryDirectories: [repository] };
  doubles.assignment.mockResolvedValue(assignment);
  const rejected = await client.submit({ kind: 'message', text: 'Do not replay this request' });
  expect(rejected).toMatchObject({ kind: 'error', code: 'invalid_assignment' });
  await complete();
  expect(client.getSnapshot().state?.conversationId).not.toBe(original);
  expect(client.getSnapshot().state?.assignment).toEqual({ kind: 'workspace', workspaceId: assignment.workspaceId });
  expect(client.getSnapshot().items).toContainEqual({ kind: 'assignment', assignment });
  expect(execute).not.toHaveBeenCalled();
  expect(service.attachmentCount).toBe(1);
});

it('retains the corrupt-record diagnostic and incomplete status until a repaired read completes on the same client', async () => {
  const goal = goalRecord();
  saveGoal(goal);
  const file = join(repository, '.takt', 'goals', goal.id, 'goal.json');
  writeFileSync(file, '{broken');
  await client.connect();
  await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
  expect(client.getSnapshot().connection).toBe('connected');
  expect(client.getSnapshot().state?.pending?.revision).toBe(4);
  expect(client.getSnapshot().items).toContainEqual({ kind: 'display_event', event: expect.objectContaining({
    message: expect.stringContaining(file),
  }) });
  saveGoal(goal);
  await client.refresh(); await complete();
  expect(client.getSnapshot().items.filter((item) => item.kind === 'goal')).toEqual([
    { kind: 'goal', goal: { id: goal.id, objective: goal.objective, status: goal.status,
      executionStatus: goal.executionStatus, repositoryDirectory: repository } },
  ]);
  expect(client.getSnapshot().items.some((item) => item.kind === 'display_event' && item.event.message.includes(file))).toBe(false);
});

it.each([7, 9])('restores every pending constraint for %i large entries through the production receiver', async (count) => {
  const record = conversationRecord(repository);
  record.pending!.summary.constraints = Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a'));
  new ConversationStore(directory).write(record);
  await client.connect(); await complete();
  expect(client.getSnapshot().state).toMatchObject({ conversationId: record.id, revision: 4, pending: record.pending });
  const component = vi.spyOn(summaryDialog, 'ManagerSummaryDialog');
  render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await vi.waitFor(() => expect(component).toHaveBeenCalled());
  expect(component.mock.calls.at(-1)![0].pending).toEqual(record.pending);
});

it.each([7, 9])('restores the exact IDs, order and objectives of %i large goals without list reads', async (count) => {
  const goals = Array.from({ length: count }, (_, index) => ({ ...goalRecord(),
    id: String(index + 1).padStart(8, '0') + '-1111-4111-8111-111111111111', objective: String(index).padEnd(128 * 1024, 'a') }));
  for (const goal of [...goals].reverse()) saveGoal(goal);
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('Array reads forbidden'));
  await client.connect(); await complete();
  expect(client.getSnapshot().items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []))
    .toEqual(goals.map(({ id, objective, status, executionStatus }) => ({ id, objective, status, executionStatus, repositoryDirectory: repository })));
  expect(list).not.toHaveBeenCalled();
  const { selection } = await displayedSelection('\x07', 'goal');
  if (selection.kind !== 'goal') throw new Error('Expected goal selection');
  expect(selection.candidates).toEqual(goals.map(({ id, objective, status, executionStatus }) => ({
    id, objective, status, executionStatus, repositoryDirectory: repository,
  })));
});

it.each([7, 9])('restores every option created by the real question operation for %i large options', async (count) => {
  const goal = goalRecord(); saveGoal(goal);
  const options = Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a'));
  const producer = await askTaktGoalQuestion({ cwd: repository, goalId: goal.id, body: 'Choose', options }, {}, new AbortController().signal);
  expect(producer.isError).not.toBe(true);
  const saved = (await new GoalStore(repository).get(goal.id)).questions![0]!;
  await client.connect(); await complete();
  expect(client.getSnapshot().items.filter((item) => item.kind === 'inquiry')).toEqual([{ kind: 'inquiry', inquiry: {
    target: { goalId: goal.id, repositoryDirectory: repository }, question: saved, objective: goal.objective,
  } }]);
  const { selection } = await displayedSelection('\x12', 'answer');
  if (selection.kind !== 'answer') throw new Error('Expected inquiry selection');
  expect(selection.candidates).toEqual([{ goalId: goal.id, repositoryDirectory: repository, objective: goal.objective, question: saved }]);
});

it.each([7, 9])('restores the full notice projection for a body containing %i large blocks', async (count) => {
  const body = Array.from({ length: count }, (_, index) => String(index).padEnd(128 * 1024, 'a')).join('\n');
  const goal = { ...goalRecord(), notifications: [{ id: '650e8400-e29b-41d4-a716-446655440001', kind: 'custom' as const,
    body, recordedAt: '2026-10-24T00:00:00.000Z' }] };
  saveGoal(goal); await client.connect(); await complete();
  const notices = client.getSnapshot().items.flatMap((item) => item.kind === 'notice' ? [item.notice] : []);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ id: goal.notifications[0]!.id, repositoryDirectory: repository, goalId: goal.id, objective: goal.objective });
  expect(notices[0]!.message).toContain(body);
  const { selection } = await displayedSelection('\x0e', 'notice');
  if (selection.kind !== 'notice') throw new Error('Expected notice selection');
  expect(selection.candidates).toEqual(notices);
});

it('removes the same standalone approval after withdrawal and refresh on the same client', async () => {
  const inquiry = await saveManagerToolPermissionInquiry({ configDirectory: directory, owner: { kind: 'repository', repositoryDirectory: repository },
    request: { toolName: 'Bash', toolInput: { command: 'git status' }, cwd: repository }, reason: 'Please confirm the operation' });
  await client.connect(); await complete();
  const inquiries = () => client.getSnapshot().items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry] : []);
  expect(inquiries()).toEqual([{ target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: repository } }, question: inquiry }]);
  const { selection, frame } = await displayedSelection('\x12', 'answer');
  if (selection.kind !== 'answer') throw new Error('Expected inquiry selection');
  expect(selection.candidates).toEqual([{ goalId: null, owner: { kind: 'repository', repositoryDirectory: repository }, question: inquiry }]);
  await vi.waitFor(() => expect(frame()).toContain(inquiry.body));
  await new StandaloneInquiryStore(directory, assignment).withdraw(inquiry.id);
  await client.refresh();
  await vi.waitFor(() => expect(inquiries()).toEqual([]));
  await vi.waitFor(() => expect(frame()).not.toContain(inquiry.body));
});

it('forwards attachment overrides into the daemon runtime and delivers the completed operation result', async () => {
  const output = vi.fn(); client.onOutput(output);
  await client.connect(); await complete();
  const result = await client.submit({ kind: 'message', text: 'continue' });
  expect(result.kind).toBe('accepted');
  await vi.waitFor(() => expect(output).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'finished' } })));
  expect(doubles.resolve).toHaveBeenCalledWith(assignment, expect.any(AbortSignal), { provider: 'mock', model: 'chosen-model' });
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'continue' }));
  expect(client.getSnapshot().state).toMatchObject({ running: null, revision: 5 });
});

it('uses the explicit provider when opening even if the default provider plan is unavailable', async () => {
  doubles.plan.mockImplementation((_cwd: string, overrides: { provider?: string }) => {
    if (overrides.provider !== 'mock') throw new Error('Default provider plan is unavailable');
    return { ctx: { providerType: 'mock' } };
  });
  await client.connect(); await complete();
  expect(client.getSnapshot()).toMatchObject({ connection: 'connected', state: { conversationId: conversationRecord(repository).id } });
  expect(doubles.plan).toHaveBeenCalledExactlyOnceWith(repository, { provider: 'mock', model: 'chosen-model' });
});
