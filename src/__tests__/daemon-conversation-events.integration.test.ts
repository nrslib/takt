import { installDaemonErrorLog, reportDaemonError } from '../infra/daemon/diagnostics.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as slackPorts from '../features/daemon/slackPorts.js';
import * as watcherModule from '../features/daemon/watchers/index.js';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { WatchObservations } from '../features/daemon/watchers/observations.js';
import { FileWatchRecords } from '../infra/daemon/watchRecords.js';
import { startDirectoryWatcher } from '../features/daemon/watchers/directories.js';
import { readWatchTasks } from '../features/daemon/watchers/state.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import { ControlledTurnRunner, deferred, input, accepted } from './helpers/controlledDaemon.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { PortOutput } from '../features/manager/conversationPort.js';

vi.mock('../features/daemon/conversationIpcServer.js', () => ({ createConversationIpcServer: async () => ({ stopAccepting() {}, async close() {} }) }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(seed?: (directory: string, repository: string) => Promise<void>) {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  await mkdir(join(repository, '.takt'), { recursive: true });
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  await seed?.(directory, repository);
  const runner = new ControlledTurnRunner();
  const daemon = await startDaemon({ configDirectory: directory, owner: { pid: process.pid, identity: { startTime: 'fixture' }, version: 'test', cliPath: '/daemon.js' },
    tokens: undefined, signal: new AbortController().signal, runnerFactory(bus) { runner.bus = bus; return runner; } });
  cleanups.push(daemon.close);
  await daemon.watchers.drain();
  await daemon.watchers.close();
  const assignment = { kind: 'repository' as const, repositoryDirectory: repository };
  await daemon.conversations.ensure(assignment);
  const id = conversationId(assignment);
  const outputs: PortOutput[] = [];
  const opened = await daemon.input.open({ conversationId: id, assignment, speaker: { namespace: 'local', id: 'operator' },
    binding: { port: 'tui', key: 'fixture', counterpart: { namespace: 'local', id: 'operator' } } }, {
    async deliver(_id, output) { outputs.push(output); return { kind: 'delivered' }; },
  });
  opened.read.cancel();
  const post = (name: string, lane: 'human' | 'other' = 'human') => daemon.dispatcher.accept(input(name, id, lane));
  return { ...daemon, directory, repository, runner, id, opened, post, outputs };
}

it('persists H1 and H2 during a stopped turn and schedules both human messages before queued events', async () => {
  const f = await fixture();
  accepted(await f.post('active'));
  const active = await f.runner.started(1);
  for (const [id, lane] of [['E1', 'other'], ['H1', 'human'], ['E2', 'other'], ['H2', 'human']] as const) accepted(await f.post(id, lane));
  const restored = await new FileEventStore(f.directory).restore();
  const pending = [];
  for await (const item of restored.pending) pending.push(item.event.eventId);
  expect(pending).toEqual(expect.arrayContaining(['active', 'E1', 'H1', 'E2', 'H2']));
  expect(f.runner.calls).toHaveLength(1);
  await f.runner.finish(active);
  for (const [index, name] of ['H1', 'H2', 'E1', 'E2'].entries()) {
    const call = await f.runner.started(index + 2);
    expect(call.input.event.eventId).toBe(name);
    await f.runner.finish(call);
  }
});

it('interrupts only the named generation and retains accepted waiting input through shutdown and restore', async () => {
  const f = await fixture();
  accepted(await f.post('active')); const active = await f.runner.started(1);
  accepted(await f.post('waiting'));
  expect(await f.dispatcher.control({ kind: 'interrupt', ...active.turn, generation: active.turn.generation + 1 })).toEqual({ kind: 'ignored' });
  expect(await f.dispatcher.control({ kind: 'interrupt', ...active.turn })).toEqual({ kind: 'interrupted' });
  expect(f.runner.calls).toHaveLength(1);
  await f.close();
  const pending = [];
  for await (const record of (await new FileEventStore(f.directory).restore()).pending) pending.push(record);
  expect(pending).toMatchObject([{ state: 'queued', event: { eventId: 'waiting' } }]);
});

it('saves state requests independently of the pending model turn and rejects stale and unauthorized requests', async () => {
  const f = await fixture();
  accepted(await f.post('human')); const call = await f.runner.started(1);
  const change = { operationId: 'session-save', expectedVersion: 0, session: { provider: 'mock', model: null, sessionId: 'kept' } };
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toEqual({ kind: 'state_saved', version: 1, duplicate: false });
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toEqual({ kind: 'state_saved', version: 1, duplicate: true });
  expect(await f.dispatcher.request(call.turn, { kind: 'notify_director', notificationId: randomUUID(), message: 'forged' }, call.signal)).toMatchObject({ kind: 'error', code: 'forbidden' });
  await f.runner.finish(call);
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toMatchObject({ kind: 'error', code: 'stale_turn' });
  expect((await f.conversations.store.read(f.id))!.state.session.sessionId).toBe('kept');
});

it('accepts director messages through the bus and saves one result notification without self IPC', async () => {
  const f = await fixture();
  const director = conversationId({ kind: 'daemon' });
  accepted(await f.dispatcher.accept(input('director-turn', director)));
  const call = await f.runner.started(1);
  expect(await f.dispatcher.request(call.turn, { kind: 'get_delivery', conversationId: f.id }, call.signal)).toMatchObject({ kind: 'delivery', conversationId: f.id, connectedPorts: ['tui'] });
  const request = { kind: 'accept_director_message' as const, conversationId: f.id, eventId: 'director-input', requestId: 'director-input', text: 'inspect', occurredAt: '2026-11-03T00:00:00Z' };
  expect(await f.dispatcher.request(call.turn, request, call.signal)).toMatchObject({ kind: 'event_accepted', admission: { kind: 'accepted' } });
  const manager = await f.runner.started(2);
  await f.runner.finish(manager, { kind: 'completed', result: { kind: 'reply', message: 'checked' } });
  const saved = [];
  for await (const notice of f.conversations.notifications.iterate()) saved.push(notice);
  expect(saved).toMatchObject([{ id: `result-${manager.turn.operationId}`, message: expect.stringContaining('checked') }]);
  await f.conversations.apply({ ...manager.turn, event: manager.input.event, outcome: { kind: 'completed', result: { kind: 'reply', message: 'checked' } } });
  const repeated = [];
  for await (const notice of f.conversations.notifications.iterate()) repeated.push(notice);
  expect(repeated).toEqual(saved);
});

it('retires an unread legacy patrol without starting a turn and only deletes other inbox files after acceptance', async () => {
  const f = await fixture();
  const files = new DaemonPersistedFiles(f.directory);
  const inbox = await files.inboxDirectory(f.repository); await mkdir(inbox, { recursive: true });
  const path = join(inbox, 'legacy.json');
  const target = { targetId: f.repository, generation: 'inbox', conversationId: f.id, kind: 'inbox' as const, directory: inbox };
  await writeFile(path, JSON.stringify({ kind: 'patrol', goalId: goalRecord().id, createdAt: '2026-11-03T00:00:00Z' }));
  await receiveInboxChange({ path, target, generation: '1', value: null, removed: false }, files, f.conversations, f.dispatcher);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.runner.calls).toHaveLength(0);
  await writeFile(path, JSON.stringify({ kind: 'registered', goalId: goalRecord().id, createdAt: '2026-11-03T00:00:00Z' }));
  const blocked = deferred<Awaited<ReturnType<typeof f.dispatcher.accept>>>();
  const receiving = receiveInboxChange({ path, target, generation: '2', value: null, removed: false }, files, f.conversations, { accept: () => blocked.promise });
  expect(await readFile(path, 'utf8')).toContain('registered');
  blocked.resolve({ kind: 'rejected', reason: 'storage' });
  await expect(receiving).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toContain('registered');
});

it('reads legacy proposal, session, patrol history and accepted human/director queues through the new stores', async () => {
  let record!: ReturnType<typeof conversationRecord>;
  const f = await fixture(async (directory, repository) => {
    record = conversationRecord(repository);
    record.directorMessages = [{ operationId: randomUUID(), text: 'kept human input', speaker: { namespace: 'local', id: 'operator' } }];
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', `${record.id}.json`), JSON.stringify(record));
  });
  const goal = { ...goalRecord(), workLog: [{ id: randomUUID(), kind: 'patrol', summary: 'old history', recordedAt: '2026-11-02T00:00:00Z' }] };
  await mkdir(join(f.repository, '.takt', 'goals', goal.id), { recursive: true });
  await writeFile(join(f.repository, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify(goal));
  const call = await f.runner.started(1);
  expect(call.input.event.event).toMatchObject({ kind: 'human_command', command: { text: 'kept human input' } });
  expect(call.input.state).toMatchObject({ revision: 4, session: { sessionId: 'provider-session' }, pending: record.pending });
  const read = await f.dispatcher.snapshot(f.id); const items = [];
  for await (const item of read.items) items.push(item);
  read.complete();
  expect(items).toContainEqual({ kind: 'display_event', event: { id: JSON.stringify([f.repository, goal.id, 'work-log', goal.workLog[0]!.id]), message: `${goal.id}: old history` }, recordedAt: goal.workLog[0]!.recordedAt });
  expect((await new ConversationStateStore(f.directory).read(f.id))!.record.directorMessages).toEqual([]);
});

it('reads legacy director notices and persists notification IDs and subjects idempotently', async () => {
  const f = await fixture();
  const id = randomUUID();
  const directory = join(f.directory, 'director-notifications');
  await mkdir(directory, { recursive: true });
  const subject = { key: 'goal:waiting', state: 'awaiting_merge' };
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, message: 'Legacy notice', subject }));
  const notices = [];
  for await (const notice of f.conversations.notifications.iterate()) notices.push(notice);
  expect(notices).toEqual([{ id, message: 'Legacy notice', subject }]);
  const signal = new AbortController().signal;
  expect(await f.conversations.notifications.save({ id, message: 'Legacy notice', subject }, signal)).toBe(false);
  expect(await f.conversations.notifications.save({ id: randomUUID(), message: 'Duplicate subject', subject }, signal)).toBe(false);
  const input = { id: randomUUID(), message: 'New notice' };
  expect(await f.conversations.notifications.save(input, signal)).toBe(true);
  expect(await f.conversations.notifications.save(input, signal)).toBe(false);
  await expect(f.conversations.notifications.save({ ...input, message: 'Changed' }, signal)).rejects.toThrow('Notification ID reused');
});

