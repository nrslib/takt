import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { SnapshotItem, SnapshotRead } from '../features/manager/conversationPort.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import * as privateFiles from '../shared/utils/private-file.js';
import { answerInquiry, createInquiry } from '../infra/goals/inquiry.js';
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
vi.mock('node:net', async (original) => ({ ...await original<typeof import('node:net')>() }));
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
// 再接続待ち（500ms）と再読込を挟む待機があるため、既定の 1 秒では負荷時に足りない。
function waitFor<T>(callback: () => T | Promise<T>): Promise<T> { return vi.waitFor(callback, { timeout: 5_000 }); }
const execute = vi.fn(async (input: ManagerTurnInput) => ({ message: 'finished', summary: null, sessionId: 'session', assignment: input.assignment }));
function saveGoal(goal: Goal, goalRepository = repository) {
  const path = join(goalRepository, '.takt', 'goals', goal.id);
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
async function complete() { await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('complete'), { timeout: 10_000 }); }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function heldRead(read: SnapshotRead, entered: ReturnType<typeof gate>, released: ReturnType<typeof gate>): SnapshotRead {
  return { ...read, items: (async function* () {
    let held = false;
    for await (const item of read.items) {
      yield item;
      if (!held) { held = true; entered.release(); await released.promise; }
    }
    if (!held) { entered.release(); await released.promise; }
  })() };
}

function captureAndStopPolling() {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  return async () => {
    await vi.waitFor(() => expect(intervals.mock.calls.some(([, milliseconds]) => milliseconds === 500)).toBe(true));
    for (const [index, [, milliseconds]] of intervals.mock.calls.entries()) {
      if (milliseconds === 500) clearInterval(intervals.mock.results[index]!.value as ReturnType<typeof setInterval>);
    }
  };
}

it('regenerates with /make-goal on the same screen and registers the new proposal only with Up and Enter', async () => {
  const summary = { objective: 'Replacement JSON export', outOfScope: ['CSV'], acceptanceCriteria: ['JSON exists'], constraints: [] };
  const generate = vi.fn(async () => ({ message: 'Replacement ready', summary, sessionId: 'session', assignment }));
  doubles.resolve.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute: generate } });
  const registration = vi.spyOn(goalService, 'registerReservedGoal');
  await client.connect(); await complete();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => expect(app.lastFrame()).toContain('CSV出力'));
  const submissions = vi.spyOn(client, 'submit');
  let draft = '';
  for (const character of '/make-goal') {
    draft += character;
    app.stdin.write(character);
    await waitFor(() => expect(app.lastFrame()).toContain('❯ ' + draft));
  }
  app.stdin.write('\r');
  await waitFor(() => expect(submissions.mock.calls.map(([command]) => command)).toEqual([
    { kind: 'message', text: getLabel('manager.goSummaryRequest', 'en') },
  ]));
  await waitFor(() => {
    expect(app.lastFrame()).toContain(summary.objective);
    expect(app.lastFrame()).not.toContain('CSV出力');
    expect(client.getSnapshot().state).toMatchObject({ pending: { revision: 5, summary }, approval: null, running: null });
  });
  const record = conversationRecord(repository);
  expect(new ConversationStore(directory).read(record.id, record.assignment)).toMatchObject({
    pending: { revision: 5, summary }, approval: null, running: null,
  });
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: getLabel('manager.goSummaryRequest', 'en') }));
  expect(registration).not.toHaveBeenCalled();
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  registration.mockImplementation(async ({ id, objective, outOfScope, acceptanceCriteria, constraints }) => {
    const goal = { ...goalRecord(), id, objective, outOfScope, acceptanceCriteria, constraints }; saveGoal(goal); return goal;
  });
  app.stdin.write('\x1b[A');
  app.stdin.write('\r');
  await waitFor(() => expect(new ConversationStore(directory).read(record.id, record.assignment)?.approval)
    .toMatchObject({ revision: 5, state: 'registered' }));
  const receipt = new ConversationStore(directory).read(record.id, record.assignment)!.approval!;
  expect((await new GoalStore(repository).get(receipt.goalId)).objective).toBe(summary.objective);
  expect(registration).toHaveBeenCalledOnce();
});

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
  await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()).toContain(getLabel('manager.summaryInputHint', 'en'));
  });
  const submissions = vi.spyOn(client, 'submit');
  const refreshing = client.refresh();
  try {
    await entered.promise;
    await waitFor(() => expect(service.snapshot).toHaveBeenCalled());
    expect.soft(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect.soft(app.lastFrame()).toContain(getLabel('manager.summaryInputHint', 'en'));
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledExactlyOnceWith({ kind: 'approve_summary', revision: 4 }, undefined));
    expect(connection.mock.calls.filter(([bytes]) => String(bytes).includes('"kind":"approve_summary"'))).toHaveLength(1);
    // The server finishes the current input batch before accepting another one.
    if (phase === 'response') released.release();
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
    const record = conversationRecord(repository);
    await waitFor(() => expect(new ConversationStore(directory).read(record.id, record.assignment)?.approval)
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
    await waitFor(() => {
      expect(app.lastFrame()).toContain('CSV出力');
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
    });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(client.getSnapshot().readStatus).not.toBe('complete');
    released.release(); await complete();
    await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()).toContain(getLabel('manager.summaryInputHint', 'en'));
  });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    expect(submissions.mock.calls[0]![0]).toEqual({ kind: 'approve_summary', revision: 4 });
    expect(await submissions.mock.results[0]!.value).toMatchObject({ kind: 'accepted' });
  } finally { released.release(); app.unmount(); }
});

