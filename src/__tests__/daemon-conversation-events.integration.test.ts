import { installDaemonErrorLog, reportDaemonError } from '../infra/daemon/diagnostics.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as spawnModule from '../shared/utils/spawn.js';
import { createTurnProcessHost } from '../features/daemon/turnProcessHost.js';
import type { DaemonProcessMessage } from '../core/daemon/processProtocol.js';
import type { ConversationChange, RuntimeMessage, TurnStart } from '../core/daemon/messages.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as slackPorts from '../features/daemon/slackPorts.js';
import * as watcherModule from '../features/daemon/watchers/index.js';
import { WatchGoalReader, type WatchGoal } from '../features/daemon/watchers/goalReader.js';
import * as workspaceRegistry from '../infra/config/global/workspaceRegistry.js';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import { createDaemonStateRequests } from '../features/daemon/stateRequests.js';
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
import * as daemonPrivateFiles from '../infra/daemon/privateFile.js';
import { createWatchSource } from './helpers/daemon-watch-source.js';
import { receiveInboxChange, restoreLegacyConversations } from '../features/daemon/inbox.js';
import type { TurnOutcome } from '../core/daemon/messages.js';
import { projectKey } from '../features/daemon/routing.js';
import { ControlledTurnRunner, deferred, input, accepted } from './helpers/controlledDaemon.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { createTurnProcessRuntime } from '../features/daemonTurn/processRuntime.js';
import { TurnConversationState } from '../features/daemonTurn/conversationState.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import { WatchChecks } from '../features/daemon/watchers/checks.js';
import { saveManagerEvent } from '../infra/goals/events.js';
import { parseDaemonProcessMessage, parseTurnProcessMessage } from '../core/daemon/processProtocol.js';
import { EventRecordSchema } from '../infra/daemon/eventRecord.js';

const ipc = vi.hoisted(() => ({ initializingCount: 0 }));
vi.mock('../features/daemon/conversationIpcServer.js', () => ({ createConversationIpcServer: async () => ({
  get initializingCount() { return ipc.initializingCount; }, stopAccepting() {}, async close() {},
}) }));
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

async function conversationProcess(f: Awaited<ReturnType<typeof fixture>>, execute: PreparedConversationRuntime['executor']['execute']) {
  const envelope = { protocolVersion: 1 as const, launchId: randomUUID() };
  const completed = new Map<string, ReturnType<typeof deferred<TurnOutcome>>>();
  const completion = (operationId: string) => {
    let value = completed.get(operationId);
    if (value === undefined) { value = deferred<TurnOutcome>(); completed.set(operationId, value); }
    return value;
  };
  const service = createConversationTurnService(f.directory, { async resolve() {
    return { provider: 'mock', model: null, language: 'en', contextKey: 'fixture', executor: { execute } };
  }, async close() {} });
  const runtime = createTurnProcessRuntime({
    createBusiness: () => ({ ...service, async close() {} }),
    onFatal(error) { for (const pending of completed.values()) pending.reject(error); },
    transport: { async send(message) {
      if (message.kind === 'daemon_request') {
        const reply = await f.dispatcher.request(message.turn, message.request, new AbortController().signal);
        await runtime.receive({ ...envelope, kind: 'daemon_reply', turn: message.turn, requestId: message.requestId, reply });
      } else if (message.kind === 'turn_finished') {
        const call = f.runner.calls.find((call) => call.turn.operationId === message.turn.operationId);
        if (call === undefined) throw new Error('Unknown conversation turn');
        await f.runner.finish(call, message.outcome);
        completion(call.turn.operationId).resolve(message.outcome);
      }
    } },
  });
  await runtime.receive({ ...envelope, kind: 'initialize', conversationId: f.id,
    assignment: { kind: 'repository', repositoryDirectory: f.repository }, configDirectory: f.directory });
  vi.spyOn(f.runner, 'resultCommitted').mockImplementation(async (turn) => {
    await runtime.receive({ ...envelope, kind: 'result_committed', turn });
  });
  f.runner.beforeClose = () => runtime.receive({ ...envelope, kind: 'shutdown' });
  cleanups.push(() => runtime.disconnect());
  return {
    async start(call: Awaited<ReturnType<typeof f.runner.started>>) {
      completion(call.turn.operationId);
      await runtime.receive({ ...envelope, kind: 'start_turn', input: call.input });
    },
    interrupt: (turn: TurnStart['turn']) => runtime.receive({ ...envelope, kind: 'interrupt', turn }),
    finished: (turn: TurnStart['turn']) => completion(turn.operationId).promise,
  };
}

it.each(['interrupt', 'shutdown'] as const)('persists interrupted manager context through %s and supplies it to the next executor turn', async (stop) => {
  const f = await fixture(async (directory, repository) => {
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', `${conversationId({ kind: 'repository', repositoryDirectory: repository })}.json`),
      JSON.stringify(conversationRecord(repository)));
  });
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const entered = deferred<void>();
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({
    message: 'continued', summary: null, sessionId: 'provider-session', assignment: undefined,
  }));
  execute.mockImplementationOnce(async (turn) => {
    expect(turn.sessionId).toBe('provider-session');
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      turn.abortSignal.addEventListener('abort', () => reject(turn.abortSignal.reason), { once: true });
      turn.abortSignal.throwIfAborted();
    });
    throw new Error('Expected interruption');
  });
  const child = await conversationProcess(f, execute);
  accepted(await f.post('interrupted human request'));
  const active = await f.runner.started(1);
  await child.start(active);
  await entered.promise;
  if (stop === 'shutdown') await f.close();
  else {
    expect(await f.dispatcher.control({ kind: 'interrupt', ...active.turn })).toEqual({ kind: 'interrupted' });
    await child.interrupt(active.turn);
  }
  expect(await child.finished(active.turn)).toMatchObject({ kind: 'interrupted' });
  const saved = await new ConversationStateStore(f.directory).read(f.id);
  expect(saved?.state).toMatchObject({ session: { sessionId: 'provider-session' }, interruptedMessage: 'interrupted human request' });
  expect(f.runner.calls).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce();
  const nextDaemon = stop === 'shutdown' ? await fixture() : f;
  const nextChild = stop === 'shutdown' ? await conversationProcess(nextDaemon, execute) : child;
  accepted(await nextDaemon.post('continuation'));
  const next = await nextDaemon.runner.started(stop === 'shutdown' ? 1 : 2);
  expect(next.input.event.eventId).toBe('continuation');
  await nextChild.start(next);
  expect(await nextChild.finished(next.turn)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  const turn = execute.mock.calls[1]![0];
  expect(turn.sessionId).toBe('provider-session');
  expect(turn.prompt).toContain('interrupted human request');
  expect(turn.prompt.slice(0, turn.prompt.indexOf('interrupted human request'))).toMatch(/interrupt/i);
  expect(turn.prompt.indexOf('interrupted human request')).toBeLessThan(turn.prompt.indexOf('continuation'));
  expect((await new ConversationStateStore(f.directory).read(f.id))?.state).toMatchObject({ interruptedMessage: null });
});