it('uses the saved PR head and integration branches and distinguishes copied goals in different repositories', async () => {
  const f = await fixture();
  const other = join(f.directory, 'other');
  await mkdir(other);
  await registerProject({ globalConfigDirectory: f.directory, projectDirectory: other, command: 'manager', managerUsed: true });
  const goal = { ...goalRecord(), status: 'awaiting_merge', integrationBranch: 'release',
    pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'release', summary: 'Ready', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } } };
  for (const directory of [f.repository, other]) {
    const root = join(directory, '.takt', 'goals', goal.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'goal.json'), JSON.stringify(goal));
  }
  const source = new FileDaemonWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  const targets = await source.pullRequests();
  expect(targets).toHaveLength(2);
  expect(new Set(targets.map((target) => target.targetId)).size).toBe(2);
  for (const target of targets) expect(target).toMatchObject({ headBranch: goal.branch, baseBranch: 'release', goalId: goal.id });
});

it('starts observation while Slack connection setup remains pending', async () => {
  const entered = deferred<void>();
  const released = deferred<void>();
  const createPorts = slackPorts.createDaemonSlackPorts;
  vi.spyOn(slackPorts, 'createDaemonSlackPorts').mockImplementationOnce(async (options) => {
    entered.resolve(); await released.promise; return createPorts(options);
  });
  const startWatchers = vi.spyOn(watcherModule, 'startDaemonWatchers');
  const runner = new ControlledTurnRunner();
  const starting = startDaemon({ configDirectory: getGlobalConfigDir(),
    owner: { pid: process.pid, identity: { startTime: 'pending-slack' }, version: 'test', cliPath: '/daemon.js' },
    tokens: undefined, signal: new AbortController().signal, runnerFactory(bus) { runner.bus = bus; return runner; } });
  try {
    await entered.promise;
    expect(startWatchers).toHaveBeenCalledOnce();
    await startWatchers.mock.results[0]!.value.drain();
    expect(runner.calls).toHaveLength(0);
  } finally {
    released.resolve();
    await (await starting).close();
  }
});

