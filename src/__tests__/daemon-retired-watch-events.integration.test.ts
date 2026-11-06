import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AcceptedEvent, EventInput } from '../core/daemon/events.js';
import { AcceptedEventSchema } from '../infra/daemon/eventRecord.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { writePrivateFile } from '../infra/daemon/privateFile.js';
import { FileWatchRecords } from '../infra/daemon/watchRecords.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting, projectKey } from '../features/daemon/routing.js';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { startDaemonWatchers } from '../features/daemon/watchers/index.js';
import { WatchObservations, type WatchRecord } from '../features/daemon/watchers/observations.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';

vi.mock('../infra/daemon/process.js', () => ({
  readProcessOwner: async (pid: number) => ({ pid, startTime: 'test-process-start' }),
  observeProcess: async (owner: { pid: number }) => owner.pid === process.pid ? { kind: 'alive', owner } : { kind: 'dead' },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const task = { repositoryDirectory: '/repo', goalId: 'goal', taskName: 'task', runSlug: 'run' };
const retiredObservations = [
  { kind: 'run_too_long', task, startedAt: '2020-01-01T00:00:00Z' },
  { kind: 'run_step_repeated', task, workflow: 'root', step: 'review', stepIdentity: 'review', count: 100 },
  { kind: 'run_log_stalled', task, lastUpdatedAt: '2020-01-01T00:00:00Z' },
  { kind: 'inquiry_stalled', repositoryDirectory: '/repo', goalId: 'goal', questionId: 'question' },
  { kind: 'goal_stalled', repositoryDirectory: '/repo', goalId: 'goal', lastUpdatedAt: '2020-01-01T00:00:00Z' },
] as const;

function event(): AcceptedEvent {
  return { eventId: 'current', requestId: 'current', conversationId: 'manager', operationId: 'current',
    acceptedSequence: 1, lane: 'other', source: 'watcher', occurredAt: '2026-11-06T00:00:00Z',
    event: { kind: 'watch_observation', observation: { kind: 'run_launch_stalled', targetId: 'target', generation: 'generation',
      observedAt: '2026-11-06T00:00:00Z', repositoryDirectory: '/repo' } } };
}

it.each(retiredObservations)('restores only settling results from stored $kind events without accepting new ones', async (observation) => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-retired-watch-'));
  directories.push(directory);
  const current = event();
  await new FileEventStore(directory).accept(current);
  const states = ['queued', 'running', 'settling', 'settled'] as const;
  let settling;
  for (const [index, state] of states.entries()) {
    const id = `retired-${state}`;
    const input = { ...current, eventId: id, requestId: id, operationId: id, acceptedSequence: index + 2,
      event: { kind: 'watch_observation', observation: { targetId: 'target', generation: 'generation',
        observedAt: current.occurredAt, ...observation } } };
    const watchInput = { eventId: id, requestId: id, conversationId: input.conversationId, source: input.source,
      occurredAt: input.occurredAt, event: input.event };
    const turn = { conversationId: input.conversationId, operationId: id, generation: 1 };
    const result = { ...turn, event: input, outcome: { kind: 'interrupted' } };
    const record = { state, event: input, ...(state === 'running' ? { turn } : {}),
      ...(state === 'settling' || state === 'settled' ? { result } : {}) };
    if (state === 'settling') settling = record;
    const key = createHash('sha256').update(id).digest('hex');
    await writePrivateFile(join(directory, 'daemon-events', `${key}.json`), JSON.stringify(record));
    await writePrivateFile(join(directory, 'daemon-watches', `${key}.json`), JSON.stringify({
      episode: 1, active: true, accepted: state !== 'queued', input: watchInput,
    }));
    expect(await new FileWatchRecords(directory).read(key)).toBeUndefined();
    expect(AcceptedEventSchema.safeParse(input).success).toBe(false);
    await expect(new FileEventStore(directory).accept(input as unknown as AcceptedEvent)).rejects.toThrow();
  }
  const restarted = new FileEventStore(directory);
  const restored = await restarted.restore();
  const pending = [];
  for await (const record of restored.pending) pending.push(record);
  expect(pending).toHaveLength(2);
  expect(pending).toEqual(expect.arrayContaining([{ state: 'queued', event: current }, settling]));
  expect(restored.lastAcceptedSequence).toBe(5);
  expect(await restarted.hasGoalRegistration('/repo', 'goal')).toBe(false);
  expect(await restarted.accept({ ...current, eventId: 'next', requestId: 'next', operationId: 'next', acceptedSequence: 6 }))
    .toEqual({ kind: 'stored' });
  expect((await new FileEventStore(directory).restore()).lastAcceptedSequence).toBe(6);
});

it('still rejects unknown event kinds in storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-unknown-watch-'));
  directories.push(directory);
  const input = { ...event(), event: { kind: 'watch_observation', observation: { kind: 'unknown_observation' } } };
  const key = createHash('sha256').update(input.eventId).digest('hex');
  await writePrivateFile(join(directory, 'daemon-events', `${key}.json`), JSON.stringify({ state: 'queued', event: input }));
  await expect(new FileEventStore(directory).restore()).rejects.toThrow();
  await writePrivateFile(join(directory, 'daemon-watches', `${key}.json`), JSON.stringify({
    episode: 1, active: true, accepted: false, input,
  }));
  await expect(new FileWatchRecords(directory).read(key)).rejects.toThrow();
});


