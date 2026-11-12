import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDaemonDispatcher } from '../features/daemon/dispatcher.js';
import { createTurnProcessHost } from '../features/daemon/turnProcessHost.js';
import { createTurnProcessRuntime } from '../features/daemonTurn/processRuntime.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { runFormalSpecVerification } from '../features/interactive/formalSpecVerification.js';
import type { FormalSpecVerificationResult } from '../features/interactive/formalSpecVerification.js';
import type { DaemonProcessMessage, TurnProcessMessage } from '../core/daemon/processProtocol.js';
import type { DaemonStateOwner } from '../core/daemon/ports.js';
import type { TurnOutcome } from '../core/daemon/messages.js';
import type { AgentResponse } from '../core/models/response.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { ManagedProcess } from '../shared/utils/spawn.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { deferred, input } from './helpers/controlledDaemon.js';
import { makeProvider } from './test-helpers.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn(), repository: '' }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
vi.mock('../infra/daemon/process.js', () => ({
  readProcessOwner: async (pid: number) => ({ pid, startTime: 'test-process-start' }),
  observeProcess: async (owner: { pid: number }) => ({ kind: 'alive', owner }),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemonTurn/turnContext.js', () => ({ buildTurnBusinessContext: async () => 'saved goal context' }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: async () => ({ kind: 'repository', repositoryDirectory: doubles.repository, repositoryDirectories: [doubles.repository] }),
}));
vi.mock('../features/interactive/formalSpecVerification.js', async (original) => ({
  ...await original<typeof import('../features/interactive/formalSpecVerification.js')>(), runFormalSpecVerification: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(mode: boolean, verdict?: 'failed' | 'error') {
  const directory = await mkdtemp(join(tmpdir(), 'takt-verify-interruption-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository');
  doubles.repository = repository;
  await mkdir(join(repository, '.takt'), { recursive: true });
  await writeFile(join(repository, '.takt/config.yaml'), `language: en\nassistant:\n  formal_spec: ${mode}\n`);
  const state = new ConversationStateStore(directory);
  const record = { ...conversationRecord(repository), provider: 'mock', model: null, pending: null, approval: null,
    interruptedMessage: 'Previously interrupted requirements' };
  await state.create(record);
  const eventStore = new FileEventStore(directory);
  const saveResult = vi.spyOn(eventStore, 'saveResult');
  const received: Array<{ id: string; output: PortOutput }> = [];
  const failures = vi.fn();
  const conversations = new DaemonConversations(state, new DaemonRouting(directory), new DaemonNotifications(directory),
    async (id, output) => { received.push({ id, output }); }, failures);
  const progress = vi.spyOn(conversations, 'progress');
  const artifacts = { runDirectory: join(repository, '.takt/runs/verify-test'),
    specifications: { quint: join(repository, '.takt/runs/verify-test/spec.qnt') },
    logs: { quint: { stdout: join(repository, '.takt/runs/verify-test/stdout.log'), stderr: join(repository, '.takt/runs/verify-test/stderr.log') } } };
  const verification: FormalSpecVerificationResult = { verdict: verdict ?? 'failed', verificationStarted: true,
    quint: { status: verdict ?? 'failed', message: 'Checker diagnostic' }, alloy: { status: 'passed' },
    artifacts, artifactRetention: { status: 'passed' } };
  await mkdir(artifacts.runDirectory, { recursive: true });
  await writeFile(artifacts.specifications.quint, 'module csv {}');
  await writeFile(artifacts.logs.quint.stdout, 'Checker diagnostic');
  await writeFile(artifacts.logs.quint.stderr, '');
  vi.mocked(runFormalSpecVerification).mockResolvedValue(verification);
  const call = vi.fn<ProviderAgent['call']>();
  call.mockImplementation(async (_prompt, options) => {
    if (verdict !== undefined && call.mock.calls.length === 1) return {
      persona: 'manager', status: 'done', content: '```quint\nmodule csv {}\n```', timestamp: new Date(),
    };
    options.onStream?.({ type: 'thinking', data: { thinking: 'working' } });
    return new Promise<AgentResponse>((_resolve, reject) => {
      options.abortSignal!.addEventListener('abort', () => reject(options.abortSignal!.reason), { once: true });
    });
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  const business = createConversationTurnService(directory, { resolve: async () => ({ executor, provider: 'mock', model: null, language: 'en', contextKey: 'manager' }),
    close: async () => {} });
  const blocked = deferred<'turn_progress' | 'turn_finished'>();
  const release = deferred<void>();
  const finalQueued = deferred<TurnOutcome>();
  const committed = deferred<void>();
  const child = Object.assign(new EventEmitter(), { connected: true }) as ChildProcess;
  const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const runtime = createTurnProcessRuntime({ createBusiness: () => ({ ...business, close: async () => {} }), onFatal: failures, transport: {
    async send(message: TurnProcessMessage) {
      if (message.kind === 'turn_progress' || message.kind === 'turn_finished') {
        blocked.resolve(message.kind);
        if (message.kind === 'turn_finished') finalQueued.resolve(message.outcome);
        await release.promise;
      }
      child.emit('message', message);
      if (message.kind === 'shutdown_complete') exit.resolve({ code: 0, signal: null });
    },
  } });
  child.send = vi.fn((value: unknown, callback: unknown) => {
    const message = value as DaemonProcessMessage;
    void runtime.receive(message).then(() => { if (message.kind === 'result_committed') committed.resolve(); }, failures);
    (callback as (error: Error | null) => void)(null);
    return true;
  }) as typeof child.send;
  const managed: ManagedProcess = { child, wait: () => exit.promise, waitForExit: () => exit.promise,
    terminate: async () => { exit.resolve({ code: null, signal: 'SIGTERM' }); } };
  doubles.spawn.mockReturnValue(managed);
  let dispatcher: Awaited<ReturnType<typeof createDaemonDispatcher>>;
  const host = createTurnProcessHost({ configDirectory: directory, onError: failures,
    bus: { post: (message) => dispatcher.post(message), request: (...args) => dispatcher.request(...args) } });
  const requests: DaemonStateOwner = { handle: async (turn, request, signal) => {
    if (request.kind !== 'save_conversation') throw new Error('Unexpected state request');
    return state.save(turn, request.change, signal);
  } };
  dispatcher = await createDaemonDispatcher({ store: eventStore, runner: host, conversations, stateRequests: requests,
    resources: { close: () => conversations.close() }, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 }, onFailure: failures });
  cleanups.push(async () => { release.resolve(); await dispatcher.control({ kind: 'stop' }); });
  await dispatcher.accept({ ...input('verify', record.id), event: { kind: 'human_command', speaker: { namespace: 'test', id: 'operator' },
    command: { kind: 'message', text: '/verify' } } });
  const queued = await blocked.promise;
  const snapshot = await dispatcher.snapshot(record.id);
  const identity = { conversationId: record.id, operationId: snapshot.operationId!, generation: snapshot.generation! };
  snapshot.cancel();
  return { dispatcher, record, state, call, received, failures, verification, saveResult, progress, queued, finalQueued,
    interrupt: () => dispatcher.control({ kind: 'interrupt', ...identity }), release: () => release.resolve(), committed: committed.promise };
}

it.each([true, false])('preserves undelivered requirements through daemon settlement when /verify is interrupted with mode=%s', async (mode) => {
  const f = await fixture(mode);
  expect(f.queued).toBe(mode ? 'turn_progress' : 'turn_finished');
  expect(await f.interrupt()).toEqual({ kind: 'interrupted' });
  await f.finalQueued.promise;
  f.release();
  await f.committed;
  expect((await f.state.read(f.record.id))!.state.interruptedMessage).toBe(f.record.interruptedMessage);
  expect(f.saveResult).toHaveBeenCalledOnce();
  expect(f.saveResult.mock.calls[0]![1].outcome).toEqual({ kind: 'interrupted' });
  expect(f.call).toHaveBeenCalledTimes(mode ? 1 : 0);
  expect(runFormalSpecVerification).not.toHaveBeenCalled();
  expect(f.failures).not.toHaveBeenCalled();
});

it.each(['failed', 'error'] as const)('delivers the retained %s checker result after delayed IPC is released following interruption', async (verdict) => {
  const f = await fixture(true, verdict);
  expect(f.queued).toBe('turn_progress');
  expect(runFormalSpecVerification).toHaveBeenCalledOnce();
  expect(f.received.some(({ output }) => output.kind === 'result')).toBe(false);
  expect(await f.interrupt()).toEqual({ kind: 'interrupted' });
  const queued = await f.finalQueued.promise;
  expect(queued.kind).toBe('interrupted');
  f.release();
  await f.committed;
  const delivered = f.received.find(({ output }) => output.kind === 'result')!;
  expect(delivered.id).toBe(f.record.id);
  expect(delivered.output.kind).toBe('result');
  if (delivered.output.kind !== 'result' || delivered.output.result.kind !== 'error') throw new Error('Expected interrupted result');
  expect(delivered.output.result.code).toBe('interrupted');
  const message = delivered.output.result.message;
  expect(message).toContain(f.verification.artifacts!.runDirectory);
  expect(JSON.parse(message.match(/```json\n([\s\S]*?)\n```/)![1]!)).toEqual(f.verification);
  expect(f.progress).not.toHaveBeenCalled();
  expect(f.saveResult.mock.calls[0]![1].outcome).toEqual({ kind: 'interrupted', message });
  expect((await f.state.read(f.record.id))!.state.interruptedMessage).toBe(f.record.interruptedMessage);
  expect(await readFile(f.verification.artifacts!.specifications.quint!, 'utf8')).toBe('module csv {}');
  expect(f.failures).not.toHaveBeenCalled();
});