it('persists daemon diagnostics through the owned asynchronous logger before shutdown', async () => {
  const directory = getGlobalConfigDir();
  const logger = new DaemonLogger(directory);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const restore = installDaemonErrorLog((message) => logger.write('error', message));
  try {
    reportDaemonError(new Error('diagnostic fixture'));
    await logger.close();
    const names = await readdir(join(directory, 'daemon-logs'));
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, 'daemon-logs', names[0]!), 'utf8')))
      .toMatchObject({ level: 'error', message: 'diagnostic fixture' });
    expect(stderr).toHaveBeenCalledWith('diagnostic fixture\n');
  } finally { restore(); await logger.close(); }
});

it('excludes normal waiting states from goal stalls and ignores patrol and notification timestamps', async () => {
  const f = await fixture();
  const old = '2026-11-01T00:00:00Z'; const recent = '2026-11-03T00:00:00Z';
  const path = join(f.repository, '.takt', 'goals', goalRecord().id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  const goal = { ...goalRecord(), createdAt: old, workLog: [{ id: randomUUID(), kind: 'patrol', summary: 'inspection', recordedAt: recent }] };
  const source = new FileDaemonWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  await writeFile(path, JSON.stringify(goal));
  expect((await source.goals())[0]).toMatchObject({ active: true, lastUpdatedAt: old });
  await writeFile(path, JSON.stringify({ ...goal, questions: [{ id: randomUUID(), body: 'answer?', recipient: 'human', status: 'pending', createdAt: old }] }));
  expect((await source.goals())[0]?.active).toBe(false);
  await writeFile(path, JSON.stringify(goal));
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks: [{ name: 'running', status: 'running', goal_id: goal.id,
    created_at: old, started_at: old, completed_at: null }] }));
  expect((await source.goals())[0]?.active).toBe(false);
});