it.each(['queued', 'running', 'settling', 'settled'] as const)('reserves retired %s event IDs, request IDs and acceptance sequences without overwriting history', async (state) => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-retired-identities-'));
  directories.push(directory);
  const input = { ...event(), event: { kind: 'watch_observation', observation: {
    targetId: 'target', generation: 'generation', observedAt: event().occurredAt, ...retiredObservations[0],
  } } };
  const turn = { conversationId: input.conversationId, operationId: input.operationId, generation: 1 };
  const result = { ...turn, event: input, outcome: { kind: 'interrupted' } };
  const record = { state, event: input, ...(state === 'running' ? { turn } : {}),
    ...(state === 'settling' || state === 'settled' ? { result } : {}) };
  const path = join(directory, 'daemon-events', `${createHash('sha256').update(input.eventId).digest('hex')}.json`);
  const content = JSON.stringify(record);
  await writePrivateFile(path, content);
  const restarted = new FileEventStore(directory);
  for (const duplicate of [
    { ...event(), requestId: 'other', acceptedSequence: 2 },
    { ...event(), eventId: 'other', acceptedSequence: 3 },
  ]) {
    expect(await restarted.accept(duplicate)).toEqual({ kind: 'duplicate', event: input,
      state: state === 'settling' ? 'settling' : 'settled' });
  }
  await expect(restarted.accept({ ...event(), eventId: 'next', requestId: 'next' })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(content);
  expect((await new FileEventStore(directory).restore()).lastAcceptedSequence).toBe(1);
});

it.each(retiredObservations)('applies and settles the saved $kind result across restart without running a turn', async (observation) => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-retired-settlement-'));
  directories.push(directory);
  const record = conversationRecord('/repo');
  const state = new ConversationStateStore(directory);
  await state.create(record);
  const input = { ...event(), conversationId: record.id, event: { kind: 'watch_observation', observation: {
    targetId: 'target', generation: 'generation', observedAt: event().occurredAt, ...observation,
  } } };
  const result = { conversationId: record.id, operationId: input.operationId, generation: 1, event: input,
    outcome: { kind: 'completed', result: { kind: 'reply', message: 'saved reply' }, change: {
      operationId: 'saved-change', expectedVersion: 0,
      session: { provider: 'mock', model: null, sessionId: 'saved-session' },
      proposal: { revision: 5, pending: null },
    } } };
  const path = join(directory, 'daemon-events', `${createHash('sha256').update(input.eventId).digest('hex')}.json`);
  await writePrivateFile(path, JSON.stringify({ state: 'settling', event: input, result }));
  for (let restart = 0; restart < 3; restart++) {
    const errors = vi.fn();
    const store = new FileEventStore(directory);
    const settlementFailure = new Error('Settlement unavailable');
    if (restart === 0) vi.spyOn(store, 'markSettled').mockRejectedValueOnce(settlementFailure);
    const owner = new DaemonConversations(new ConversationStateStore(directory), new DaemonRouting(directory),
      new DaemonNotifications(directory), async () => {}, errors);
    const apply = vi.spyOn(owner, 'apply');
    const runner = new ControlledTurnRunner();
    const dispatcher = await createDaemonDispatcher({ store, conversations: owner, runner,
      stateRequests: { handle: vi.fn() }, resources: { close: vi.fn() },
      limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: errors });
    runner.bus = dispatcher;
    if (restart === 0) {
      await expect(dispatcher.control({ kind: 'stop' })).rejects.toBeInstanceOf(AggregateError);
      expect(errors).toHaveBeenCalledExactlyOnceWith({ phase: 'settle', event: input, error: settlementFailure });
    } else {
      await dispatcher.control({ kind: 'stop' });
      expect(errors).not.toHaveBeenCalled();
    }
    if (restart < 2) expect(apply).toHaveBeenCalledExactlyOnceWith(result);
    else expect(apply).not.toHaveBeenCalled();
    expect(runner.calls).toEqual([]);
    expect((await state.read(record.id))?.state).toMatchObject({ version: 1, revision: 5, pending: null,
      session: { sessionId: 'saved-session' } });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ state: restart === 0 ? 'settling' : 'settled', event: input, result });
  }
});