it.each([
  { source: 'human' as const, invalidated: false },
  { source: 'human' as const, invalidated: true },
  { source: 'event' as const, invalidated: false },
])('preserves human context and the latest session on shutdown without a child change ($source, invalidated: $invalidated)', async ({ source, invalidated }) => {
  const interruptedMessage = source === 'human' ? 'human request without child result' : 'previous interrupted human request';
  const f = await fixture(async (directory, repository) => {
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', `${conversationId({ kind: 'repository', repositoryDirectory: repository })}.json`),
      JSON.stringify({ ...conversationRecord(repository), ...(source === 'event' ? { interruptedMessage } : {}) }));
  });
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  accepted(await f.post('human request without child result', source === 'human' ? 'human' : 'other'));
  const active = await f.runner.started(1);
  if (invalidated) {
    expect(await f.dispatcher.request(active.turn, { kind: 'save_conversation', change: {
      operationId: randomUUID(), expectedVersion: active.input.state.version,
      session: { ...active.input.state.session, sessionId: null },
    } }, active.signal)).toMatchObject({ kind: 'state_saved' });
  }
  accepted(await f.post('waiting continuation'));
  await f.close();
  const store = new ConversationStateStore(f.directory);
  const saved = await store.read(f.id);
  expect(saved?.state).toMatchObject({ session: { sessionId: invalidated ? null : 'provider-session' }, interruptedMessage });
  const records = await Promise.all((await readdir(join(f.directory, 'daemon-events'))).filter((name) => name.endsWith('.json'))
    .map(async (name) => EventRecordSchema.parse(JSON.parse(await readFile(join(f.directory, 'daemon-events', name), 'utf8')) as unknown)));
  const settled = records.find((record) => record.event.eventId === active.input.event.eventId);
  if (source === 'human') {
    if (settled?.state !== 'settled') throw new Error('Expected a saved interrupted result');
    expect(settled.result.outcome).toMatchObject({ kind: 'interrupted', change: { interruptedMessage } });
    await store.apply(settled.result);
  } else expect(settled).toEqual({ state: 'queued', event: active.input.event });
  expect((await new ConversationStateStore(f.directory).read(f.id))?.state).toEqual(saved?.state);
  const restarted = await fixture();
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({
    message: 'continued', summary: null, sessionId: 'next-session', assignment: undefined,
  }));
  const child = await conversationProcess(restarted, execute);
  const waiting = await restarted.runner.started(1);
  expect(waiting.input.event.eventId).toBe('waiting continuation');
  await child.start(waiting);
  await child.finished(waiting.turn);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].sessionId).toBe(invalidated ? undefined : 'provider-session');
  expect(execute.mock.calls[0]![0].prompt).toContain(interruptedMessage);
  if (source === 'event') {
    const redelivered = await restarted.runner.started(2);
    expect(redelivered.input.event).toEqual(active.input.event);
    await restarted.runner.finish(redelivered);
  }
  expect(restarted.runner.calls).toHaveLength(source === 'event' ? 2 : 1);
});

it('roundtrips message-only changes and clearing through IPC and conversation storage', async () => {
  const f = await fixture();
  accepted(await f.post('state-update'));
  const call = await f.runner.started(1);
  const state = new TurnConversationState(call.input.state, { signal: call.signal, progress() {}, async request(change) {
    const message = parseTurnProcessMessage({ protocolVersion: 1, launchId: 'message-state', kind: 'daemon_request',
      turn: call.turn, requestId: randomUUID(), request: change }, 'message-state');
    if (message.kind !== 'daemon_request') throw new Error('Expected state request');
    return f.dispatcher.request(call.turn, message.request, call.signal);
  } });
  for (const interruptedMessage of ['original interrupted text', null]) {
    const fields: Omit<ConversationChange, 'operationId' | 'expectedVersion'> & { interruptedMessage: string | null } = { interruptedMessage };
    await state.save(fields);
    expect(state.current).toMatchObject({ interruptedMessage });
    expect((await new ConversationStateStore(f.directory).read(f.id))?.state).toMatchObject({ interruptedMessage });
  }
  await f.runner.finish(call);
});

it('keeps a committed session invalidation when shutdown interrupts its reply to the manager', async () => {
  const f = await fixture(async (directory, repository) => {
    await mkdir(join(directory, 'conversations'), { recursive: true });
    const record = conversationRecord(repository);
    await writeFile(join(directory, 'conversations', `${record.id}.json`), JSON.stringify(record));
  });
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  accepted(await f.post('interrupted during invalidation'));
  const active = await f.runner.started(1);
  accepted(await f.post('waiting after invalidation'));
  const committed = deferred<void>();
  const releaseReply = deferred<void>();
  const replied = deferred<void>();
  const envelope = { protocolVersion: 1 as const, launchId: 'manager-invalidation-race' };
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({
    message: 'continued', summary: null, sessionId: 'next-session', assignment: undefined,
  }));
  execute.mockImplementationOnce(async (turn) => {
    expect(turn.sessionId).toBe('provider-session');
    await turn.recovery!.invalidateSession();
    throw new Error('Expected shutdown before invalidation reply');
  });
  const service = createConversationTurnService(f.directory, { async resolve() {
    return { provider: 'mock', model: null, language: 'en', contextKey: 'fixture', executor: { execute } };
  }, async close() {} });
  const runtime = createTurnProcessRuntime({
    createBusiness: () => ({ ...service, async close() {} }),
    onFatal(error) { committed.reject(error); },
    transport: { async send(message) {
      if (message.kind === 'daemon_request') {
        const reply = await f.dispatcher.request(message.turn, message.request, new AbortController().signal);
        const invalidation = message.request.kind === 'save_conversation' && message.request.change.session?.sessionId === null;
        if (invalidation) {
          expect(reply).toMatchObject({ kind: 'state_saved', version: 2 });
          committed.resolve();
          await releaseReply.promise;
        }
        await runtime.receive({ ...envelope, kind: 'daemon_reply', turn: message.turn, requestId: message.requestId, reply });
        if (invalidation) replied.resolve();
      } else if (message.kind === 'turn_finished') {
        expect(message.outcome).toMatchObject({ kind: 'interrupted', change: { expectedVersion: 1,
          interruptedMessage: 'interrupted during invalidation' } });
        await f.runner.finish(active, message.outcome);
      }
    } },
  });
  cleanups.push(() => runtime.disconnect());
  await runtime.receive({ ...envelope, kind: 'initialize', conversationId: f.id,
    assignment: active.input.state.assignment, configDirectory: f.directory });
  f.runner.beforeClose = () => runtime.receive({ ...envelope, kind: 'shutdown' });
  await runtime.receive({ ...envelope, kind: 'start_turn', input: active.input });
  let committedError: unknown;
  try {
    await committed.promise;
  } catch (error) { committedError = error; }
  finally { releaseReply.resolve(); }
  await f.close();
  if (committedError !== undefined) throw committedError;
  await replied.promise;
  expect((await new ConversationStateStore(f.directory).read(f.id))?.state).toMatchObject({
    version: 3, session: { sessionId: null }, interruptedMessage: 'interrupted during invalidation',
  });
  const restarted = await fixture();
  const child = await conversationProcess(restarted, execute);
  const waiting = await restarted.runner.started(1);
  expect(waiting.input.event.eventId).toBe('waiting after invalidation');
  await child.start(waiting);
  await child.finished(waiting.turn);
  expect(execute.mock.calls[1]![0].sessionId).toBeUndefined();
  expect(execute.mock.calls[1]![0].prompt).toContain('interrupted during invalidation');
});

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