it('pages more than 128 inbox files while goals and tasks exceed the old total count limit', async () => {
  const f = await fixture(); const files = new DaemonPersistedFiles(f.directory);
  const inbox = await files.inboxDirectory(f.repository); await mkdir(inbox, { recursive: true });
  const timestamp = '2026-11-03T00:00:00Z';
  for (let index = 0; index < 130; index++) {
    const goal = { ...goalRecord(), id: randomUUID(), createdAt: timestamp };
    const directory = join(f.repository, '.takt', 'goals', goal.id); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'goal.json'), JSON.stringify(goal));
    await writeFile(join(inbox, `${index.toString().padStart(3, '0')}.json`), JSON.stringify({ kind: 'registered', goalId: goal.id, createdAt: timestamp }));
  }
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks: Array.from({ length: 130 }, (_, index) => ({
    name: `task-${index}`, status: 'completed', created_at: timestamp, started_at: timestamp, completed_at: timestamp,
  })) }));
  expect(await readWatchTasks(f.repository)).toHaveLength(130);
  const source = new FileDaemonWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  expect(await source.goals()).toHaveLength(130);
  expect(await source.inquiries()).toEqual([]);
  const targets = (await source.directories()).filter((target) => target.kind === 'inbox');
  const accept = vi.fn(async () => ({ kind: 'accepted' as const, eventId: 'accepted', operationId: randomUUID(), acceptedSequence: 1 }));
  const errors = vi.fn();
  const watcher = startDirectoryWatcher({ targets: async () => targets, onError: errors,
    changed: (change) => receiveInboxChange(change, files, f.conversations, { accept }) });
  try {
    await watcher.drain();
    expect(accept.mock.calls.length).toBeGreaterThanOrEqual(128);
    expect(accept.mock.calls.length).toBeLessThanOrEqual(130);
    watcher.wake(); await watcher.drain();
    expect(accept).toHaveBeenCalledTimes(130);
    expect(await readdir(inbox)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(await f.post('human-still-accepted')).toMatchObject({ kind: 'accepted' });
  } finally { await watcher.close(); }
});

it('admits director turns for saved goal and inquiry changes and deduplicates unchanged state across restart', async () => {
  const f = await fixture();
  const goal = { ...goalRecord(), createdAt: '2026-11-01T00:00:00Z' };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json'); await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(goal));
  const source = () => new FileDaemonWatchSource(f.conversations, (notice) => f.dispatcher.inquiry(notice), (error) => { throw error; },
    new WatchObservations(new FileWatchRecords(f.directory), f.dispatcher, Date.now));
  await source().inquiries();
  const first = await f.runner.started(1);
  expect(first.turn.conversationId).toBe(conversationId({ kind: 'daemon' }));
  await f.runner.finish(first);
  await source().inquiries(); expect(f.runner.calls).toHaveLength(1);
  const completion = { goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } };
  await writeFile(path, JSON.stringify({ ...goal, status: 'awaiting_merge', completion }));
  await source().inquiries();
  const second = await f.runner.started(2);
  expect(second.input.event.event).toMatchObject({ kind: 'watch_observation', observation: { kind: 'director_state_changed', goalId: goal.id } });
  expect((await source().goals())[0]?.active).toBe(false);
  await f.runner.finish(second);
  await writeFile(path, JSON.stringify({ ...goal, questions: [{ id: randomUUID(), body: 'question', status: 'pending', recipient: 'human' }] }));
  await source().inquiries(); await f.runner.started(3);
  await source().inquiries(); expect(f.runner.calls).toHaveLength(3);
});