it.each(['read failure', 'disconnect'] as const)('blocks approval after a background %s until a fresh transfer completes on the same screen', async (failure) => {
  const connection = vi.spyOn(net.Socket.prototype, 'write');
  await client.connect(); await complete();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment, initialDiagnostics: [], onExit() {} }));
  await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()).toContain(getLabel('manager.summaryInputHint', 'en'));
  });
  const submissions = vi.spyOn(client, 'submit');
  const entered = gate(); const released = gate();
  let refreshing: Promise<void> | undefined;
  try {
    if (failure === 'read failure') {
      const goal = goalRecord(); saveGoal(goal);
      writeFileSync(join(repository, '.takt', 'goals', goal.id, 'goal.json'), '{broken');
      await Promise.allSettled([client.refresh()]);
      await waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
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
    await waitFor(() => {
      expect(app.lastFrame()).toContain(getLabel('manager.conversation.reading', 'en'));
      expect(app.lastFrame()).toContain('CSV出力');
    });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(submissions).not.toHaveBeenCalled();
    expect(client.getSnapshot().readStatus).not.toBe('complete');
    released.release(); await refreshing; await complete();
    await waitFor(() => {
    expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' });
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
    expect(app.lastFrame()).toContain(getLabel('manager.summaryInputHint', 'en'));
  });
    app.stdin.write('\x1b[A');
    app.stdin.write('\r');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
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
    await waitFor(() => expect(app!.lastFrame()).toContain('CSV出力'));
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
    await waitFor(() => expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending, running: null }));
    expect(client.getSnapshot().state?.pending?.revision).toBe(4);
    vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
      const read = await snapshot(id); const wait = gate(); reads.push({ read, release: wait.release });
      await wait.promise; trace.push({ kind: 'snapshot_resolved', transferId: read.transferId }); return read;
    });
    const openWrite = connection.mock.calls.findIndex(([bytes]) => String(bytes).includes('"method":"open"'));
    const socket = connection.mock.contexts[openWrite] as net.Socket;
    const submissions = vi.spyOn(client, 'submit');
    if (concurrent) socket.cork();
    if (kind === 'approve_summary') { app.stdin.write('\x1b[A'); app.stdin.write('\r'); }
    else app.stdin.write('\x1b[27u');
    await waitFor(() => expect(submissions).toHaveBeenCalledOnce());
    let refreshed: Promise<void> | undefined;
    if (concurrent) { refreshed = client.refresh(); socket.uncork(); }
    const stale = await submissions.mock.results[0]!.value;
    expect(stale).toMatchObject({ kind: 'error', code: 'stale_summary' });
    refreshed ??= client.refresh();
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending, approval: null, running: null });
    expect(registration).not.toHaveBeenCalled();
    reads[0]!.release();
    await refreshed;
    await complete();
    await waitFor(() => expect(app!.lastFrame()).toContain(pending.summary.objective));
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
    if (kind === 'approve_summary') { app.stdin.write('\x1b[A'); app.stdin.write('\r'); }
    else app.stdin.write('\x1b[27u');
    await waitFor(() => expect(submissions).toHaveBeenCalledTimes(2));
    expect(submissions.mock.calls[1]![0]).toEqual({ kind, revision: 5 });
    expect(await submissions.mock.results[1]!.value).toMatchObject({ kind: 'accepted' });
    await waitFor(() => expect(store.read(selected.conversationId, selected.assignment)).toMatchObject({ pending: null, running: null }));
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
async function displayedSelection(key: string, kind: 'answer' | 'goal') {
  const stopPolling = captureAndStopPolling();
  const component = vi.spyOn(selectionDialog, 'ManagerSelectionDialog');
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment,
    initialDiagnostics: [], onExit() {} }));
  await stopPolling();
  let readCompleted = false;
  const unsubscribe = client.subscribe(() => {
    if (client.getSnapshot().readStatus === 'complete') readCompleted = true;
  });
  try {
    app.stdin.write(key);
    await waitFor(() => expect(component.mock.calls.some(([props]) => props.selection.kind === kind)).toBe(true));
    await waitFor(() => expect(readCompleted).toBe(true));
  } finally {
    unsubscribe();
    await stopPolling();
  }
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
  await waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
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
  await waitFor(() => expect(component).toHaveBeenCalled());
  expect(component.mock.calls.at(-1)![0].pending).toEqual(record.pending);
});