it.each(['command', 'observation'] as const)('accepts human input after 32 deferred results and durably settles an aborted goal via %s', async (abortVia) => {
  const goal = { ...goalRecord(), executionStatus: 'paused' as const };
  const f = await fixture();
  const goalPath = join(f.repository, '.takt', 'goals', goal.id);
  await mkdir(goalPath, { recursive: true });
  await writeFile(join(goalPath, 'goal.json'), JSON.stringify(goal));
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>();
  const resolve = vi.fn(async () => ({ provider: 'mock' as const, model: null, language: 'en' as const,
    contextKey: 'fixture', executor: { execute } }));
  const service = createConversationTurnService(f.directory, { resolve, async close() {} });
  const perform = async (call: Awaited<ReturnType<typeof f.runner.started>>) => {
    const outcome = await service.execute(call.input, { signal: call.signal, progress() {},
      request: (request) => f.dispatcher.request(call.turn, request, call.signal) });
    await f.runner.finish(call, outcome);
    return outcome;
  };
  for (let index = 1; index <= 32; index++) {
    accepted(await f.dispatcher.accept({ ...input(`deferred-${index}`, f.id, 'other'), event: { kind: 'task_completed',
      task: { repositoryDirectory: f.repository, goalId: goal.id, taskName: `task-${index}` }, result: { success: true, interrupted: false } } }));
    expect(await perform(await f.runner.started(index))).toEqual({ kind: 'deferred' });
  }
  accepted(await f.post('human'));
  await f.runner.finish(await f.runner.started(33));
  let next = 34;
  if (abortVia === 'command') {
    accepted(await f.dispatcher.accept({ ...input('abort', f.id), event: { kind: 'human_command',
      speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'abort_goal', goalId: goal.id } } }));
    expect(await perform(await f.runner.started(next++))).toMatchObject({ kind: 'completed', result: { kind: 'notice' } });
  } else {
    await writeFile(join(goalPath, 'goal.json'), JSON.stringify({ ...goal, executionStatus: 'aborted' }));
    accepted(await f.dispatcher.accept({ ...input('observed-abort', conversationId({ kind: 'daemon' }), 'other'),
      event: { kind: 'watch_observation', observation: { kind: 'director_state_changed', repositoryDirectory: f.repository, goalId: goal.id,
        managerConversationId: f.id, state: JSON.stringify({ executionStatus: 'aborted' }), targetId: 'goal', generation: 'aborted',
        observedAt: '2026-11-03T00:00:00Z' } } }));
  }
  for (let index = next; index <= 66; index++) {
    const call = await f.runner.started(index);
    if (call.input.event.event.kind === 'watch_observation') await f.runner.finish(call);
    else expect(await perform(call)).toMatchObject({ kind: 'completed', result: { kind: 'notice' } });
  }
  expect(resolve).not.toHaveBeenCalled();
  const pending = [];
  for await (const record of (await new FileEventStore(f.directory).restore()).pending) pending.push(record);
  expect(pending).toEqual([]);
});

it.each(['child', 'parent'] as const)('deduplicates child and parent failure notifications with %s saving first without a TUI attachment', async (first) => {
  const f = await fixture();
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(goal));
  f.input.detach(f.opened.attachmentId);
  const service = createConversationTurnService(f.directory, { async resolve() { throw new Error('provider failed'); }, async close() {} });
  accepted(await f.dispatcher.accept({ ...input('failed-completion', f.id, 'other'), event: { kind: 'task_completed',
    task: { repositoryDirectory: f.repository, goalId: goal.id, taskName: 'task' }, result: { success: true, interrupted: false } } }));
  const call = await f.runner.started(1);
  const failure = { kind: 'failed' as const, message: 'process exited' };
  if (first === 'parent') await f.runner.finish(call, failure);
  const outcome = await service.execute(call.input, { signal: call.signal, progress() {},
    request: (request) => f.dispatcher.request(call.turn, request, call.signal) });
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  if (first === 'child') await f.runner.finish(call, failure);
  const saved = JSON.parse(await readFile(path, 'utf8')) as Goal;
  expect(saved.notifications).toEqual([expect.objectContaining({ id: call.turn.operationId, kind: 'blocked', severity: 'error' })]);
});

it('persists a blocked notification for a large goal after an unattached turn process exits and includes it in the manager snapshot', async () => {
  const f = await fixture();
  const goal = { ...goalRecord(), workLog: Array.from({ length: 3 }, () => ({
    id: randomUUID(), recordedAt: new Date().toISOString(), summary: 'x'.repeat(100 * 1024),
  })) };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(goal));
  f.input.detach(f.opened.attachmentId);
  const outputCount = f.outputs.length;
  const child = Object.assign(new EventEmitter(), { connected: true }) as ChildProcess;
  const initialized = deferred<DaemonProcessMessage>();
  const started = deferred<TurnStart>();
  child.send = vi.fn((value: unknown, callback: unknown) => {
    const message = value as DaemonProcessMessage;
    if (message.kind === 'initialize') initialized.resolve(message);
    if (message.kind === 'start_turn') started.resolve(message.input);
    (callback as (error: Error | null) => void)(null);
    return true;
  }) as typeof child.send;
  const exit = deferred<spawnModule.ManagedProcessExit>();
  const spawn = spawnModule.spawnManagedProcess;
  vi.spyOn(spawnModule, 'spawnManagedProcess').mockImplementation((...args) => {
    if (!args[1].some((arg) => arg.endsWith('/app/daemon-turn/index.js'))) return spawn(...args);
    return { child, wait: () => exit.promise, waitForExit: () => exit.promise, async terminate() {} };
  });
  const finished = deferred<RuntimeMessage>();
  const host = createTurnProcessHost({ configDirectory: f.directory, onError(error) { throw error; },
    bus: { request: (...args) => f.dispatcher.request(...args), async post(message) {
      await f.dispatcher.post(message);
      finished.resolve(message);
    } } });
  cleanups.push(async () => { exit.resolve({ code: 1, signal: null }); await host.close(); });
  vi.spyOn(f.runner, 'start').mockImplementation((...args) => host.start(...args));
  vi.spyOn(f.runner, 'resultCommitted').mockImplementation((turn) => host.resultCommitted(turn));
  const admission = await f.dispatcher.accept({ ...input('crashed-completion', f.id, 'other'), event: { kind: 'task_completed',
    task: { repositoryDirectory: f.repository, goalId: goal.id, taskName: 'task' }, result: { success: true, interrupted: false } } });
  accepted(admission);
  const initialization = await initialized.promise;
  child.emit('message', { protocolVersion: initialization.protocolVersion, launchId: initialization.launchId, kind: 'ready' });
  const start = await started.promise;
  exit.resolve({ code: 1, signal: null });
  const terminal = await finished.promise;
  expect(terminal).toMatchObject({ kind: 'turn_finished', outcome: { kind: 'failed' } });
  const saved = JSON.parse(await readFile(path, 'utf8')) as Goal;
  expect(saved.notifications).toEqual([expect.objectContaining({ id: admission.operationId, kind: 'blocked', severity: 'error' })]);
  expect(f.outputs).toHaveLength(outputCount);
  const snapshot = await f.conversations.snapshot(f.id);
  const items = [];
  for await (const item of snapshot.items) items.push(item);
  snapshot.complete();
  expect(items).toContainEqual(expect.objectContaining({ kind: 'display_event', event: expect.objectContaining({
    id: JSON.stringify([f.repository, goal.id, 'notification', admission.operationId]),
  }) }));
  if (terminal.kind !== 'turn_finished') throw new Error('Expected terminal turn result');
  await f.conversations.apply({ ...terminal.turn, event: start.event, outcome: terminal.outcome });
  expect((JSON.parse(await readFile(path, 'utf8')) as Goal).notifications).toHaveLength(1);
});

it.each(['read', 'write'] as const)('logs a notification %s failure and starts the next conversation turn', async (phase) => {
  const f = await fixture();
  const goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, phase === 'read' ? '{' : JSON.stringify(goal));
  const errors: string[] = [];
  const restore = installDaemonErrorLog(async (message) => { errors.push(message); });
  cleanups.push(async () => { restore(); });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const failure = new Error('notification save failed');
  const write = daemonPrivateFiles.writePrivateFile;
  if (phase === 'write') vi.spyOn(daemonPrivateFiles, 'writePrivateFile').mockImplementation(async (target, ...args) => {
    if (target === path) throw failure;
    return write(target, ...args);
  });
  accepted(await f.dispatcher.accept({ ...input('failed-completion', f.id, 'other'), event: { kind: 'task_completed',
    task: { repositoryDirectory: f.repository, goalId: goal.id, taskName: 'task' }, result: { success: true, interrupted: false } } }));
  const call = await f.runner.started(1);
  accepted(await f.post('next-turn'));
  await f.runner.finish(call, { kind: 'failed', message: 'process exited' });
  const next = await f.runner.started(2);
  expect(errors).toHaveLength(1);
  expect(next.input.event.eventId).toBe('next-turn');
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', operationId: call.turn.operationId }));
  await f.runner.finish(next);
});