it.each([false, true])('records and notifies a legacy running interruption before retiring it, preserving queued input (director: %s)', async (director) => {
  const operationId = randomUUID();
  const f = await fixture(async (directory, repository) => {
    const record = conversationRecord(repository);
    if (director) record.lastSpeaker = { namespace: 'agent', id: 'director' };
    record.running = { operationId, kind: 'message', ...(director ? { directorConversationId: conversationId({ kind: 'daemon' }) } : {}),
      owner: { pid: 123, identity: { startTime: 'old' } } };
    record.directorMessages = [{ operationId: randomUUID(), text: 'waiting', speaker: record.counterpart }];
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', `${record.id}.json`), JSON.stringify(record));
  });
  const call = await f.runner.started(1);
  expect(call.input.event.event).toMatchObject({ kind: 'human_command', command: { text: 'waiting' } });
  expect(call.turn.operationId).not.toBe(operationId);
  expect((await f.conversations.store.read(f.id))?.record.running).toBeNull();
  const stored = (await readdir(join(f.directory, 'daemon-events'))).filter((name) => name.endsWith('.json'));
  const records = await Promise.all(stored.map(async (name) => JSON.parse(await readFile(join(f.directory, 'daemon-events', name), 'utf8')) as unknown));
  expect(records).toContainEqual(expect.objectContaining({ state: 'settled', result: expect.objectContaining({ operationId, outcome: { kind: 'interrupted' } }) }));
  const notices = []; for await (const notice of f.conversations.notifications.iterate()) notices.push(notice);
  expect(notices).toContainEqual(expect.objectContaining({ id: `result-${operationId}` }));
});

it('delivers all notifications from a director turn as a single batch after its result', async () => {
  const deliver = vi.fn(async (_batch: readonly { id: string; message: string }[]) => {});
  vi.spyOn(slackPorts, 'createDaemonSlackPorts').mockResolvedValueOnce({ listening: false, notifications: { deliver },
    delivery: { async deliver() { return { kind: 'delivered' }; } }, stopAccepting() {}, async close() {} });
  const f = await fixture();
  accepted(await f.dispatcher.accept(input('notify', conversationId({ kind: 'daemon' }))));
  const call = await f.runner.started(1);
  for (const message of ['one', 'two']) await f.dispatcher.request(call.turn, { kind: 'notify_director', notificationId: randomUUID(), message }, call.signal);
  expect(deliver).not.toHaveBeenCalled();
  await f.runner.finish(call);
  await f.conversations.close();
  expect(deliver).toHaveBeenCalledOnce();
  expect(deliver.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'one' }), expect.objectContaining({ message: 'two' })]));
});

it('preserves another conversation final result while a slow attachment fills its delivery slots', async () => {
  const f = await fixture(); const stalled = deferred<void>();
  const slow = await f.input.open({ conversationId: f.id, assignment: { kind: 'repository', repositoryDirectory: f.repository },
    speaker: { namespace: 'local', id: 'operator' }, binding: { port: 'tui', key: 'slow', counterpart: { namespace: 'local', id: 'operator' } } },
    { async deliver() { await stalled.promise; return { kind: 'delivered' }; } });
  slow.read.cancel();
  const directorId = conversationId({ kind: 'daemon' }); const outputs: PortOutput[] = [];
  const fast = await f.input.open({ conversationId: directorId, assignment: { kind: 'daemon' }, speaker: { namespace: 'local', id: 'operator' },
    binding: { port: 'tui', key: 'fast', counterpart: { namespace: 'local', id: 'operator' } } },
    { async deliver(_id, output) { outputs.push(output); return { kind: 'delivered' }; } }); fast.read.cancel();
  try {
    const operationId = randomUUID();
    for (let index = 0; index < 40; index++) f.conversations.send(f.id, { kind: 'progress', operationId, message: 'progress' },
      { revision: 0, stateSequence: index + 1, operationId });
    const event = { ...input('other-conversation', directorId), operationId, acceptedSequence: 1, lane: 'human' as const };
    await f.conversations.apply({ conversationId: directorId, operationId, generation: 1, event,
      outcome: { kind: 'completed', result: { kind: 'reply', message: 'final reply' } } });
    expect(outputs).toContainEqual({ kind: 'result', operationId, result: { kind: 'reply', message: 'final reply' } });
  } finally { stalled.resolve(); await f.conversations.close(); }
});