it.each([7, 9])('restores the exact IDs, order and objectives of %i large goals through the production receiver', async (count) => {
  const goals = Array.from({ length: count }, (_, index) => ({ ...goalRecord(),
    id: String(index + 1).padStart(8, '0') + '-1111-4111-8111-111111111111', objective: String(index).padEnd(128 * 1024, 'a') }));
  for (const goal of [...goals].reverse()) saveGoal(goal);
  await client.connect(); await complete();
  expect(client.getSnapshot().items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []))
    .toEqual(goals.map(({ id, objective, status, executionStatus }) => ({ id, objective, status, executionStatus, repositoryDirectory: repository })));
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

it('removes the same standalone approval after withdrawal and refresh on the same client', async () => {
  const connections = observeIpcConnections();
  const inquiry = await saveManagerToolPermissionInquiry({ configDirectory: directory, owner: { kind: 'repository', repositoryDirectory: repository },
    request: { toolName: 'Bash', toolInput: { command: 'git status' }, cwd: repository }, reason: 'Please confirm the operation' });
  await client.connect(); await complete();
  const inquiries = () => client.getSnapshot().items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry] : []);
  expect(inquiries()).toEqual([{ target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: repository } }, question: inquiry }]);
  const { selection, frame } = await displayedSelection('\x12', 'answer');
  if (selection.kind !== 'answer') throw new Error('Expected inquiry selection');
  expect(selection.candidates).toEqual([{ goalId: null, owner: { kind: 'repository', repositoryDirectory: repository }, question: inquiry }]);
  await waitFor(() => expect(frame()).toContain(inquiry.body));
  await vi.waitFor(() => expect(connections[0]!.snapshots.at(-1)!.complete).toBe(true), { timeout: 10_000 });
  await new StandaloneInquiryStore(directory, assignment).withdraw(inquiry.id);
  await refreshSnapshot(client, connections[0]!);
  expect(inquiries()).toEqual([]);
  await waitFor(() => expect(frame()).not.toContain(inquiry.body));
});

it('forwards attachment overrides into the daemon runtime and delivers the completed operation result', async () => {
  const output = vi.fn(); client.onOutput(output);
  await client.connect(); await complete();
  const result = await client.submit({ kind: 'message', text: 'continue' });
  expect(result.kind).toBe('accepted');
  await waitFor(() => expect(output).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: 'finished' } })));
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

interface ReceivedSnapshot {
  transferId: string;
  items: SnapshotItem[];
  complete: boolean;
}