it('waits for attachments, accepted turns and initializing IPC, then closes the runner when idle', async () => {
  const f = await fixture();
  accepted(await f.post('pending-turn'));
  const turn = await f.runner.started(1);
  f.input.detach(f.opened.attachmentId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(f.runner.closed).toBe(false);
  ipc.initializingCount = 1;
  try {
    await f.runner.finish(turn);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.runner.closed).toBe(false);
  } finally { ipc.initializingCount = 0; }
  await vi.waitFor(() => expect(f.runner.closed).toBe(true), { timeout: 3000 });
  await f.stopped;
  await f.close();
});

it.each(['paused-goal', 'pending-task', 'running-task', 'slack'] as const)('keeps an unattached daemon while %s remains and exits after it ends', async (kind) => {
  const slack = { listening: kind === 'slack', notifications: { async deliver() {} },
    delivery: { async deliver() { return { kind: 'delivered' as const }; } }, stopAccepting() {}, async close() {} };
  vi.spyOn(slackPorts, 'createDaemonSlackPorts').mockResolvedValue(slack);
  const goal = { ...goalRecord(), executionStatus: 'paused' as const };
  let workPath = '';
  const f = await fixture();
  const repository = f.repository;
  if (kind === 'paused-goal') {
    const path = join(repository, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    workPath = join(path, 'goal.json');
    await writeFile(workPath, JSON.stringify(goal));
  } else if (kind !== 'slack') {
    workPath = join(repository, '.takt', 'tasks.yaml');
    await writeFile(workPath, JSON.stringify({ tasks: [{ name: 'task', status: kind === 'pending-task' ? 'pending' : 'running',
      created_at: '2026-11-03T00:00:00Z', started_at: null, completed_at: null }] }));
  }
  f.input.detach(f.opened.attachmentId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(f.runner.closed).toBe(false);
  if (kind === 'paused-goal') await writeFile(workPath, JSON.stringify({ ...goal, executionStatus: 'aborted' }));
  else if (kind === 'slack') slack.listening = false;
  else await writeFile(workPath, '{"tasks":[]}');
  await vi.waitFor(() => expect(f.runner.closed).toBe(true), { timeout: 3000 });
  await f.close();
});

it.each([true, false])('defers a paused task result across restart and handles it once after resume (success: %s)', async (success) => {
  const f = await fixture();
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const goal = { ...goalRecord(), executionStatus: 'paused' as const };
  const goalPath = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(goalPath, '..'), { recursive: true });
  await writeFile(goalPath, JSON.stringify(goal));
  const files = new DaemonPersistedFiles(f.directory);
  const inbox = await files.inboxDirectory(f.repository);
  const target = { targetId: f.repository, generation: 'inbox', conversationId: f.id, kind: 'inbox' as const, directory: inbox };
  saveManagerEvent(f.repository, { kind: 'completion', goalId: goal.id, taskName: 'paused-task', runSlug: 'paused-run',
    result: { success, interrupted: false, workflowResult: success ? 'completed' : 'error', shaUnavailableReason: 'No commit' } });
  const completionPath = join(inbox, (await readdir(inbox))[0]!);
  await receiveInboxChange({ target, path: completionPath, removed: false, generation: 'completion', value: {} }, files, f.conversations, f.dispatcher);
  const completion = await f.runner.started(1);
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({ message: 'handled', summary: null, sessionId: 'session', assignment: undefined }));
  const resolve = vi.fn(async () => ({ provider: 'mock' as const, model: null, language: 'en' as const,
    contextKey: 'fixture', executor: { execute } }));
  const service = createConversationTurnService(f.directory, { resolve, async close() {} });
  const outcome = await service.execute(completion.input, { signal: completion.signal, progress() {},
    request: (request) => f.dispatcher.request(completion.turn, request, completion.signal) });
  expect(parseTurnProcessMessage({ protocolVersion: 1, launchId: 'paused', kind: 'turn_finished',
    turn: completion.turn, outcome }, 'paused')).toMatchObject({ kind: 'turn_finished', outcome: { kind: 'deferred' } });
  await f.runner.finish(completion, outcome);
  await f.dispatcher.retryStorage();
  await f.dispatcher.drain();
  expect(f.runner.calls).toHaveLength(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(await readdir(inbox)).toEqual([]);
  expect(f.outputs.filter((output) => output.kind === 'result' && output.operationId === completion.turn.operationId)).toEqual([]);
  const pending = [];
  for await (const value of (await new FileEventStore(f.directory).restore()).pending) pending.push(value);
  expect(pending).toEqual([{ state: 'queued', event: completion.input.event }]);
  await f.close();
  const runner = new ControlledTurnRunner();
  const restarted = await createDaemonDispatcher({ store: new FileEventStore(f.directory), conversations: f.conversations, runner,
    stateRequests: createDaemonStateRequests({ conversations: f.conversations,
      ingress: { accept: (event) => restarted.accept(event) }, connectedPorts: () => [] }),
    resources: { async close() {} }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 },
    onFailure({ error }) { throw error; } });
  runner.bus = restarted;
  cleanups.push(async () => { await restarted.control({ kind: 'stop' }); });
  const perform = async (call: Awaited<ReturnType<typeof runner.started>>) => {
    const outcome = await service.execute(call.input, { signal: call.signal, progress() {},
      request: (request) => restarted.request(call.turn, request, call.signal) });
    await runner.finish(call, outcome);
    return outcome;
  };
  expect(await perform(await runner.started(1))).toEqual({ kind: 'deferred' });
  expect(resolve).not.toHaveBeenCalled();
  accepted(await restarted.accept({ ...input('resume', f.id), event: { kind: 'human_command',
    speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'resume_goal', goalId: goal.id } } }));
  const resumeCommand = await runner.started(2);
  expect(resumeCommand.input.event.event).toMatchObject({ kind: 'human_command', command: { kind: 'resume_goal' } });
  expect(await perform(resumeCommand)).toMatchObject({ kind: 'completed', result: { kind: 'notice' } });
  const resumedPath = join(inbox, (await readdir(inbox))[0]!);
  await receiveInboxChange({ target, path: resumedPath, removed: false, generation: 'resume', value: {} }, files, f.conversations, restarted);
  const resumed = await runner.started(3);
  expect(resumed.input.event.event.kind).toBe('goal_resumed');
  await perform(resumed);
  const retried = await runner.started(4);
  expect(retried.input.event).toEqual(completion.input.event);
  await perform(retried);
  await restarted.retryStorage();
  await restarted.drain();
  expect(runner.calls).toHaveLength(4);
  const taskCalls = execute.mock.calls.filter(([input]) => input.prompt.includes(success ? 'task_completed' : 'task_failed'));
  expect(taskCalls).toHaveLength(1);
  expect(taskCalls[0]![0].prompt).toContain('paused-task');
  const remaining = [];
  for await (const value of (await new FileEventStore(f.directory).restore()).pending) remaining.push(value);
  expect(remaining).toEqual([]);
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
  const change = { operationId: 'session-save', expectedVersion: 0, session: { provider: 'mock', model: 'chosen', sessionId: 'kept',
    agentOverrides: { provider: 'mock' as const, model: 'chosen' } } };
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toEqual({ kind: 'state_saved', version: 1, duplicate: false });
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toEqual({ kind: 'state_saved', version: 1, duplicate: true });
  expect(await f.dispatcher.request(call.turn, { kind: 'notify_director', notificationId: randomUUID(), message: 'forged' }, call.signal)).toMatchObject({ kind: 'error', code: 'forbidden' });
  await f.runner.finish(call);
  expect(await f.dispatcher.request(call.turn, { kind: 'save_conversation', change }, call.signal)).toMatchObject({ kind: 'error', code: 'stale_turn' });
  expect((await new ConversationStateStore(f.directory).read(f.id))!.state.session).toEqual(change.session);
});