it('does not issue stalled observations for real pending inquiries after weeks of watcher passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-inquiry-watch-'));
  directories.push(directory);
  const repository = join(directory, 'repo');
  await mkdir(repository);
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const errors = vi.fn();
  const conversations = new DaemonConversations(new ConversationStateStore(directory), new DaemonRouting(directory),
    new DaemonNotifications(directory), async () => {}, errors);
  const question = { id: '650e8400-e29b-41d4-a716-446655440001', body: 'Pending human answer',
    status: 'pending', recipient: 'human', createdAt: '2020-01-01T00:00:00Z' };
  const inquiryPath = join(directory, 'projects', projectKey(repository), 'inquiries', `${question.id}.json`);
  await writePrivateFile(inquiryPath, JSON.stringify(question));
  const records = new Map<string, WatchRecord>();
  const watchRecords = { async read(key: string) { return records.get(key); },
    async write(key: string, record: WatchRecord) { records.set(key, structuredClone(record)); } };
  const accept = vi.fn(async (_input: EventInput) => ({ kind: 'accepted' as const, eventId: 'accepted', operationId: 'accepted', acceptedSequence: 1 }));
  const expectNoRetiredObservations = () => {
    const kinds = accept.mock.calls.flatMap(([input]) => input.event.kind === 'watch_observation' ? [input.event.observation.kind] : []);
    for (const observation of retiredObservations) expect(kinds).not.toContain(observation.kind);
  };
  const publish = vi.fn(async () => {});
  const observations = new WatchObservations(watchRecords, { accept }, Date.now);
  const source = new FileDaemonWatchSource(conversations, publish, errors, observations);
  vi.spyOn(source, 'directories').mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ['Date'] });
  const watchers = startDaemonWatchers({ source, processes: { inspect: vi.fn() }, commands: { run: vi.fn() }, records: watchRecords,
    ingress: { accept }, filesChanged: vi.fn(async () => {}), now: Date.now, onError: errors });
  try {
    await watchers.drain();
    expect(errors).not.toHaveBeenCalled();
    expectNoRetiredObservations();
    for (let week = 0; week < 3; week++) {
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      watchers.changed();
      await watchers.drain();
      expectNoRetiredObservations();
    }
    expect(publish).not.toHaveBeenCalled();
    // 読取経路が動作していることを、同じ pending inquiry の内容変更の配信で確かめる。
    await writePrivateFile(inquiryPath, JSON.stringify({ ...question, body: 'Updated question' }));
    watchers.changed();
    await watchers.drain();
    expectNoRetiredObservations();
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ question: expect.objectContaining({ id: question.id, status: 'pending', body: 'Updated question' }) }));
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await watchers.close();
    await source.close();
  }
});


it.each(['eventId', 'requestId', 'acceptedSequence'] as const)('rejects a conflicting stored retired %s', async (field) => {
  const directory = await mkdtemp(join(tmpdir(), 'takt-retired-conflict-'));
  directories.push(directory);
  const original = event();
  await new FileEventStore(directory).accept(original);
  const input = { ...original, eventId: 'retired', requestId: 'retired', acceptedSequence: 2,
    event: { kind: 'watch_observation', observation: { targetId: 'target', generation: 'generation',
      observedAt: original.occurredAt, ...retiredObservations[0] } }, [field]: original[field] };
  const path = join(directory, 'daemon-events', `${createHash('sha256').update('retired').digest('hex')}.json`);
  await writePrivateFile(path, JSON.stringify({ state: 'queued', event: input }));
  await expect(new FileEventStore(directory).restore()).rejects.toThrow();
});