function observeIpcConnections() {
  const connections: Array<{ socket: net.Socket; bytes: number; snapshots: ReceivedSnapshot[]; failures: number }> = [];
  const connect = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation((path, listener) => {
    const socket = connect(path, listener);
    const observation = { socket, bytes: 0, snapshots: [] as ReceivedSnapshot[], failures: 0 };
    connections.push(observation);
    const decoder = new frames.ConversationFrameDecoder();
    const fragments = new Map<string, Buffer[]>();
    socket.on('data', (chunk: Buffer) => {
      observation.bytes += chunk.length;
      for (const raw of decoder.decode(chunk)) {
        const envelope = raw as { type: string; output?: { kind: string; transferId: string; purpose?: string;
          itemIndex: number; finalFragment: boolean; data: string } };
        const output = envelope.output;
        if (envelope.type !== 'event' || output === undefined) continue;
        if (output.kind === 'transfer_start' && output.purpose === 'snapshot') {
          observation.snapshots.push({ transferId: output.transferId, items: [], complete: false });
        }
        const snapshot = observation.snapshots.find((read) => read.transferId === output.transferId);
        if (snapshot === undefined) continue;
        if (output.kind === 'transfer_data') {
          const key = JSON.stringify([output.transferId, output.itemIndex]);
          const parts = fragments.get(key) ?? [];
          parts.push(Buffer.from(output.data, 'base64'));
          if (output.finalFragment) {
            snapshot.items.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as SnapshotItem);
            fragments.delete(key);
          } else fragments.set(key, parts);
        } else if (output.kind === 'transfer_end') snapshot.complete = true;
        else if (output.kind === 'transfer_error') observation.failures++;
      }
    });
    return socket;
  });
  return connections;
}

type IpcObservation = ReturnType<typeof observeIpcConnections>[number];