it('supplies Slack with the current workspace assignment after daemon startup', async () => {
  const ports = vi.spyOn(slackPorts, 'createDaemonSlackPorts');
  const f = await fixture(async (_directory, repository) => {
    await writeFile(join(repository, '.takt', 'config.yaml'), 'manager:\n  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0123]\n');
  });
  const repository = ports.mock.calls[0]![0].repositories[0]!;
  expect(await repository.resolveAssignment()).toMatchObject({ kind: 'repository', repositoryDirectory: f.repository });
  const workspace = { id: randomUUID(), name: 'new workspace', repositoryDirectories: [f.repository] };
  const path = join(f.directory, 'workspaces', workspace.id, 'workspace.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(workspace));
  expect(await repository.resolveAssignment()).toEqual({ kind: 'workspace', workspaceId: workspace.id,
    name: workspace.name, repositoryDirectories: workspace.repositoryDirectories });
  expect(await f.conversations.store.read(conversationId({ kind: 'workspace', workspaceId: workspace.id }))).toBeDefined();
});

it('settles interruption after a save commits before its reply reaches the child and resumes queued input after restart', async () => {
  const f = await fixture();
  accepted(await f.post('active'));
  const active = await f.runner.started(1);
  accepted(await f.post('waiting'));
  const committed = deferred<void>();
  const releaseReply = deferred<void>();
  const replied = deferred<void>();
  const envelope = { protocolVersion: 1 as const, launchId: 'shutdown-race' };
  const runtime = createTurnProcessRuntime({
    onFatal(error) { throw error; },
    createBusiness: () => ({ async close() {}, async execute(input, io) {
      const state = new TurnConversationState(input.state, io);
      try {
        await state.save({ proposal: { revision: state.current.revision + 1, pending: null } });
        throw new Error('Expected shutdown before reply');
      } catch (error) {
        if (!io.signal.aborted) throw error;
        return { kind: 'interrupted', change: state.change({ session: { ...state.current.session, sessionId: null } }) };
      }
    } }),
    transport: { async send(message) {
      if (message.kind === 'daemon_request') {
        const reply = await f.dispatcher.request(message.turn, message.request, new AbortController().signal);
        expect(reply).toMatchObject({ kind: 'state_saved', version: 1 });
        committed.resolve();
        await releaseReply.promise;
        await runtime.receive({ ...envelope, kind: 'daemon_reply', turn: message.turn, requestId: message.requestId, reply });
        replied.resolve();
      } else if (message.kind === 'turn_finished') {
        expect(message.outcome).toMatchObject({ kind: 'interrupted', change: { expectedVersion: 0 } });
        await f.runner.finish(active, message.outcome);
      }
    } },
  });
  await runtime.receive({ ...envelope, kind: 'initialize', conversationId: f.id, assignment: active.input.state.assignment, configDirectory: f.directory });
  f.runner.beforeClose = () => runtime.receive({ ...envelope, kind: 'shutdown' });
  await runtime.receive({ ...envelope, kind: 'start_turn', input: active.input });
  try {
    await committed.promise;
    expect((await f.conversations.store.read(f.id))?.state).toMatchObject({ version: 1, revision: 1 });
    await f.close();
  } finally { releaseReply.resolve(); }
  await replied.promise;
  const store = new FileEventStore(f.directory);
  const restored = await store.restore();
  const pending = []; for await (const item of restored.pending) pending.push(item);
  expect(pending).toMatchObject([{ state: 'queued', event: { eventId: 'waiting' } }]);
  const state = await f.conversations.store.read(f.id);
  expect(state?.state).toMatchObject({ version: 2, revision: 1, session: { sessionId: null } });
  const persisted = await Promise.all((await readdir(join(f.directory, 'daemon-events'))).filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(f.directory, 'daemon-events', name), 'utf8')) as { state: string; event: { eventId: string }; result: import('../core/daemon/messages.js').TurnResult }));
  const settled = persisted.find((record) => record.event.eventId === 'active')!;
  expect(settled.state).toBe('settled');
  await new ConversationStateStore(f.directory).apply(settled.result);
  expect((await f.conversations.store.read(f.id))?.state.version).toBe(2);
  const restarted = await fixture();
  const waiting = await restarted.runner.started(1);
  expect(waiting.input.event.eventId).toBe('waiting');
  expect(waiting.input.state.version).toBe(2);
  await restarted.runner.finish(waiting);
});

it('recovers the reserved goal ID after its registration event leaves the inbox and the child exits', async () => {
  const f = await fixture();
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const goal = goalRecord();
  const summary = { objective: goal.objective, outOfScope: goal.outOfScope, acceptanceCriteria: goal.acceptanceCriteria, constraints: goal.constraints };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  expect(await f.conversations.store.save({ conversationId: f.id, operationId: 'reserve', generation: 1 }, {
    operationId: 'reserved-goal', expectedVersion: 0, proposal: { revision: 1, pending: { revision: 1, repositoryDirectory: f.repository, summary } },
    approval: { state: 'reserved', revision: 1, goalId: goal.id, repositoryDirectory: f.repository },
  }, new AbortController().signal)).toMatchObject({ kind: 'state_saved' });
  const files = new DaemonPersistedFiles(f.directory);
  const inbox = await files.inboxDirectory(f.repository); await mkdir(inbox, { recursive: true });
  const eventPath = join(inbox, 'registered.json');
  await writeFile(eventPath, JSON.stringify({ kind: 'registered', goalId: goal.id, createdAt: '2026-11-03T00:00:00Z' }));
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  const target = (await source.directories()).find((target) => target.kind === 'inbox')!;
  await receiveInboxChange({ target, path: eventPath, removed: false, generation: 'registration', value: {} }, files, f.conversations, f.dispatcher);
  const registration = await f.runner.started(1);
  expect(await readdir(inbox)).toEqual([]);
  expect((await f.conversations.store.read(f.id))?.state.approval?.state).toBe('reserved');
  await f.runner.finish(registration, { kind: 'interrupted' });
  accepted(await f.dispatcher.accept({ ...input('reapprove', f.id), event: { kind: 'human_command',
    speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'approve_summary', revision: 1 } } }));
  const retry = await f.runner.started(2);
  const resolve = vi.fn();
  const service = createConversationTurnService(f.directory, { resolve, async close() {} });
  const outcome = await service.execute(retry.input, { signal: retry.signal, progress() {},
    request: (request) => f.dispatcher.request(retry.turn, request, retry.signal) });
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'goal_registered', goal: { id: goal.id } } });
  await f.runner.finish(retry, outcome);
  expect((await f.conversations.store.read(f.id))?.state.approval).toMatchObject({ state: 'registered', goalId: goal.id });
  expect(await readdir(join(f.repository, '.takt', 'goals'))).toEqual([goal.id]);
  expect(resolve).not.toHaveBeenCalled();
});

it.each<TurnOutcome>([
  { kind: 'completed', result: { kind: 'reply', message: 'checked' } },
  { kind: 'failed', message: 'failed' },
  { kind: 'interrupted' },
])('includes the operation ID in the director result notification: $kind', async (outcome) => {
  const f = await fixture();
  const director = conversationId({ kind: 'daemon' });
  accepted(await f.dispatcher.accept(input('director-turn', director)));
  const call = await f.runner.started(1);
  expect(await f.dispatcher.request(call.turn, { kind: 'get_delivery', conversationId: f.id }, call.signal)).toMatchObject({ kind: 'delivery', conversationId: f.id, connectedPorts: ['tui'] });
  const request = { kind: 'accept_director_message' as const, conversationId: f.id, eventId: 'director-input', requestId: 'director-input', text: 'inspect', occurredAt: '2026-11-03T00:00:00Z' };
  expect(await f.dispatcher.request(call.turn, request, call.signal)).toMatchObject({ kind: 'event_accepted', admission: { kind: 'accepted' } });
  const manager = await f.runner.started(2);
  await f.runner.finish(manager, outcome);
  const saved = [];
  for await (const notice of f.conversations.notifications.iterate()) saved.push(notice);
  expect(saved).toMatchObject([{ id: `result-${manager.turn.operationId}`, message: expect.stringContaining(manager.turn.operationId) }]);
  await f.conversations.apply({ ...manager.turn, event: manager.input.event, outcome });
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

it('reads legacy proposal, session and accepted human/director queues while preserving hidden patrol history', async () => {
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
  expect(items.filter((item) => item.kind === 'display_event')).toEqual([]);
  expect(items).toContainEqual({ kind: 'goal', goal: { id: goal.id, objective: goal.objective, status: goal.status,
    executionStatus: goal.executionStatus, repositoryDirectory: f.repository } });
  expect(JSON.parse(await readFile(join(f.repository, '.takt', 'goals', goal.id, 'goal.json'), 'utf8'))).toEqual(goal);
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
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
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

it('releases pending goal reads before awaiting watcher shutdown', async () => {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  const goal = goalRecord();
  await mkdir(join(repository, '.takt', 'goals', goal.id), { recursive: true });
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const entered = deferred<void>();
  let rejectRead!: (error: Error) => void;
  const pending = new Promise<WatchGoal>((_resolve, reject) => { rejectRead = reject; });
  vi.spyOn(WatchGoalReader.prototype, 'read').mockImplementation(() => { entered.resolve(); return pending; });
  const closeReader = WatchGoalReader.prototype.close;
  const close = vi.spyOn(WatchGoalReader.prototype, 'close').mockImplementation(async function (this: WatchGoalReader) {
    rejectRead(new Error('reader closed'));
    await closeReader.call(this);
  });
  const restoreErrorLog = installDaemonErrorLog(async () => {});
  const daemon = await startDaemon({ configDirectory: directory,
    owner: { pid: process.pid, identity: { startTime: 'pending-goal' }, version: 'test', cliPath: '/daemon.js' },
    tokens: undefined, signal: new AbortController().signal, runnerFactory: () => new ControlledTurnRunner() });
  await entered.promise;
  const closing = daemon.close();
  try {
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 2000 });
    await closing;
  } finally {
    rejectRead(new Error('test cleanup'));
    await closing;
    restoreErrorLog();
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

it('observes every running task when one saved worktree path is empty', async () => {
  const f = await fixture();
  const goal = goalRecord();
  const goalDirectory = join(f.repository, '.takt', 'goals', goal.id);
  await mkdir(goalDirectory, { recursive: true });
  await writeFile(join(goalDirectory, 'goal.json'), JSON.stringify(goal));
  const startedAt = '2026-11-03T00:00:00Z';
  const tasks = ['empty-worktree', 'no-worktree'].map((name) => ({
    name, status: 'running', goal_id: goal.id, run_slug: name,
    created_at: startedAt, started_at: startedAt, completed_at: null,
    ...(name === 'empty-worktree' ? { worktree_path: '' } : {}),
  }));
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks }));
  for (const task of tasks) {
    const logs = join(f.repository, '.takt', 'runs', task.run_slug, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'run.jsonl'), '{}\n');
  }
  expect(await readWatchTasks(f.repository)).toHaveLength(2);
  const errors = vi.fn();
  const source = createWatchSource(f.conversations, async () => {}, errors);
  expect(await source.runs()).toMatchObject(tasks.map((task) => ({
    task: { taskName: task.name },
  })));
  expect(errors).not.toHaveBeenCalled();
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
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  await source.inquiries();
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
  const source = () => createWatchSource(f.conversations, (notice) => f.dispatcher.inquiry(notice), (error) => { throw error; },
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
  await f.runner.finish(second);
  await writeFile(path, JSON.stringify({ ...goal, questions: [{ id: randomUUID(), body: 'question', status: 'pending', recipient: 'human' }] }));
  await source().inquiries(); await f.runner.started(3);
  await source().inquiries(); expect(f.runner.calls).toHaveLength(3);
});

const completedGoal = (goal: Goal): Partial<Goal> => ({ status: 'completed', completion: { goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: 'main',
  targetSha: 'b'.repeat(40), summary: 'Done', instructions: [],
  changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } } });
it.each([completedGoal, (): Partial<Goal> => ({ executionStatus: 'aborted' })])('records a settled goal without a director turn when first seen (case %#) and admits its later change', async (settled) => {
  const f = await fixture();
  const base = goalRecord();
  const goal: Goal = { ...base, ...settled(base) };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  const source = () => createWatchSource(f.conversations, async () => {}, (error) => { throw error; },
    new WatchObservations(new FileWatchRecords(f.directory), f.dispatcher, Date.now));
  await source().inquiries(); await source().inquiries();
  const blocked = randomUUID();
  await writeFile(path, JSON.stringify({ ...goal, notifications: [{ id: blocked, kind: 'blocked', body: '作業が停止', recordedAt: '2026-11-03T00:00:00Z' }] }));
  await source().inquiries();
  const call = await f.runner.started(1);
  expect(call.input.event.event).toMatchObject({ kind: 'watch_observation', observation: { kind: 'director_state_changed', goalId: goal.id } });
  const event = call.input.event.event;
  if (event.kind !== 'watch_observation' || event.observation.kind !== 'director_state_changed') throw new Error('Unexpected event');
  expect(JSON.parse(event.observation.state)).toMatchObject({ blockedNotifications: [blocked] });
  await f.runner.finish(call);
  await source().inquiries();
  expect(f.runner.calls).toHaveLength(1);
});

it('admits a director event for each new blocked notification and deduplicates it across restart', async () => {
  const f = await fixture();
  const goal: Goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  const source = () => createWatchSource(f.conversations, async () => {}, (error) => { throw error; },
    new WatchObservations(new FileWatchRecords(f.directory), f.dispatcher, Date.now));
  await source().inquiries(); await f.runner.finish(await f.runner.started(1));
  for (let index = 0; index < 2; index++) {
    goal.notifications = [...(goal.notifications ?? []), { id: randomUUID(), kind: 'blocked', body: '作業が停止', recordedAt: '2026-11-03T00:00:00Z' }];
    await writeFile(path, JSON.stringify(goal));
    await source().inquiries();
    const call = await f.runner.started(index + 2);
    expect(call.turn.conversationId).toBe(conversationId({ kind: 'daemon' }));
    expect(call.input.event.event).toMatchObject({ kind: 'watch_observation', observation: { kind: 'director_state_changed', goalId: goal.id } });
    await f.runner.finish(call);
    await source().inquiries();
    expect(f.runner.calls).toHaveLength(index + 2);
  }
});

it.each(['run', undefined])('watches a running PID without a start time and accepts its loss and completion (slug: %s)', async (runSlug) => {
  const f = await fixture();
  const timestamp = '2026-11-03T00:00:00Z'; const goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks: [{ name: 'windows-run', status: 'running',
    goal_id: goal.id, run_slug: runSlug, execution_id: 'execution', owner_pid: 12345, owner_start_time: null, created_at: timestamp, started_at: timestamp, completed_at: null }] }));
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  const targets = await source.runs();
  expect(targets).toMatchObject([{ owner: { pid: 12345, startTime: null }, task: { executionId: 'execution' } }]);
  const target = targets[0]!;
  expect(target.task.runSlug).toBe(runSlug);
  const checks = new WatchChecks(new WatchObservations(new FileWatchRecords(f.directory), f.dispatcher, Date.now), Date.now,
    (_target, error) => { throw error; }, 'process');
  await checks.process(target, { inspect: async () => ({ kind: 'dead' }) }, { signal: new AbortController().signal, timeoutMs: 1000 }, () => source.run(target.targetId));
  const lost = await f.runner.started(1);
  expect(lost.input.event.event).toMatchObject({ kind: 'watch_observation', observation: { kind: 'run_process_lost',
    task: { executionId: 'execution' }, pid: 12345, startTime: null } });
  if (lost.input.event.event.kind !== 'watch_observation' || lost.input.event.event.observation.kind !== 'run_process_lost') throw new Error('Expected process loss');
  expect(lost.input.event.event.observation.task.runSlug).toBe(runSlug);
  expect(parseDaemonProcessMessage({ protocolVersion: 1, launchId: 'watch', kind: 'start_turn', input: lost.input }, 'watch')).toMatchObject({ kind: 'start_turn' });
  await f.runner.finish(lost);
  saveManagerEvent(f.repository, { kind: 'completion', goalId: goal.id, taskName: 'windows-run', runSlug,
    result: { success: false, interrupted: true, workflowResult: 'error', failureReason: 'Process lost', shaUnavailableReason: 'Process lost' } });
  const files = new DaemonPersistedFiles(f.directory);
  const inbox = await files.inboxDirectory(f.repository);
  const inboxTarget = (await source.directories()).find((target) => target.kind === 'inbox')!;
  const [name] = await readdir(inbox);
  await receiveInboxChange({ target: inboxTarget, path: join(inbox, name!), removed: false, generation: 'completion', value: {} }, files, f.conversations, f.dispatcher);
  const completion = await f.runner.started(2);
  expect(completion.input.event.event).toMatchObject({ kind: 'task_failed', task: { taskName: 'windows-run' }, result: { interrupted: true } });
  if (completion.input.event.event.kind !== 'task_failed') throw new Error('Expected task failure');
  expect(completion.input.event.event.task.runSlug).toBe(runSlug);
  expect(parseDaemonProcessMessage({ protocolVersion: 1, launchId: 'completion', kind: 'start_turn', input: completion.input }, 'completion')).toMatchObject({ kind: 'start_turn' });
  await f.runner.finish(completion);
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