async function refreshSnapshot(value: ConversationIpcClient, observation: IpcObservation) {
  const previous = observation.snapshots.length;
  await value.refresh();
  await vi.waitFor(() => {
    expect(observation.snapshots).toHaveLength(previous + 1);
    expect(observation.snapshots.at(-1)!.complete).toBe(true);
  }, { timeout: 10_000 });
  expect(value.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete', error: null });
  return observation.snapshots.at(-1)!;
}

function seedSnapshotGoals(count: number, recordsPerGoal: number, noticesPerGoal: number): Goal[] {
  const recordedAt = '2000-01-01T00:00:00.000Z';
  const goals: Goal[] = Array.from({ length: count }, (_, goalIndex) => ({
    ...goalRecord(), id: `${String(goalIndex + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    objective: `Snapshot goal ${goalIndex + 1}`,
    questions: [createInquiry({ body: `Snapshot question ${goalIndex + 1}`, options: ['CSV', 'JSON'] })],
    workLog: Array.from({ length: recordsPerGoal }, (_, index) => ({ id: randomUUID(), recordedAt,
      summary: `Historical work ${goalIndex}/${index} `.padEnd(1024, 'w') })),
    notifications: Array.from({ length: noticesPerGoal }, (_, index) => ({ id: randomUUID(), recordedAt,
      kind: 'custom', body: `Historical notice ${goalIndex}/${index} `.padEnd(1024, 'n') })),
  }));
  for (const goal of goals) saveGoal(goal);
  return goals;
}

function displayedGoals(value: ConversationIpcClient) {
  return value.getSnapshot().items.flatMap((item) => item.kind === 'goal' ? [item.goal] : []);
}

function displayedInquiries(value: ConversationIpcClient) {
  return value.getSnapshot().items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry] : []);
}

async function snapshotView() {
  const stopPolling = captureAndStopPolling();
  const app = render(createElement(ManagerView, { cwd: repository, lang: 'en', client, assignment,
    initialDiagnostics: [], onExit() {} }));
  await stopPolling();
  vi.spyOn(app.stdout, 'columns', 'get').mockReturnValue(80);
  app.stdout.emit('resize');
  await stopPolling();
  // バイト計測と差分の観測には明示 refresh だけを使う。
  return app;
}

async function openSnapshotMenu(app: ReturnType<typeof render>, kind: 'answer' | 'goal', observation: IpcObservation) {
  const previous = observation.snapshots.length;
  app.stdin.write(kind === 'answer' ? '\x12' : '\x07');
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel(`manager.selectionTitles.${kind}`, 'en'));
    expect(observation.snapshots).toHaveLength(previous + 1);
    expect(observation.snapshots.at(-1)!.complete).toBe(true);
  });
}

it('[SCN-SNAP-SIZE-P1] receives at most 4096 IPC bytes for an unchanged refresh and retains the displayed goals and inquiries', async () => {
  seedSnapshotGoals(30, 100, 10);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const observation = connections[0]!;
  const goals = displayedGoals(client);
  const inquiries = displayedInquiries(client);
  expect(goals).toHaveLength(30);
  expect(inquiries).toHaveLength(30);
  const app = await snapshotView();
  const headings = app.lastFrame()!.split('\n').slice(0, 2);
  const bytes = observation.bytes;

  const received = await refreshSnapshot(client, observation);

  console.info(`Unchanged snapshot IPC bytes: ${observation.bytes - bytes}`);
  expect.soft(observation.bytes - bytes).toBeGreaterThan(0);
  expect.soft(observation.bytes - bytes).toBeLessThanOrEqual(4096);
  expect.soft(received.items).toHaveLength(0);
  expect.soft(displayedGoals(client)).toEqual(goals);
  expect.soft(displayedInquiries(client)).toEqual(inquiries);
  await vi.waitFor(() => expect(app.lastFrame()!.split('\n').slice(0, 2)).toEqual(headings));
});

it('[SCN-SNAP-SIZE-P2] initially receives all thirty goals and pending inquiries without historical events or notice items', async () => {
  const goals = seedSnapshotGoals(30, 100, 10);
  const connections = observeIpcConnections();

  await client.connect(); await complete();

  const received = connections[0]!.snapshots[0]!;
  expect(received.complete).toBe(true);
  expect(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual(goals.map((goal) => goal.id));
  expect(received.items.flatMap((item) => item.kind === 'inquiry' ? [item.inquiry.question.id] : []))
    .toEqual(goals.map((goal) => goal.questions![0]!.id));
  expect(received.items.map((item) => item.kind).filter((kind) => !['state', 'assignment', 'goal', 'inquiry'].includes(kind))).toHaveLength(0);
  expect(displayedGoals(client)).toHaveLength(30);
  expect(displayedInquiries(client)).toHaveLength(30);
});

it('[SCN-SNAP-DELTA-P1] transfers only a newly appended work event and changed goal and displays the work exactly once', async () => {
  const [goal] = seedSnapshotGoals(2, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'New work after attachment' };
  saveGoal({ ...goal!, executionStatus: 'paused', workLog: [...goal!.workLog, record] });

  const received = await refreshSnapshot(client, connections[0]!);

  expect.soft(received.items.filter((item) => item.kind !== 'state')).toEqual([
    { kind: 'goal', goal: { id: goal!.id, objective: goal!.objective, status: goal!.status,
      executionStatus: 'paused', repositoryDirectory: repository } },
    { kind: 'display_event', event: { id: JSON.stringify([repository, goal!.id, 'work-log', record.id]), message: `${goal!.id}: ${record.summary}` } },
  ]);
  await vi.waitFor(() => expect(app.lastFrame()!.split(record.summary)).toHaveLength(2));
  await refreshSnapshot(client, connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()!.split(record.summary)).toHaveLength(2));
  expect(displayedGoals(client)).toHaveLength(2);
});

it('[SCN-SNAP-DELTA-P2] updates a paused goal and removes its answered inquiry while preserving other rows on the same screen', async () => {
  const [goal, other] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  await openSnapshotMenu(app, 'answer', connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Snapshot goal 1'));
  const unchangedGoal = displayedGoals(client).find((row) => row.id === other!.id);
  const unchangedInquiry = displayedInquiries(client).find((row) => row.target.goalId === other!.id);
  saveGoal({ ...goal!, executionStatus: 'paused', questions: [answerInquiry(goal!.questions![0]!, 'CSV')] });

  await refreshSnapshot(client, connections[0]!);

  expect(displayedGoals(client).find((row) => row.id === goal!.id)?.executionStatus).toBe('paused');
  expect(displayedGoals(client).find((row) => row.id === other!.id)).toEqual(unchangedGoal);
  expect(displayedInquiries(client)).toEqual([unchangedInquiry]);
  await vi.waitFor(() => {
    expect(app.lastFrame()).not.toContain('Snapshot goal 1');
    expect(app.lastFrame()).toContain('Snapshot goal 2');
    expect(app.lastFrame()).toContain(getLabel('manager.counts', 'en', { goals: '2', questions: '1' }));
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.answer', 'en')));
  app.stdin.write('\x07');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(`Snapshot goal 1 — ${getLabel('manager.goalStates.paused', 'en')}`));
});

it('[SCN-SNAP-RECONNECT-P1] reconnects the same client and screen with a complete latest list without replaying disconnected history', async () => {
  const [goal] = seedSnapshotGoals(1, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const entered = gate(); const released = gate();
  const open = service.open.bind(service);
  vi.spyOn(service, 'open').mockImplementation(async (...args) => {
    entered.release(); await released.promise; return open(...args);
  });
  const states: string[] = [];
  const unsubscribe = client.subscribe(() => states.push(client.getSnapshot().connection));
  connections[0]!.socket.destroy();
  try {
    await entered.promise;
    const duringDisconnect = { id: randomUUID(), recordedAt: new Date(Date.now() - 1).toISOString(), summary: 'Work while disconnected' };
    saveGoal({ ...goal!, workLog: [...goal!.workLog, duringDisconnect] });
    const added = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440000', objective: 'Added while disconnected' };
    saveGoal(added);
    released.release();
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ connection: 'connected', readStatus: 'complete' }), { timeout: 2000 });
    expect(states).toContain('disconnected');
    expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id, added.id]);
    const received = connections[1]!.snapshots[0]!;
    expect(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual([goal!.id, added.id]);
    expect.soft(received.items.map((item) => item.kind).filter((kind) => !['state', 'assignment', 'goal', 'inquiry'].includes(kind))).toEqual([]);
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.counts', 'en', { goals: '2', questions: '1' })));
    expect(app.lastFrame()).not.toContain(duringDisconnect.summary);
    app.stdin.write('\x07');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(added.objective));
  } finally { released.release(); unsubscribe(); }
});

it('keeps events for identical goals in different workspace repositories across delta reads', async () => {
  const secondRepository = join(directory, 'second-repository');
  mkdirSync(secondRepository, { recursive: true });
  assignment = { kind: 'workspace', workspaceId: randomUUID(), name: 'Workspace', repositoryDirectories: [repository, secondRepository] };
  doubles.assignment.mockResolvedValue(assignment);
  client.close();
  client = new ConversationIpcClient(assignment, { provider: 'mock' });
  const connections = observeIpcConnections();
  await client.connect(); await complete();

  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Shared work' };
  const notification = { id: randomUUID(), kind: 'progress' as const, body: 'Shared notice', recordedAt: record.recordedAt };
  const goal = { ...goalRecord(), workLog: [record], notifications: [notification] };
  saveGoal(goal, repository); saveGoal(goal, secondRepository);
  const received = await refreshSnapshot(client, connections[0]!);
  const events = received.items.flatMap((item) => item.kind === 'display_event' ? [item.event] : []);
  expect(received.complete).toBe(true);
  expect(events.map((event) => event.id).sort()).toEqual([repository, secondRepository].flatMap((path) => [
    JSON.stringify([path, goal.id, 'work-log', record.id]), JSON.stringify([path, goal.id, 'notification', notification.id]),
  ]).sort());
  expect(client.getSnapshot().items.filter((item) => item.kind === 'goal')).toHaveLength(2);
  expect(client.getSnapshot().items.filter((item) => item.kind === 'display_event')).toHaveLength(4);

  const unchanged = await refreshSnapshot(client, connections[0]!);
  expect(unchanged.items).toEqual([]);
  saveGoal({ ...goal, workLog: [] }, repository);
  const changed = await refreshSnapshot(client, connections[0]!);
  expect(changed.items).toContainEqual({ kind: 'remove', key: JSON.stringify(['display_event', JSON.stringify([repository, goal.id, 'work-log', record.id])]) });
  expect(client.getSnapshot().readStatus).toBe('complete');
  expect(client.getSnapshot().items.flatMap((item) => item.kind === 'display_event' ? [item.event.id] : []).sort())
    .toEqual(events.map((event) => event.id).filter((id) => id !== JSON.stringify([repository, goal.id, 'work-log', record.id])).sort());
});

it('[SCN-SNAP-MULTI-N1] delivers the same new work once to each attachment when the second client refreshes first', async () => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const second = new ConversationIpcClient(assignment, { provider: 'mock' });
  try {
    await second.connect();
    await vi.waitFor(() => expect(second.getSnapshot().readStatus).toBe('complete'));
    const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Work for both attachments' };
    saveGoal({ ...goal!, workLog: [record] });

    const fromSecond = await refreshSnapshot(second, connections[1]!);
    const fromFirst = await refreshSnapshot(client, connections[0]!);

    const expected = [{ id: JSON.stringify([repository, goal!.id, 'work-log', record.id]), message: `${goal!.id}: ${record.summary}` }];
    for (const received of [fromFirst, fromSecond]) {
      expect(received.items.flatMap((item) => item.kind === 'display_event' ? [item.event] : [])).toEqual(expected);
    }
    for (const [value, observation] of [[client, connections[0]!], [second, connections[1]!]] as const) {
      const unchanged = await refreshSnapshot(value, observation);
      expect.soft(unchanged.items).toEqual([]);
      expect(value.getSnapshot().items.flatMap((item) => item.kind === 'display_event' ? [item.event] : [])).toEqual(expected);
    }
  } finally { second.close(); }
});

it('[SCN-SNAP-UI-P1] preserves the width eighty headings and both menus and displays a new notification exactly once', async () => {
  const goals = seedSnapshotGoals(2, 1, 1);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const app = await snapshotView();
  const headings = [getLabel('manager.assignmentHeading', 'en', { name: 'repository' }),
    getLabel('manager.counts', 'en', { goals: '2', questions: '2' })];
  await vi.waitFor(() => expect(app.lastFrame()!.split('\n').slice(0, 2)).toEqual(headings));
  expect(app.lastFrame()).not.toMatch(/Historical (?:work|notice)/u);
  await openSnapshotMenu(app, 'answer', connections[0]!);
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en'));
    for (const goal of goals) expect(app.lastFrame()).toContain(goal.objective);
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.answer', 'en')));
  await openSnapshotMenu(app, 'goal', connections[0]!);
  await vi.waitFor(() => {
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en'));
    for (const goal of goals) expect(app.lastFrame()).toContain(`${goal.objective} — ${getLabel('manager.goalStates.active', 'en')}`);
  });
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.goal', 'en')));
  const notification = { id: randomUUID(), recordedAt: new Date().toISOString(), kind: 'custom' as const, body: 'New notification after attachment' };
  saveGoal({ ...goals[0]!, notifications: [...goals[0]!.notifications!, notification] });

  await refreshSnapshot(client, connections[0]!);

  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  await refreshSnapshot(client, connections[0]!);
  await vi.waitFor(() => expect(app.lastFrame()!.split(notification.body)).toHaveLength(2));
  expect(app.lastFrame()).toContain(headings.join('\n'));
  expect(app.lastFrame()).not.toMatch(/Historical (?:work|notice)/u);
});

it.each(['transfer_data', 'transfer_end'] as const)('releases the read and retries every uncommitted change after %s fails on the same attachment', async (failedKind) => {
  const [goal] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const previousInquiries = displayedInquiries(client);
  const record = { id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'Work retained after failed transfer' };
  const updated = { ...goal!, executionStatus: 'paused' as const,
    questions: [answerInquiry(goal!.questions![0]!, 'CSV')], workLog: [record] };
  saveGoal(updated);
  const released = vi.fn();
  const snapshot = service.snapshot.bind(service);
  vi.spyOn(service, 'snapshot').mockImplementation(async (id) => {
    const read = await snapshot(id);
    return { ...read, items: (async function* () {
      try { yield* read.items; }
      finally { released(); }
    })() };
  });
  const write = frames.writeConversationFrame;
  let failedTransfer: string | undefined;
  vi.spyOn(frames, 'writeConversationFrame').mockImplementation(async (socket, value) => {
    const envelope = value as { output?: { kind: string; transferId: string } };
    if (failedTransfer === undefined && envelope.output?.kind === failedKind) {
      failedTransfer = envelope.output.transferId;
      throw new Error('Snapshot write failed');
    }
    return write(socket, value);
  });

  await client.refresh();
  await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));
  expect(connections[0]!.failures).toBe(1);
  expect(released).toHaveBeenCalledOnce();
  expect(displayedInquiries(client)).toEqual(previousInquiries);
  const received = await refreshSnapshot(client, connections[0]!);

  expect(received.items).toContainEqual({ kind: 'goal', goal: { id: goal!.id, objective: goal!.objective, status: goal!.status,
    executionStatus: 'paused', repositoryDirectory: repository } });
  expect(received.items).toContainEqual({ kind: 'display_event', event: { id: JSON.stringify([repository, goal!.id, 'work-log', record.id]),
    message: `${goal!.id}: ${record.summary}` } });
  expect(displayedInquiries(client)).toEqual([previousInquiries[1]]);
  expect(displayedGoals(client)).toHaveLength(2);
  expect(released).toHaveBeenCalledTimes(2);
});

it('reuses unchanged goal files and reloads modified or deleted goals on the same attachment', async () => {
  const [goal, other] = seedSnapshotGoals(2, 0, 0);
  const connections = observeIpcConnections();
  const reads = vi.spyOn(privateFiles, 'readPrivateFileState');
  const goalReads = () => reads.mock.calls.map(([path]) => path).filter((path) => path.endsWith('/goal.json'));
  await client.connect(); await complete();
  expect(goalReads()).toHaveLength(2);
  reads.mockClear();

  await refreshSnapshot(client, connections[0]!);
  expect.soft(goalReads()).toEqual([]);
  reads.mockClear();
  saveGoal({ ...goal!, objective: 'Changed objective after initial snapshot' });
  await refreshSnapshot(client, connections[0]!);
  expect.soft(goalReads()).toEqual([join(repository, '.takt', 'goals', goal!.id, 'goal.json')]);
  expect(displayedGoals(client).find((row) => row.id === goal!.id)?.objective).toBe('Changed objective after initial snapshot');
  rmSync(join(repository, '.takt', 'goals', other!.id), { recursive: true });
  await refreshSnapshot(client, connections[0]!);
  expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id]);
});

it.each(['corruption', 'symlink'] as const)('reports %s after a successful read instead of hiding it behind cached goal data and recovers after repair', async (failure) => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const path = join(repository, '.takt', 'goals', goal!.id, 'goal.json');
  const saved = join(directory, 'saved-goal.json');
  if (failure === 'corruption') writeFileSync(path, '{broken');
  else {
    renameSync(path, saved);
    symlinkSync(saved, path);
  }

  await client.refresh();
  await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('incomplete'));

  expect(client.getSnapshot().connection).toBe('connected');
  expect(connections[0]!.failures).toBe(1);
  expect(displayedGoals(client).map((row) => row.id)).toEqual([goal!.id]);
  if (failure === 'symlink') rmSync(path);
  saveGoal({ ...goal!, objective: 'Repaired goal file' });
  await refreshSnapshot(client, connections[0]!);
  expect(displayedGoals(client).map((row) => row.objective)).toEqual(['Repaired goal file']);
});

it('applies multiple updates and removals to a thirty-goal list while retaining unrelated entries and their order', async () => {
  const goals = seedSnapshotGoals(30, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const previousGoals = displayedGoals(client);
  const previousInquiries = displayedInquiries(client);
  const changed = [goals[0]!, goals[14]!, goals[29]!];
  const removed = [goals[1]!, goals[15]!];
  for (const goal of changed) saveGoal({ ...goal, executionStatus: 'paused' });
  for (const goal of removed) rmSync(join(repository, '.takt', 'goals', goal.id), { recursive: true });

  const received = await refreshSnapshot(client, connections[0]!);

  expect.soft(received.items.flatMap((item) => item.kind === 'goal' ? [item.goal.id] : [])).toEqual(changed.map((goal) => goal.id));
  expect(displayedGoals(client)).toEqual(previousGoals.filter((row) => !removed.some((goal) => goal.id === row.id))
    .map((row) => changed.some((goal) => goal.id === row.id) ? { ...row, executionStatus: 'paused' } : row));
  expect(displayedInquiries(client)).toEqual(previousInquiries.filter((row) => !removed.some((goal) => goal.id === row.target.goalId)));
});

it('reprojects unchanged goal files when notification policy changes on the same attachment', async () => {
  const [goal] = seedSnapshotGoals(1, 0, 0);
  const connections = observeIpcConnections();
  await client.connect(); await complete();
  const observation = connections[0]!;
  saveGoal({ ...goal!, notifications: [{ id: randomUUID(), kind: 'custom', body: 'Policy-controlled notice', recordedAt: new Date().toISOString() }] });
  await refreshSnapshot(client, observation);
  const events = () => client.getSnapshot().items.filter((item) => item.kind === 'display_event');
  expect(events()).toHaveLength(1);
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  notifications:\n    custom: false\n');
  invalidateResolvedConfigCache(repository);
  const disabled = await refreshSnapshot(client, observation);
  expect(disabled.items.filter((item) => item.kind === 'remove')).toHaveLength(1);
  expect(events()).toEqual([]);
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  notifications:\n    custom: true\n');
  invalidateResolvedConfigCache(repository);
  await refreshSnapshot(client, observation);
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ event: { message: expect.stringContaining('Policy-controlled notice') } });
});