it.each([
  { kind: 'reply' as const, message: 'completed before restart' },
  { kind: 'error' as const, code: 'operation_failed', message: 'failed before restart' },
  { kind: 'error' as const, code: 'interrupted', message: 'interrupted before restart' },
])('reuses a saved legacy director result before retiring running: $kind', async (savedResult) => {
  const operationId = randomUUID();
  const directorConversationId = conversationId({ kind: 'daemon' });
  const f = await fixture(async (directory, repository) => {
    const record = conversationRecord(repository);
    record.lastSpeaker = { namespace: 'agent', id: 'director' };
    record.running = { operationId, kind: 'message', directorConversationId,
      owner: { pid: 123, identity: { startTime: 'old' } } };
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', `${record.id}.json`), JSON.stringify(record));
    await mkdir(join(directory, 'director-message-results'), { recursive: true });
    await writeFile(join(directory, 'director-message-results', `${operationId}.json`), JSON.stringify({
      operationId, conversationId: record.id, directorConversationId, result: savedResult,
    }));
  });
  expect(f.runner.calls).toHaveLength(0);
  expect((await f.conversations.store.read(f.id))?.record.running).toBeNull();
  const names = await readdir(join(f.directory, 'daemon-events'));
  const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) =>
    JSON.parse(await readFile(join(f.directory, 'daemon-events', name), 'utf8')) as unknown));
  expect(records).toContainEqual(expect.objectContaining({ state: 'settled', result: expect.objectContaining({
    operationId, outcome: { kind: 'completed', result: savedResult },
  }) }));
  await restoreLegacyConversations(f.conversations, new FileEventStore(f.directory));
  const notices = []; for await (const notice of f.conversations.notifications.iterate()) notices.push(notice);
  expect(notices).toEqual([{ id: `result-${operationId}`, message: expect.stringContaining(savedResult.message) }]);
  expect(notices[0]?.message).toContain(operationId);
});

it('seeds existing goal and standalone inquiries without publishing and publishes only subsequent changes', async () => {
  const f = await fixture();
  const question = { id: randomUUID(), body: 'existing', status: 'pending', recipient: 'human' };
  const goal = { ...goalRecord(), questions: [question] };
  const goalPath = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(goalPath, '..'), { recursive: true });
  await writeFile(goalPath, JSON.stringify(goal));
  const inquiryDirectory = join(f.directory, 'projects', projectKey(f.repository), 'inquiries');
  await mkdir(inquiryDirectory, { recursive: true });
  const standalone = { ...question, id: randomUUID() };
  await writeFile(join(inquiryDirectory, `${standalone.id}.json`), JSON.stringify(standalone));
  const publish = vi.fn(async () => {});
  const source = createWatchSource(f.conversations, publish, (error) => { throw error; });
  await source.inquiries();
  await source.inquiries();
  expect(publish).not.toHaveBeenCalled();
  const next = { ...question, id: randomUUID(), body: 'new' };
  await writeFile(goalPath, JSON.stringify({ ...goal, questions: [question, next] }));
  await source.inquiries();
  expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ question: expect.objectContaining({ id: next.id }) }));
  await source.inquiries();
  await createWatchSource(f.conversations, publish, (error) => { throw error; }).inquiries();
  expect(publish).toHaveBeenCalledOnce();
});

it('observes tasks and goals above 256 KiB without excluding runs, PRs or inquiries', async () => {
  const f = await fixture();
  const timestamp = '2026-11-03T00:00:00Z';
  const question = { id: randomUUID(), body: 'pending', status: 'pending', recipient: 'human' };
  const goal = { ...goalRecord(), status: 'awaiting_merge', questions: [question], createdAt: timestamp,
    pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
    workLog: Array.from({ length: 3 }, () => ({ id: randomUUID(), kind: 'patrol', summary: 'x'.repeat(100_000), recordedAt: timestamp })),
  };
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), JSON.stringify({ tasks: [{
    name: 'running', content: 'x'.repeat(300_000), status: 'running', goal_id: goal.id, run_slug: 'run',
    created_at: timestamp, started_at: timestamp, completed_at: null,
  }] }));
  const errors = vi.fn();
  const source = createWatchSource(f.conversations, async () => {}, errors);
  expect(await source.runs()).toMatchObject([{ task: { goalId: goal.id } }]);
  expect(await source.pullRequests()).toMatchObject([{ goalId: goal.id }]);
  await source.inquiries();
  expect(errors).not.toHaveBeenCalled();
});

it('continues monitoring later repositories after an unreadable tasks file', async () => {
  const f = await fixture(); const other = join(f.directory, 'z-other');
  await mkdir(join(other, '.takt'), { recursive: true });
  await registerProject({ globalConfigDirectory: f.directory, projectDirectory: other, command: 'manager', managerUsed: true });
  const timestamp = '2026-11-03T00:00:00Z';
  const goal = { ...goalRecord(), createdAt: timestamp };
  const path = join(other, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  await writeFile(join(f.repository, '.takt', 'tasks.yaml'), 'tasks: [broken');
  const tasks = ['running', 'pending'].map((status) => ({ name: status, status, goal_id: goal.id,
    ...(status === 'running' ? { run_slug: 'run' } : {}), created_at: timestamp, started_at: null, completed_at: null }));
  await writeFile(join(other, '.takt', 'tasks.yaml'), JSON.stringify({ tasks }));
  const errors = vi.fn(); const source = createWatchSource(f.conversations, async () => {}, errors);
  expect(await source.runs()).toMatchObject([{ task: { repositoryDirectory: other } }]);
  expect(await source.launches()).toMatchObject([{ repositoryDirectory: other }]);
  expect(errors).toHaveBeenCalledTimes(2);
});

it('excludes awaiting-merge goals from patrol and resolves project, global and default intervals', async () => {
  const f = await fixture();
  const source = createWatchSource(f.conversations, async () => {}, (error) => { throw error; });
  const active = goalRecord();
  const awaiting = { ...active, id: randomUUID(), status: 'awaiting_merge' as const,
    completion: { goalBranch: active.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
    pullRequest: { number: 1, url: 'https://github.com/test/repo/pull/1' } };
  const goals = [active, awaiting, { ...active, id: randomUUID(), executionStatus: 'paused' },
    { ...active, id: randomUUID(), executionStatus: 'aborted' }, { ...awaiting, id: randomUUID(), status: 'completed', completion: { ...awaiting.completion, targetSha: 'b'.repeat(40) } }];
  for (const goal of goals) {
    const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  }
  expect(await source.patrols()).toEqual([{ conversationId: f.id, repositoryDirectory: f.repository,
    intervalSeconds: 1800 }]);
  expect(await source.patrolGoalIds(f.repository)).toEqual([active.id]);
  expect(await source.pullRequests()).toMatchObject([{ goalId: awaiting.id }]);
  await writeFile(join(f.repository, '.takt', 'goals', active.id, 'goal.json'), JSON.stringify({ ...active, executionStatus: 'paused' }));
  expect(await source.patrolGoalIds(f.repository)).toEqual([]);
  await writeFile(join(f.directory, 'config.yaml'), 'manager:\n  patrol_interval: 900\n');
  expect((await source.patrols())[0]!.intervalSeconds).toBe(900);
  await writeFile(join(f.repository, '.takt', 'config.yaml'), 'manager:\n  patrol_interval: 60\n');
  expect((await source.patrols())[0]!.intervalSeconds).toBe(60);
});

it('delivers one patrol result to the connected TUI without displaying inspection work records again', async () => {
  const f = await fixture();
  vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockResolvedValue(undefined);
  const goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(goal));
  const message = '見回り: ゴール 1 件、異常なし';
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => {
    await writeFile(path, JSON.stringify({ ...goal, workLog: [{ id: randomUUID(), recordedAt: new Date().toISOString(),
      kind: 'patrol', summary: 'Detailed inspection of run records' }] }));
    return { message, summary: null, sessionId: 'patrol-session', assignment: undefined };
  });
  const service = createConversationTurnService(f.directory, { async resolve() {
    return { provider: 'mock', model: null, language: 'ja', contextKey: 'patrol', executor: { execute } };
  }, async close() {} });
  await f.dispatcher.accept({ ...input('patrol-result', f.id, 'other'), event: {
    kind: 'patrol', repositoryDirectory: f.repository, goalIds: [goal.id] } });
  const turn = await f.runner.started(1);
  const outcome = await service.execute(turn.input, { signal: turn.signal, progress() {},
    request: (request) => f.dispatcher.request(turn.turn, request, turn.signal) });
  await f.runner.finish(turn, outcome);
  await f.conversations.close();
  expect(f.outputs.filter((output) => output.kind === 'result')).toEqual([
    { kind: 'result', operationId: turn.turn.operationId, result: { kind: 'reply', message } },
  ]);
  const snapshot = await f.conversations.snapshot(f.id);
  const messages: string[] = [];
  for await (const item of snapshot.items) if (item.kind === 'display_event') messages.push(item.event.message);
  snapshot.complete();
  expect(messages).toEqual([]);
  expect(await readdir(join(f.directory, 'director-notifications')).catch(() => [])).toEqual([]);
});

it('interrupts a patrol for TUI input without delivering partial patrol output', async () => {
  const f = await fixture();
  accepted(await f.dispatcher.accept({ ...input('patrol-interrupted', f.id, 'other'), source: 'daemon', event: {
    kind: 'patrol', repositoryDirectory: f.repository, goalIds: [randomUUID()] } }));
  const patrol = await f.runner.started(1);
  await f.runner.progress(patrol, 'partial inspection');
  const submission = await f.input.submit({ attachmentId: f.opened.attachmentId, requestId: 'human-during-patrol',
    speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'message', text: 'human message' } });
  expect(submission.kind).toBe('accepted');
  expect(patrol.signal.aborted).toBe(true);
  expect(f.runner.calls).toHaveLength(1);
  await f.runner.progress(patrol, 'late inspection');
  await f.runner.finish(patrol, { kind: 'completed', result: { kind: 'reply', message: 'partial patrol result' } });
  const human = await f.runner.started(2);
  expect(human.input.event.event).toMatchObject({ kind: 'human_command', command: { kind: 'message', text: 'human message' } });
  await f.runner.finish(human, { kind: 'completed', result: { kind: 'reply', message: 'human reply' } });
  await f.conversations.close();
  expect(f.outputs.filter((output) => output.kind === 'progress')).toEqual([]);
  expect(f.outputs.filter((output) => output.kind === 'result')).toEqual([
    { kind: 'result', operationId: patrol.turn.operationId, result: { kind: 'error', code: 'interrupted', message: expect.any(String) } },
    { kind: 'result', operationId: human.turn.operationId, result: { kind: 'reply', message: 'human reply' } },
  ]);
  expect(f.dispatcher.hasPendingEvents).toBe(false);
  expect(f.runner.calls).toHaveLength(2);
});

it('marks work records from a patrol tool call even when the model omits kind', async () => {
  const f = await fixture();
  const goal = goalRecord();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createTaktMcpServer } = await import('../features/mcp/server.js');
  let patrol = true;
  const server = createTaktMcpServer({}, { allowedProjectRoot: f.repository,
    conversationTurn: () => ({ operationId: randomUUID(), directorMessage: false, patrol }) });
  const client = new Client({ name: 'patrol-record-test', version: 'test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    for (const summary of ['Inspection details', 'Real progress']) {
      const result = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: f.repository, goalId: goal.id, summary } });
      expect(result.isError).not.toBe(true);
      patrol = false;
    }
    const saved = JSON.parse(await readFile(path, 'utf8')) as Goal;
    expect(saved.workLog.map((entry) => entry.kind)).toEqual(['patrol', undefined]);
  } finally { await client.close(); await server.close(); }
});

it('delivers a saved PR publication failure through inbox admission to the manager', async () => {
  const goal = goalRecord();
  const f = await fixture();
  const path = join(f.repository, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ ...goal, pullRequestFailure: { error: 'old failure' } }));
  const failure = { kind: 'pr_failed' as const, goalId: goal.id, expectedSha: 'a'.repeat(40), reason: 'push failed' };
  saveManagerEvent(f.repository, failure);
  const files = new DaemonPersistedFiles(f.directory);
  expect(await files.readGoal(f.repository, goal.id)).toEqual(goal);
  const inbox = await files.inboxDirectory(f.repository);
  const names = await readdir(inbox);
  expect(names).toHaveLength(1);
  const target = { targetId: f.repository, generation: 'inbox', conversationId: f.id, kind: 'inbox' as const, directory: inbox };
  await receiveInboxChange({ path: join(inbox, names[0]!), target, generation: 'failure', value: null, removed: false },
    files, f.conversations, f.dispatcher);
  const turn = await f.runner.started(1);
  expect(turn.input.event.event).toEqual({ kind: 'goal_pr_failed', repositoryDirectory: f.repository,
    goalId: goal.id, expectedSha: failure.expectedSha, reason: failure.reason });
  expect(await readdir(inbox)).toEqual([]);
  await f.runner.finish(turn);
});
