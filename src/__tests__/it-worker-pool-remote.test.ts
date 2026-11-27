import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { TaskDispatcher } from '../features/daemon/taskDispatcher.js';
import { RemoteWorkerRuntime } from '../features/workerPool/remoteWorkerRuntime.js';
import * as privateFile from '../infra/daemon/privateFile.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { RemoteExecutionStore } from '../infra/task/remoteExecutionStore.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { WorkerRegistry } from '../infra/worker-pool/workerRegistry.js';
import { listTaktTasks, getTaktRun, tellTaktRun } from '../features/mcp/operations.js';
import { stopTaktGoalTask } from '../features/mcp/goalTaskStopOperations.js';
import { pauseTaktGoal, abortTaktGoal } from '../features/mcp/goalExecutionOperations.js';
import { requeueTaktGoalTask, retryTaktGoalTask } from '../features/mcp/goalTaskRetryOperations.js';
import { removeTaktGoalTask } from '../features/mcp/goalTaskRemovalOperations.js';
import { mergeTaktGoalTask } from '../features/mcp/goalIntegrationOperations.js';
import { packageVersion } from '../shared/package-info.js';
import { RemoteAssignmentSchema, executionIdentity, sameExecution, WorkerRejectedError, WorkerRequestSchema, WorkerResponseSchema,
  type WorkerConnectionSink, type RemoteProjectRequest, type RemoteProjectReply, type RemoteTaskRecord,
  type WorkerRequest, type RemoteAssignment, type WorkerResponse } from '../core/worker-pool/remoteProtocol.js';
import { createWorkerServer, connectWorkerTransport } from '../infra/worker-pool/remoteTransport.js';
import { createHash, randomUUID } from 'node:crypto';
import { ControlledTurnRunner, deferred } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { installDaemonErrorLog } from '../infra/daemon/diagnostics.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { parse as parseYaml } from 'yaml';
import type { RemoteCredentialsConfig } from '../core/models/daemon-config-schema.js';

interface WorkerEvent { kind: string; pid?: number; assignment?: RemoteAssignment; executionId?: string; reason?: string; response?: WorkerResponse }
// These acceptance tests require the OS to deny daemon paths in every descendant, including Git.
const isolatedWorkerTest = it.skipIf(process.platform !== 'darwin');

function storedText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== '.git').map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? storedText(path) : entry.isFile() ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

function filesContaining(directory: string, value: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== '.git').flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesContaining(path, value) : entry.isFile() && readFileSync(path, 'utf8').includes(value) ? [path] : [];
  });
}

it('keeps communication failures retryable while returning a terminal reason for authentication rejection', async () => {
  const token = 'private-test-token';
  const errors = vi.fn();
  const runtime = { authenticate: vi.fn(async (_token: string): Promise<void> => {}),
    receive: vi.fn(async (_token: string, _request: WorkerRequest, _sink: WorkerConnectionSink): Promise<void> => {
    throw new Error(`Storage failed with ${token}`);
  }), disconnect: vi.fn() };
  const server = await createWorkerServer({ host: '127.0.0.1', port: 0, runtime, onError: errors });
  const transports: ReturnType<typeof connectWorkerTransport>[] = [];
  const responses: WorkerResponse[] = [];
  const request = { kind: 'connect' as const, protocolVersion: 1 as const, requestId: randomUUID(), workerId: 'w1',
    registrationGeneration: randomUUID(), version: packageVersion, canExecute: true, active: [] };
  const open = async () => {
    const transport = connectWorkerTransport({ url: new URL(`http://127.0.0.1:${server.port}`), token, onResponse: (message) => responses.push(message) });
    transports.push(transport); let closed = false;
    void transport.closed.then(() => { closed = true; });
    transport.send(request);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
  };
  try {
    runtime.authenticate.mockRejectedValueOnce(new Error(`Registry failed with ${token}`));
    await open();
    expect(runtime.authenticate).toHaveBeenCalledWith(token);
    expect(runtime.receive).not.toHaveBeenCalled();
    expect(responses).toEqual([]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(new Error('Worker communication failed'));
    runtime.authenticate.mockRejectedValueOnce(new WorkerRejectedError('Worker token was removed'));
    await open();
    expect(runtime.receive).not.toHaveBeenCalled();
    expect(responses).toEqual([{ kind: 'rejected', reason: 'Worker token was removed' }]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockClear(); responses.length = 0;
    await open();
    expect(responses).toEqual([]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(new Error('Worker communication failed'));
    runtime.receive.mockRejectedValueOnce(new WorkerRejectedError('Worker token was removed'));
    await open();
    expect(responses).toEqual([{ kind: 'rejected', reason: 'Worker token was removed' }]);
    expect(errors).toHaveBeenCalledOnce();
    runtime.receive.mockImplementation(async (_token, message, sink) => {
      if (message.kind !== 'connect') throw new Error('Private heartbeat failure');
      sink.send({ protocolVersion: message.protocolVersion, requestId: message.requestId,
        workerId: message.workerId, registrationGeneration: message.registrationGeneration,
        kind: 'connected', concurrency: 2, running: [], stop: [] });
    });
    const transport = connectWorkerTransport({ url: new URL(`http://127.0.0.1:${server.port}`), token,
      onResponse: (response) => responses.push(response) });
    transports.push(transport); transport.send(request);
    await vi.waitFor(() => expect(responses.some((response) => response.kind === 'connected')).toBe(true), { timeout: 5000 });
    transport.send({ protocolVersion: request.protocolVersion, workerId: request.workerId,
      registrationGeneration: request.registrationGeneration, kind: 'heartbeat', requestId: randomUUID(), active: [] });
    await transport.closed;
    expect(errors).toHaveBeenLastCalledWith(new Error('Worker w1 communication failed'));
    expect(errors).toHaveBeenCalledTimes(2);
    expect(responses.filter((response) => response.kind === 'rejected')).toHaveLength(1);
  } finally { for (const transport of transports) transport.close(); await server.close(); }
});

const connectionFailureCases = ['project', 'storage'].flatMap((stage) => ['heartbeat', 'check'].flatMap((entry) =>
  [false, true].map((failed) => ({ stage, entry, failed }))));

it.each(connectionFailureCases)('preserves the same TCP connection during $entry with another pending $stage failure=$failed', async ({ stage, entry, failed }) => {
  const directory = mkdtempSync(join(getGlobalConfigDir(), 'worker-failure-'));
  const registry = new WorkerRegistry(directory);
  const first = await registry.add('w1', 2); const second = await registry.add('w2', 2);
  const records: RemoteTaskRecord[] = [];
  const tasks = new Map([['/a', [] as string[]], ['/b', [] as string[]]]);
  const claims: RemoteProjectRequest[] = [];
  let inject = false;
  const failure = new Error('Private dependency failure: confidential-marker');
  const remote = async (projectId: string, request: RemoteProjectRequest): Promise<RemoteProjectReply> => {
    if (request.kind === 'claim') {
      claims.push(request);
      if (inject && stage === 'project' && request.workerId === 'w1') { inject = false; throw failure; }
      const queue = tasks.get(projectId)!;
      queue.splice(queue.indexOf(request.taskName), 1);
      const assignment = RemoteAssignmentSchema.parse({ workerId: request.workerId, registrationGeneration: request.registrationGeneration,
        requestId: request.requestId, leaseExpiresAt: request.leaseExpiresAt,
        projectId, taskName: request.taskName, workerName: request.workerId, executionId: randomUUID(), assignmentGeneration: 1,
        originalSha: 'a'.repeat(40), origin: 'https://example.test/repo.git', branch: 'result',
        lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
      records.push({ assignment, status: 'running' });
      return { kind: 'claim', assignment };
    }
    const record = records.find((record) => sameExecution(record.assignment, request.assignment));
    if (record === undefined) return { kind: 'updated', record: null };
    if (request.kind === 'renew') record.assignment.leaseExpiresAt = request.leaseExpiresAt;
    else if (request.kind === 'fail') { record.status = 'failed'; record.failureReason = request.reason; }
    else if (request.kind === 'finish') record.status = request.success ? 'completed' : 'failed';
    else throw new Error('Unexpected execution request in scheduler fixture');
    return { kind: 'updated', record: structuredClone(record) };
  };
  const dispatcher = new TaskDispatcher({ projects: async () => ['/a', '/b'], workers: [], wake() {}, onError(error) { throw error; },
    factory: { create: (projectId) => ({
      inspect: async () => ({ concurrency: 2, available: true,
        tasks: tasks.get(projectId)!.map((taskName) => ({ taskName, mergeTask: false, origin: 'https://example.test/repo.git' })),
        remoteRecords: structuredClone(records.filter((record) => record.assignment.projectId === projectId)) }),
      remote: (request) => remote(projectId, request), setWaitingReasons: async () => ({ kind: 'updated' as const }),
      start: async () => ({ kind: 'declined' as const }), close: async () => {},
    }) },
  });
  const runtime = new RemoteWorkerRuntime({ directory, dispatcher, version: packageVersion, now: () => 1000 });
  const errors = vi.fn();
  const server = await createWorkerServer({ host: '127.0.0.1', port: 0, runtime, onError: errors });
  const write = privateFile.writePrivateFile;
  const storage = vi.spyOn(privateFile, 'writePrivateFile').mockImplementation(async (path, bytes, signal) => {
    if (inject && stage === 'storage' && path.includes(first.registration.registrationGeneration)) { inject = false; throw failure; }
    return write(path, bytes, signal);
  });
  const connections: ReturnType<typeof connectWorkerTransport>[] = [];
  const open = async (registered: typeof first) => {
    const responses: WorkerResponse[] = [];
    const transport = connectWorkerTransport({ url: new URL(`http://127.0.0.1:${server.port}`), token: registered.token,
      onResponse: (response) => responses.push(response) });
    connections.push(transport);
    let closed = false;
    void transport.closed.then(() => { closed = true; });
    const message = <T extends object>(body: T) => ({ protocolVersion: 1 as const, requestId: randomUUID(),
      workerId: registered.registration.name, registrationGeneration: registered.registration.registrationGeneration, ...body });
    transport.send(message({ kind: 'connect' as const, version: packageVersion, canExecute: true, active: [] }));
    await vi.waitFor(() => expect(responses.some((response) => response.kind === 'connected')).toBe(true), { timeout: 5000 });
    return { transport, responses, message, closed: () => closed };
  };
  try {
    await runtime.restore();
    const a = await open(first); const b = await open(second);
    tasks.get('/b')!.push('b');
    b.transport.send(b.message({ kind: 'pull' as const }));
    await vi.waitFor(() => expect(records.some((record) => record.assignment.workerId === 'w2')).toBe(true), { timeout: 5000 });
    const running = structuredClone(records.find((record) => record.assignment.workerId === 'w2')!.assignment);
    const waiting = a.message({ kind: 'pull' as const });
    a.transport.send(waiting);
    const firstReceive = vi.spyOn(runtime, 'receive');
    const barrier = a.message({ kind: 'heartbeat' as const, active: [] }); a.transport.send(barrier);
    await vi.waitFor(() => expect(a.responses).toContainEqual(expect.objectContaining({ kind: 'heartbeat', requestId: barrier.requestId })), { timeout: 5000 });
    if (entry === 'check') {
      const idle = b.message({ kind: 'pull' as const }); b.transport.send(idle);
      const idleBarrier = b.message({ kind: 'heartbeat' as const, active: [executionIdentity(running)] });
      b.transport.send(idleBarrier);
      await vi.waitFor(() => expect(b.responses).toContainEqual(expect.objectContaining({
        kind: 'heartbeat', requestId: idleBarrier.requestId,
      })), { timeout: 5000 });
    }
    const entered = deferred<void>(); const resume = deferred<void>();
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    vi.spyOn(dispatcher, 'dispatch').mockImplementationOnce(async () => { entered.resolve(); await resume.promise; await dispatch(); });
    const heartbeat = b.message({ kind: 'heartbeat' as const, active: [executionIdentity(running)] });
    const checking = entry === 'check' ? runtime.check().then(() => undefined, (error: unknown) => error) : undefined;
    if (entry === 'heartbeat') b.transport.send(heartbeat);
    await entered.promise;
    tasks.get('/a')!.push('a'); tasks.get('/b')!.push('next'); inject = failed;
    resume.resolve();
    if (checking !== undefined) expect(await checking).toBeUndefined();
    else {
      await vi.waitFor(() => expect(b.closed() || b.responses.some((response) => 'requestId' in response && response.requestId === heartbeat.requestId)).toBe(true), { timeout: 5000 });
      expect(b.responses).toContainEqual(expect.objectContaining({ kind: 'heartbeat', requestId: heartbeat.requestId, stop: [] }));
    }
    const next = b.message({ kind: 'heartbeat' as const, active: [executionIdentity(running)] }); b.transport.send(next);
    await vi.waitFor(() => expect(b.closed() || b.responses.some((response) => 'requestId' in response && response.requestId === next.requestId)).toBe(true), { timeout: 5000 });
    expect(b.responses).toContainEqual(expect.objectContaining({ kind: 'heartbeat', requestId: next.requestId, stop: [] }));
    expect(b.closed()).toBe(false);
    if (failed) {
      await vi.waitFor(() => expect(a.closed()).toBe(true), { timeout: 5000 });
      expect(errors).toHaveBeenCalledOnce();
      const diagnostic = String(errors.mock.calls[0]![0]);
      expect(diagnostic).toMatch(/w1/); expect(diagnostic).not.toContain(first.token);
      expect(diagnostic).not.toContain(failure.message);
      expect(a.responses.some((response) => response.kind === 'rejected' || response.kind === 'assignment')).toBe(false);
      const recovered = await open(first);
      const oldSink = firstReceive.mock.calls.find(([, request]) => request.requestId === barrier.requestId)![2];
      oldSink.fail(failure); oldSink.fail(failure); runtime.disconnect(oldSink);
      const afterReplacement = recovered.message({ kind: 'heartbeat' as const, active: [] });
      recovered.transport.send(afterReplacement);
      await vi.waitFor(() => expect(recovered.responses).toContainEqual(expect.objectContaining({
        kind: 'heartbeat', requestId: afterReplacement.requestId,
      })), { timeout: 5000 });
      expect(runtime.connectionCount).toBe(2); expect(errors).toHaveBeenCalledOnce();
      if (stage === 'storage') {
        const committed = records.find((record) => record.assignment.workerId === 'w1')!.assignment;
        recovered.transport.send(waiting);
        await vi.waitFor(() => expect(recovered.responses).toContainEqual(expect.objectContaining({
          kind: 'assignment', requestId: waiting.requestId, assignment: expect.objectContaining({ executionId: committed.executionId }),
        })), { timeout: 5000 });
        expect(claims.filter((request) => request.kind === 'claim' && request.workerId === 'w1')).toHaveLength(1);
      }
    } else { expect(errors).not.toHaveBeenCalled(); expect(a.closed()).toBe(false); }
  } finally {
    storage.mockRestore(); vi.restoreAllMocks();
    for (const transport of connections) transport.close();
    await server.close(); await runtime.close(); await dispatcher.close(); rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { origin?: string; version?: string; workerConcurrency?: number; credentials?: RemoteCredentialsConfig } = {}) {
  const directory = getGlobalConfigDir();
  const logger = new DaemonLogger(directory);
  const restoreLog = installDaemonErrorLog((message) => logger.write('error', message));
  const project = mkdtempSync(join(directory, 'remote-project-'));
  const bareOrigin = options.origin !== undefined && !options.origin.startsWith('https:') ? options.origin
    : mkdtempSync(join(tmpdir(), 'takt-remote-origin-'));
  if (spawnSync('git', ['init', '--bare', bareOrigin]).status !== 0) throw new Error('Cannot initialize fixture origin');
  mkdirSync(join(project, '.takt'), { recursive: true });
  writeFileSync(join(project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 2\n');
  mkdirSync(join(project, '.takt/workflows'), { recursive: true });
  writeFileSync(join(project, '.takt/workflows/remote-fixture.yaml'),
    'name: remote-fixture\nsteps:\n  - name: work\n    instruction: Complete the task\n    rules:\n      - condition: done\n        next: COMPLETE\n');
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\ndaemon:\n  builtin_worker:\n    concurrency: 0\n  remote_worker:\n    host: 127.0.0.1\n    port: 0\n');
  if (options.credentials !== undefined) writeFileSync(join(directory, 'config.yaml'), JSON.stringify({ provider: 'mock', daemon: {
    builtin_worker: { concurrency: 0 }, remote_worker: { host: '127.0.0.1', port: 0, credentials: options.credentials } } }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', project, ...args], { env: process.env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Worker test'); git('config', 'user.email', 'worker@example.test');
  git('commit', '--allow-empty', '-m', 'fixture'); git('remote', 'add', 'origin', options.origin ?? bareOrigin);
  if (options.origin?.startsWith('https:')) git('remote', 'set-url', '--push', 'origin', bareOrigin);
  const goal = await new GoalStore(project).create(goalRecord()); git('branch', goal.branch);
  const originalSha = git('rev-parse', goal.branch);
  git('commit', '--allow-empty', '-m', 'Advance HEAD independently of the task base');
  const task = new TaskRunner(project).addTask('remote task', { goal_id: goal.id, base_branch: goal.branch, worktree: false, workflow: 'remote-fixture' });
  await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Test process identity is unavailable');
  const owner = { pid: process.pid, identity, version: options.version ?? packageVersion, cliPath: daemonEntryPath() };
  const registry = new WorkerRegistry(directory);
  const registered = await registry.add('w1', options.workerConcurrency ?? 2);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let controller: AbortController | undefined;
  let targetPort = 0;
  let blocked = false;
  let refusedConnections = 0;
  const sockets = new Set<Socket>();
  const requests: WorkerRequest[] = [];
  const responses: WorkerResponse[] = [];
  let interceptRequest: ((request: WorkerRequest) => void) | undefined;
  const observe = (socket: Socket, direction: 'request' | 'response') => {
    let buffer = '';
    socket.on('data', (bytes: Buffer) => {
      buffer += bytes.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line.startsWith('{')) continue;
        const value: unknown = JSON.parse(line);
        if (direction === 'request') { const parsed = WorkerRequestSchema.safeParse(value); if (parsed.success) { requests.push(parsed.data); interceptRequest?.(parsed.data); } }
        else { const parsed = WorkerResponseSchema.safeParse(value); if (parsed.success) responses.push(parsed.data); }
      }
    });
  };
  const proxy = createServer((socket) => {
    if (blocked) {
      refusedConnections++;
      socket.on('error', () => socket.destroy());
      socket.resume();
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = connect({ host: '127.0.0.1', port: targetPort });
    observe(socket, 'request'); observe(target, 'response');
    for (const stream of [socket, target]) {
      sockets.add(stream); stream.once('close', () => sockets.delete(stream));
      stream.on('error', () => { socket.destroy(); target.destroy(); });
    }
    socket.pipe(target).pipe(socket);
    socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('Test proxy has no port');
  const children: { child: ChildProcess; closed: Promise<void>; home: string }[] = [];
  const turnRunners: ControlledTurnRunner[] = [];
  const start = async () => {
    controller = new AbortController();
    await writeDaemonOwner(directory, owner);
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { const turns = new ControlledTurnRunner(); turns.bus = bus; turnRunners.push(turns); return turns; } });
    if (daemon.workerPort === undefined) throw new Error('Worker listener is missing');
    targetPort = daemon.workerPort;
  };
  const disconnect = () => { blocked = true; for (const socket of sockets) socket.destroy(); };
  await start();
  const store = new TaskStore(project);
  return { project, task, store, directory, registry, registered, originalSha, bareOrigin, origin: options.origin ?? bareOrigin, start, disconnect, requests, responses, turnRunners,
    get port() { return targetPort; },
    get refusedConnections() { return refusedConnections; },
    interceptRequests(callback: (request: WorkerRequest) => void) { interceptRequest = callback; },
    resume() { blocked = false; },
    cliWorker(token = registered.token, bootstrap?: { prepare(home: string, config: string): string; forbiddenDirectories: string[] }) {
      const home = mkdtempSync(join(tmpdir(), 'takt-remote-cli-worker-'));
      const config = join(home, '.takt');
      const nodeOptions = bootstrap?.prepare(home, config) ?? '';
      const profile = bootstrap === undefined ? undefined : '(version 1)(allow default)'
        + bootstrap.forbiddenDirectories.map((directory) => `(deny file-read* (subpath ${JSON.stringify(directory)}))`).join('');
      const child = spawn(profile === undefined ? process.execPath : '/usr/bin/sandbox-exec', [
        ...(profile === undefined ? [] : ['-p', profile, process.execPath]),
        join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier',
        'worker', '--url', `http://127.0.0.1:${address.port}`, '--token', token], {
        cwd: home, env: { ...process.env, NODE_OPTIONS: nodeOptions, HOME: home, USERPROFILE: home, TAKT_CONFIG_DIR: config,
          TSX_DISABLE_CACHE: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), TAKT_TEST_CONNECTION_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      child.stderr?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      let exit: number | null | undefined;
      const closed = new Promise<void>((resolve) => child.once('close', (code) => { exit = code; resolve(); }));
      children.push({ child, closed, home });
      return { child, config, closed, output: () => output, exit: () => exit };
    },
    async stopDaemon() { controller?.abort(); await daemon?.close(); daemon = undefined; },
    worker(token = registered.token, version = packageVersion, mode = '') {
      const home = mkdtempSync(join(tmpdir(), 'takt-remote-worker-'));
      const events: WorkerEvent[] = [];
      const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), join(process.cwd(), 'src/__tests__/fixtures/worker-pool-remote-process.ts'),
        `http://127.0.0.1:${address.port}`, token, version, mode], {
        cwd: home, env: { ...process.env, NODE_OPTIONS: '', HOME: home, USERPROFILE: home, TAKT_CONFIG_DIR: join(home, '.takt') },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let errors = '';
      child.stderr?.on('data', (bytes: Buffer) => { errors += bytes.toString(); });
      child.on('message', (message: WorkerEvent) => events.push(message));
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      children.push({ child, closed, home });
      return { child, events, closed,
        async wait(kind: string, count = 1) {
          await vi.waitFor(() => expect(events.filter((event) => event.kind === kind).length, errors).toBeGreaterThanOrEqual(count), { timeout: 20_000 });
          return events.filter((event) => event.kind === kind)[count - 1]!;
        },
      };
    },
    async close() {
      for (const { child } of children) {
        if (child.connected) child.send({ kind: 'quit' });
        else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
      for (const { child, closed, home } of children) {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed; clearTimeout(timer);
        rmSync(home, { recursive: true, force: true });
      }
      controller?.abort(); await daemon?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      restoreLog(); await logger.close();
      if (options.origin === undefined || options.origin.startsWith('https:')) rmSync(bareOrigin, { recursive: true, force: true });
    },
  };
}

it.each(['unregistered', 'removed'].flatMap((condition) => [false, true].map((sendFrame) => ({ condition, sendFrame }))))(
  'rejects $condition tokens and closes the socket with an unfinished request (sendFrame=$sendFrame)', async ({ condition, sendFrame }) => {
    const f = await fixture();
    const socket = connect({ host: '127.0.0.1', port: f.port });
    let received = ''; let closed = false;
    const errors = vi.fn();
    socket.on('data', (bytes: Buffer) => { received += bytes.toString(); });
    socket.once('close', () => { closed = true; });
    socket.on('error', errors);
    try {
      let token = f.registered.token;
      if (condition === 'unregistered') token = token.slice(0, -2) + 'xx';
      else await f.registry.remove('w1');
      socket.write(['POST /worker HTTP/1.1', 'Host: localhost', `Authorization: Bearer ${token}`,
        'Content-Type: application/x-ndjson', 'Transfer-Encoding: chunked', 'Connection: keep-alive', '', ''].join('\r\n'));
      if (sendFrame) {
        const frame = JSON.stringify({ kind: 'connect', protocolVersion: 1, requestId: randomUUID(),
          workerId: 'w1', registrationGeneration: f.registered.registration.registrationGeneration,
          version: packageVersion, canExecute: true, active: [] }) + '\n';
        socket.write(`${Buffer.byteLength(frame).toString(16)}\r\n${frame}\r\n`);
      }
      await vi.waitFor(() => expect(received).toContain('"kind":"rejected"'), { timeout: 5000 });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
      const responses = received.split('\n').map((line) => {
        try { return WorkerResponseSchema.safeParse(JSON.parse(line)); } catch { return undefined; }
      }).flatMap((parsed) => parsed?.success ? [parsed.data] : []);
      expect(responses).toEqual([{ kind: 'rejected', reason: expect.stringMatching(/not registered|removed/i) }]);
      expect(received).not.toContain(token);
      expect(errors).not.toHaveBeenCalled();
      expect(f.store.read().tasks[0]!.status).toBe('pending');
    } finally { socket.destroy(); await f.close(); }
  },
);

it.each([false, true])('rechecks registration on connect after header authentication (removed=%s)', async (removed) => {
  const f = await fixture();
  const authenticated = deferred<void>();
  const authenticate = RemoteWorkerRuntime.prototype.authenticate;
  const authentication = vi.spyOn(RemoteWorkerRuntime.prototype, 'authenticate').mockImplementation(async function (this: RemoteWorkerRuntime, token) {
    await authenticate.call(this, token);
    authenticated.resolve();
  });
  const responses: WorkerResponse[] = [];
  const transport = connectWorkerTransport({ url: new URL(`http://127.0.0.1:${f.port}`), token: f.registered.token,
    onResponse: (response) => responses.push(response) });
  let closed = false;
  void transport.closed.then(() => { closed = true; });
  try {
    await authenticated.promise;
    expect(closed).toBe(false);
    expect(f.requests).toEqual([]);
    expect(responses).toEqual([]);
    expect(f.store.read().tasks[0]!.status).toBe('pending');
    if (removed) await f.registry.remove('w1');
    const message = <T extends object>(body: T) => ({ protocolVersion: 1 as const, requestId: randomUUID(), workerId: 'w1',
      registrationGeneration: f.registered.registration.registrationGeneration, ...body });
    transport.send(message({ kind: 'connect' as const, version: packageVersion, canExecute: false, active: [] }));
    if (removed) {
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
      expect(responses).toEqual([{ kind: 'rejected', reason: expect.stringMatching(/not registered|removed/i) }]);
    } else {
      await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({ kind: 'connected' })), { timeout: 5000 });
      for (let count = 0; count < 2; count++) {
        const heartbeat = message({ kind: 'heartbeat' as const, active: [] }); transport.send(heartbeat);
        await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({ kind: 'heartbeat', requestId: heartbeat.requestId })), { timeout: 5000 });
      }
      expect(closed).toBe(false);
    }
    expect(f.store.read().tasks[0]!.status).toBe('pending');
  } finally { authentication.mockRestore(); transport.close(); await f.close(); }
});

it('authenticates a separate worker process and persists its assignment and worker name through the task list', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(); const started = await worker.wait('started');
    expect(started.pid).not.toBe(process.pid);
    const assignment = started.assignment!;
    const saved = f.store.read().tasks[0]!;
    expect(saved).toMatchObject({ status: 'running', owner_pid: null, worker_name: 'w1', execution_id: assignment.executionId,
      remote_assignment: assignment });
    expect(assignment.origin).toBe(f.origin);
    expect(assignment.originalSha).toBe(f.originalSha);
    const listed = await listTaktTasks({ cwd: f.project });
    expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ tasks: [expect.objectContaining({ name: f.task.name, workerName: 'w1' })] });
    expect(JSON.stringify(worker.events)).not.toContain(f.registered.token);
    expect(readFileSync(join(f.directory, 'workers.json'), 'utf8')).not.toContain(f.registered.token);
    expect(storedText(join(f.directory, 'worker-pull-responses'))).not.toContain(f.registered.token);
    worker.child.send({ kind: 'complete', executionId: assignment.executionId });
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status, JSON.stringify(f.store.read().tasks[0]!.failure)).toBe('completed'), { timeout: 10_000 });
    expect(storedText(f.directory)).not.toContain(f.registered.token);
  } finally { await f.close(); }
});

isolatedWorkerTest('executes daemon-only assets through the public worker CLI and receives a mergeable result from origin', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'takt-remote-origin-'));
  const init = spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  const f = await fixture({ origin });
  try {
    const workflowDir = join(f.project, '.takt', 'workflows');
    mkdirSync(join(workflowDir, 'personas'), { recursive: true });
    writeFileSync(join(f.project, '.takt', 'config.yaml'), 'provider: mock\nmodel: daemon-model\nlanguage: en\nconcurrency: 2\nauto_pr: false\n');
    writeFileSync(join(workflowDir, 'remote-input.yaml'), 'name: remote-input\ninitial_step: delegate\nsteps:\n  - name: delegate\n    kind: workflow_call\n    call: ./remote-child.yaml\n    rules:\n      - condition: COMPLETE\n        next: COMPLETE\n');
    writeFileSync(join(workflowDir, 'remote-child.yaml'), 'name: remote-child\nsubworkflow:\n  callable: true\ninitial_step: work\nsteps:\n  - name: work\n    persona: ./personas/daemon.md\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    writeFileSync(join(workflowDir, 'personas', 'daemon.md'), 'DAEMON_ONLY_PERSONA');
    expect(loadWorkflowByIdentifier('remote-input', f.project)).not.toBeNull();
    expect(loadWorkflowByIdentifier('remote-child', f.project)).not.toBeNull();
    const taskDir = '.takt/tasks/remote-input';
    mkdirSync(join(f.project, taskDir, 'attachments'), { recursive: true });
    writeFileSync(join(f.project, taskDir, 'order.md'), '# DAEMON_ONLY_ORDER\n\nRead `attachments/input.bin`.\n');
    writeFileSync(join(f.project, taskDir, 'attachments', 'input.bin'), Buffer.from([0, 255, 128, 10]));
    f.store.update((current) => ({ tasks: current.tasks.map(({ content: _content, ...task }) => ({ ...task,
      task_dir: taskDir, workflow: 'remote-input', worktree: true, goal_purpose: 'Verify remote execution' })) }));
    const goal = new GoalStore(f.project).getSync(goalRecord().id);
    expect(spawnSync('git', ['--git-dir', origin, 'rev-parse', '--verify', goal.branch]).status).not.toBe(0);
    let observationPath = '';
    const worker = f.cliWorker(f.registered.token, { forbiddenDirectories: [f.directory], prepare(home, config) {
      mkdirSync(join(config, 'workflows'), { recursive: true });
      writeFileSync(join(config, 'config.yaml'), 'provider: mock\nmodel: worker-model\nlanguage: ja\n');
      writeFileSync(join(config, 'workflows', 'remote-input.yaml'), 'invalid worker workflow that must never be loaded');
      writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Worker fixture\n  email = worker@example.test\n');
      observationPath = join(home, 'observation.json');
      const hook = join(home, 'provider-hook.mjs');
      writeFileSync(hook, `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { MockProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/providers/mock.js')).href)};
const daemonOrder = ${JSON.stringify(join(f.project, taskDir, 'order.md'))};
let startupDenied;
try { readFileSync(daemonOrder); } catch (error) { startupDenied = error.code; }
if (startupDenied !== 'EPERM') throw new Error('Worker isolation did not reject daemon path');
writeFileSync(${JSON.stringify(observationPath + '.isolation')}, JSON.stringify({ denied: startupDenied }));
if (process.argv.includes('worker')) {
  const token = process.env.TAKT_TEST_CONNECTION_TOKEN;
  if (token === undefined) throw new Error('Worker fixture token environment is missing');
  writeFileSync(${JSON.stringify(observationPath + '.parent-env')}, createHash('sha256').update(token).digest('hex'));
}
MockProvider.prototype.setup = config => ({ call: async (prompt, options) => {
  let denied;
  try { readFileSync(daemonOrder); } catch (error) { denied = error.code; }
  if (denied !== 'EPERM') throw new Error('Daemon path was readable by worker');
  const runs = join(options.cwd, '.takt', 'runs');
  const orders = readdirSync(runs).map(slug => join(runs, slug, 'context', 'task'));
  const context = orders.find(path => { try { return readFileSync(join(path, 'order.md'), 'utf8').includes('DAEMON_ONLY_ORDER'); } catch { return false; } });
  if (!context) throw new Error('Transferred order is missing');
  const order = readFileSync(join(context, 'order.md'), 'utf8');
  const attachment = [...readFileSync(join(context, 'attachments', 'input.bin'))];
  const git = (...args) => execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }).trim();
  const observation = { pid: process.pid, cwd: options.cwd, denied, order, attachment, prompt,
    environmentHashes: Object.values(process.env).map(value => createHash('sha256').update(value).digest('hex')),
    argumentHashes: process.argv.map(value => createHash('sha256').update(value).digest('hex')),
    gitConfig: git('config', '--local', '--list'),
    systemPrompt: config.systemPrompt, model: options.model, head: git('rev-parse', 'HEAD'), origin: git('remote', 'get-url', 'origin') };
  writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(observation));
  writeFileSync(join(options.cwd, 'remote-result.txt'), 'remote execution result\\n');
  return { persona: config.name, status: 'done', content: 'Remote execution completed', timestamp: new Date(), sessionId: randomUUID() };
} });
`);
      return ['--import', JSON.stringify(pathToFileURL(hook).href)].join(' ');
    } });
    await vi.waitFor(() => expect(worker.output()).toMatch(/w1 connected/), { timeout: 20_000 });
    expect(JSON.parse(readFileSync(observationPath + '.isolation', 'utf8'))).toEqual({ denied: 'EPERM' });
    await vi.waitFor(() => expect(f.requests.some((request) => request.kind === 'pull'), worker.output()).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(f.store.read().tasks[0]!.status), { timeout: 30_000 });
    expect(f.store.read().tasks[0]!.status, worker.output() + JSON.stringify(f.store.read().tasks[0]!.failure)).toBe('completed');
    const saved = f.store.read().tasks[0]!;
    const observed = JSON.parse(readFileSync(observationPath, 'utf8'));
    expect(readFileSync(observationPath + '.parent-env', 'utf8')).toBe(createHash('sha256').update(f.registered.token).digest('hex'));
    expect(observed).toMatchObject({ denied: 'EPERM', head: f.originalSha, origin,
      attachment: [0, 255, 128, 10], model: 'daemon-model', systemPrompt: expect.stringContaining('DAEMON_ONLY_PERSONA'),
      prompt: expect.stringContaining('DAEMON_ONLY_ORDER') });
    expect(observed.environmentHashes).not.toContain(createHash('sha256').update(f.registered.token).digest('hex'));
    expect(observed.argumentHashes).not.toContain(createHash('sha256').update(f.registered.token).digest('hex'));
    expect((observed.gitConfig as string).includes(f.registered.token)).toBe(false);
    expect(observed.pid).not.toBe(process.pid);
    expect(observed.cwd).not.toBe(f.project);
    expect(saved.remote_assignment?.originalSha).toBe(f.originalSha);
    expect(saved.completion).toMatchObject({ success: true, branch: expect.any(String), sha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    const git = (...args: string[]) => spawnSync('git', ['-C', f.project, ...args], { encoding: 'utf8' });
    expect(git('rev-parse', saved.completion!.branch!).stdout.trim()).toBe(saved.completion!.sha);
    expect(spawnSync('git', ['--git-dir', origin, 'rev-parse', saved.completion!.branch!], { encoding: 'utf8' }).stdout.trim()).toBe(saved.completion!.sha);
    await vi.waitFor(async () => {
      for (const runner of f.turnRunners) for (const call of runner.calls) {
        if (!call.finished && call.input.event.event.kind !== 'task_completed') await runner.finish(call);
      }
      expect(f.turnRunners.flatMap((runner) => runner.calls.map((call) => call.input.event.event)))
        .toContainEqual(expect.objectContaining({ kind: 'task_completed',
          task: expect.objectContaining({ taskName: f.task.name, goalId: goal.id, runSlug: saved.run_slug }),
          result: expect.objectContaining({ sha: saved.completion!.sha, success: true }) }));
    }, { timeout: 10_000 });
    const merged = await mergeTaktGoalTask({ cwd: f.project, goalId: goal.id, taskName: f.task.name,
      expectedSha: saved.completion!.sha! }, {}, new AbortController().signal);
    expect(merged.isError, firstTextContent(merged.content)).toBeUndefined();
    expect(git('show', `${goal.branch}:remote-result.txt`).stdout).toBe('remote execution result\n');
    expect(worker.output()).not.toContain(f.registered.token);
    expect(storedText(f.directory)).not.toContain(f.registered.token);
  } finally { await f.close(); rmSync(origin, { recursive: true, force: true }); }
});

interface RealCall { executionId: string; number: number; pid: number; cwd: string; denied: string; prompt: string }

function credentialWorker(f: Awaited<ReturnType<typeof fixture>>, missing = false, authenticationError = false) {
  writeFileSync(join(f.project, '.takt/workflows/remote-fixture.yaml'),
    'name: remote-fixture\nsteps:\n  - name: work\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  let observations = '';
  const worker = f.cliWorker(f.registered.token, { forbiddenDirectories: [f.directory], prepare(home, config) {
    observations = join(home, 'auth-observations'); mkdirSync(observations);
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.yaml'), JSON.stringify({ provider: 'mock', openai_api_key: missing ? undefined : 'worker-config-value' }));
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Auth test\n  email = auth@example.test\n'
      + (f.origin.startsWith('https:') ? `[url "${f.bareOrigin}"]\n  insteadOf = ${f.origin}\n` : ''));
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', name)).href);
    const hook = join(home, 'auth-provider.mjs');
    writeFileSync(hook, `
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MockProvider } from ${moduleUrl('infra/providers/mock.js')};
import { loadGlobalConfig } from ${moduleUrl('infra/config/index.js')};
import { buildSafeGitEnvironment } from ${moduleUrl('infra/task/git-environment.js')};
import { writeReportFile } from ${moduleUrl('core/workflow/report-writer.js')};
import { createProviderEventLogger } from ${moduleUrl('core/logging/providerEventLogger.js')};
const observations = ${JSON.stringify(observations)};
const hash = value => value === undefined ? null : createHash('sha256').update(value).digest('hex');
if (process.argv.includes('worker')) {
  ${missing ? "delete process.env.OPENAI_API_KEY;" : "process.env.OPENAI_API_KEY = 'worker-env-value';"}
  process.env.GH_TOKEN = process.env.GITHUB_TOKEN = 'worker-gh-value';
  delete process.env.TAKT_REMOTE_GIT_TOKEN;
  for (const name of ['REMOTE_PROVIDER_TEST_KEY', 'REMOTE_GIT_TEST_TOKEN', 'REMOTE_GH_TEST_TOKEN']) delete process.env[name];
  let sequence = 0;
  const observe = () => {
    writeFileSync(join(observations, 'worker.json.tmp'), JSON.stringify({ sequence: ++sequence, pid: process.pid,
      openai: hash(process.env.OPENAI_API_KEY), git: hash(process.env.TAKT_REMOTE_GIT_TOKEN) }));
    renameSync(join(observations, 'worker.json.tmp'), join(observations, 'worker.json'));
  };
  observe(); setInterval(observe, 50).unref();
}
MockProvider.prototype.setup = config => ({ call: async (prompt, options) => {
  let denied;
  try { readFileSync(${JSON.stringify(join(f.project, '.takt/config.yaml'))}); } catch (error) { denied = error.code; }
  if (denied !== 'EPERM') throw new Error('Daemon state was readable');
  const api = loadGlobalConfig().openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!api) throw new Error('OpenAI authentication failed: API key is missing');
  const executionId = basename(process.cwd());
  const originalApi = process.env.OPENAI_API_KEY;
  const gitEnvironment = await buildSafeGitEnvironment(options.cwd, { allowGitHooks: false, allowGitFilters: false });
  let credential;
  if (process.env.TAKT_REMOTE_GIT_TOKEN) {
    const origin = new URL(process.env.TAKT_REMOTE_GIT_ORIGIN);
    credential = execFileSync('git', ['credential', 'fill'], { cwd: options.cwd, env: gitEnvironment,
      input: 'protocol=' + origin.protocol.slice(0, -1) + '\\nhost=' + origin.host + '\\n\\n', encoding: 'utf8' });
  }
  const run = join(options.cwd, '.takt/runs', 'remote-' + executionId);
  mkdirSync(join(run, 'logs'), { recursive: true });
  const suffix = ${authenticationError} ? '123' : '';
  const echo = (${authenticationError} ? [api] : [api, process.env.TAKT_REMOTE_GIT_TOKEN, process.env.GH_TOKEN])
    .filter(Boolean).map(value => value + suffix).join(' ');
  writeReportFile(join(run, 'reports'), 'auth.md', echo);
  writeReportFile(join(run, 'reports'), 'auth.md', 'updated ' + echo);
  const logger = createProviderEventLogger({ logsDir: join(run, 'logs'), sessionId: 'auth', runId: executionId, enabled: true });
  const midpoint = Math.floor(api.length / 2);
  const context = { provider: 'mock', providerModel: 'mock', step: 'work' };
  logger.logEvent(context, { type: 'text', data: { text: 'before ' + api.slice(0, midpoint) } });
  logger.logEvent(context, { type: 'text', data: { text: api.slice(midpoint) + suffix + ' after ' + echo } });
  logger.flush();
  const connectionHash = ${JSON.stringify(createHash('sha256').update(f.registered.token).digest('hex'))};
  writeFileSync(join(observations, executionId + '.json'), JSON.stringify({ executionId, pid: process.pid, cwd: options.cwd, denied,
    api: hash(api), envApi: hash(originalApi), gh: hash(process.env.GH_TOKEN), github: hash(process.env.GITHUB_TOKEN),
    git: hash(process.env.TAKT_REMOTE_GIT_TOKEN), helperPassword: hash(credential?.split('\\n').find(line => line.startsWith('password='))?.slice(9)),
    tokenPresent: Object.values(process.env).some(value => hash(value) === connectionHash),
    config: execFileSync('git', ['config', '--local', '--list'], { cwd: options.cwd, encoding: 'utf8' }),
    origin: execFileSync('git', ['config', '--local', '--get', 'remote.origin.url'], { cwd: options.cwd, encoding: 'utf8' }).trim(), prompt }));
  while (prompt.includes('hold authentication') && !existsSync(join(observations, 'release'))) await new Promise(resolve => setTimeout(resolve, 20));
  if (originalApi !== process.env.OPENAI_API_KEY) throw new Error('Concurrent task changed authentication');
  if (${authenticationError}) throw new Error('OpenAI authentication failed: supplied value ' + api + '123');
  return { persona: config.name, status: 'done', content: 'echo ' + echo, timestamp: new Date(), sessionId: 'auth-' + executionId };
} });
`);
    return ['--import', JSON.stringify(pathToFileURL(hook).href)].join(' ');
  } });
  const calls = () => readdirSync(observations).filter((name) => name !== 'worker.json' && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(observations, name), 'utf8')) as Record<string, unknown>);
  return { ...worker, calls, parent: () => JSON.parse(readFileSync(join(observations, 'worker.json'), 'utf8')) as Record<string, unknown>,
    release() { writeFileSync(join(observations, 'release'), 'release'); } };
}

isolatedWorkerTest('delivers daemon credentials only to each concurrent task and redacts output before saving and transfer', async () => {
  vi.stubEnv('REMOTE_PROVIDER_TEST_KEY', 'first-distributed-api-value');
  vi.stubEnv('REMOTE_GIT_TEST_TOKEN', 'distributed-git-value');
  vi.stubEnv('REMOTE_GH_TEST_TOKEN', 'distributed-gh-value');
  const f = await fixture({ origin: 'https://worker-auth.example.test/repo.git', credentials: {
    git: '${REMOTE_GIT_TEST_TOKEN}', gh: '${REMOTE_GH_TEST_TOKEN}', providers: { openai: '${REMOTE_PROVIDER_TEST_KEY}' } } });
  try {
    expect(spawnSync('git', ['-C', f.project, 'config', `url.${f.bareOrigin}.insteadOf`, f.origin]).status).toBe(0);
    const configPath = join(f.directory, 'config.yaml');
    writeFileSync(configPath, JSON.stringify({ ...parseYaml(readFileSync(configPath, 'utf8')), logging: { trace: true, provider_events: true } }));
    f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, content: 'hold authentication ${REMOTE_PROVIDER_TEST_KEY}' })) }));
    const worker = credentialWorker(f);
    await vi.waitFor(() => expect(worker.calls(), worker.output()).toHaveLength(1), { timeout: 30_000 });
    const first = worker.calls()[0]!;
    vi.stubEnv('REMOTE_PROVIDER_TEST_KEY', 'second-distributed-api-value');
    const goal = await new GoalStore(f.project).get(f.store.read().tasks[0]!.goal_id!);
    new TaskRunner(f.project).addTask('second authentication task', { goal_id: goal.id, base_branch: goal.branch, worktree: false, workflow: 'remote-fixture' });
    await vi.waitFor(() => expect(worker.calls(), worker.output()).toHaveLength(2), { timeout: 30_000 });
    const second = worker.calls().find((call) => call.executionId !== first.executionId)!;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(first).toMatchObject({ api: hash('first-distributed-api-value'), envApi: hash('first-distributed-api-value'),
      git: hash('distributed-git-value'), helperPassword: hash('distributed-git-value'), gh: hash('distributed-gh-value'),
      github: hash('distributed-gh-value'), denied: 'EPERM', tokenPresent: false });
    expect(second).toMatchObject({ api: hash('second-distributed-api-value'), envApi: hash('second-distributed-api-value'),
      git: hash('distributed-git-value'), helperPassword: hash('distributed-git-value'), tokenPresent: false });
    expect(second.pid).not.toBe(first.pid);
    expect(worker.parent()).toMatchObject({ openai: hash('worker-env-value'), git: null });
    const parentSequence = Number(worker.parent().sequence);
    expect(first.prompt).toContain('$｛REMOTE_PROVIDER_TEST_KEY｝');
    worker.release();
    await vi.waitFor(() => expect(f.store.read().tasks.every((task) => task.status === 'completed'), worker.output()
      + JSON.stringify(f.store.read().tasks.map((task) => task.failure))).toBe(true), { timeout: 30_000 });
    await vi.waitFor(() => expect(Number(worker.parent().sequence)).toBeGreaterThan(parentSequence));
    expect(worker.parent()).toMatchObject({ openai: hash('worker-env-value'), git: null });
    for (const value of ['first-distributed-api-value', 'second-distributed-api-value', 'distributed-git-value', 'distributed-gh-value', f.registered.token]) {
      expect(filesContaining(worker.config, value)).toEqual([]);
      expect(filesContaining(f.directory, value)).toEqual([]);
      for (const call of worker.calls()) expect(filesContaining(call.cwd as string, value)).toEqual([]);
    }
    for (const call of worker.calls()) {
      expect(call.origin).toBe(f.origin);
      for (const value of ['distributed-git-value', f.registered.token]) {
        expect(String(call.config).includes(value)).toBe(false);
        expect(readFileSync(join(call.cwd as string, '.git/config'), 'utf8').includes(value)).toBe(false);
        expect(String(call.origin).includes(value)).toBe(false);
      }
      const events = readFileSync(join(call.cwd as string, '.takt/runs', `remote-${call.executionId}`, 'logs/auth-provider-events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as { event_type: string; data: { text?: string } });
      expect(events.filter((event) => event.event_type === 'text').map((event) => event.data.text ?? '').join(''))
        .toBe('before [REDACTED] after [REDACTED] [REDACTED] [REDACTED]');
    }
    expect(f.requests.some((request) => request.kind === 'execution' && request.command.kind === 'credentials')).toBe(true);
    expect(storedText(join(f.directory, 'worker-pull-responses'))).not.toContain('distributed-api-value');
  } finally { await f.close(); vi.unstubAllEnvs(); }
});

isolatedWorkerTest.each(['distributed-provider-error-value', 'z', 'xy', 'abc'])(
  'redacts distributed value %s in provider authentication failures through task, run, transfer and manager', async (secret) => {
    vi.stubEnv('REMOTE_PROVIDER_TEST_KEY', secret);
    const f = await fixture({ credentials: { providers: { openai: '${REMOTE_PROVIDER_TEST_KEY}' } } });
    try {
      const configPath = join(f.directory, 'config.yaml');
      writeFileSync(configPath, JSON.stringify({ ...parseYaml(readFileSync(configPath, 'utf8')), logging: { trace: true, provider_events: true } }));
      const worker = credentialWorker(f, false, true);
      await vi.waitFor(() => expect(f.store.read().tasks[0]!.status, worker.output()).toBe('failed'), { timeout: 30_000 });
      const task = f.store.read().tasks[0]!;
      expect(task.failure?.error).toMatch(/w1.*OpenAI.*authentication/);
      expect(task.failure?.error).toContain('[REDACTED]123');
      expect(task.completion?.failureReason).toBe(task.failure?.error);
      const complete = f.requests.find((request) => request.kind === 'complete');
      expect(complete).toMatchObject({ kind: 'complete', success: false, reason: expect.stringContaining('[REDACTED]123') });
      expect(complete !== undefined && JSON.stringify(complete).includes(secret + '123')).toBe(false);
      expect(worker.calls()).toHaveLength(1);
      const call = worker.calls()[0]!;
      const workerRun = join(call.cwd as string, '.takt/runs', task.run_slug!);
      const daemonRun = join(f.project, '.takt/runs', task.run_slug!);
      for (const run of [workerRun, daemonRun]) {
        expect(readFileSync(join(run, 'reports/auth.md'), 'utf8')).toBe('updated [REDACTED]123');
        const history = join(run, 'reports/.takt-report-internal/history');
        const historyFiles = readdirSync(history, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
        expect(historyFiles.length).toBeGreaterThan(0);
        for (const entry of historyFiles) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).toBe('[REDACTED]123');
        const events = readFileSync(join(run, 'logs/auth-provider-events.jsonl'), 'utf8').trim().split('\n')
          .map((line) => JSON.parse(line) as { event_type: string; data: { text?: string } });
        expect(events.filter((event) => event.event_type === 'text').map((event) => event.data.text ?? '').join(''))
          .toBe('before [REDACTED]123 after [REDACTED]123');
        const metadata = JSON.parse(readFileSync(join(run, 'meta.json'), 'utf8'));
        expect(metadata).toMatchObject({ status: 'failed', reason: expect.stringContaining('[REDACTED]123') });
        expect(storedText(run).includes(secret + '123')).toBe(false);
      }
      const records = f.requests.filter((request) => request.kind === 'execution' && request.command.kind === 'record');
      expect(records.length).toBeGreaterThan(0);
      for (const request of records) {
        if (request.kind !== 'execution' || request.command.kind !== 'record') throw new Error('Expected run record');
        expect(Buffer.from(request.command.record.data, 'base64').toString('utf8').includes(secret + '123')).toBe(false);
      }
      await vi.waitFor(async () => {
        for (const runner of f.turnRunners) for (const turn of runner.calls) {
          if (!turn.finished && turn.input.event.event.kind !== 'task_failed') await runner.finish(turn);
        }
        expect(f.turnRunners.flatMap((runner) => runner.calls.map((turn) => turn.input.event.event)))
          .toContainEqual(expect.objectContaining({ kind: 'task_failed',
            result: expect.objectContaining({ success: false, failureReason: task.failure?.error }) }));
      }, { timeout: 10_000 });
      expect(JSON.stringify(task.failure).includes(secret + '123')).toBe(false);
      expect(JSON.stringify(task.completion).includes(secret + '123')).toBe(false);
      if (secret.length > 3) {
        expect(filesContaining(worker.config, secret)).toEqual([]);
        expect(filesContaining(f.directory, secret)).toEqual([]);
        expect(worker.output().includes(secret)).toBe(false);
      }
    } finally { await f.close(); vi.unstubAllEnvs(); }
  });

isolatedWorkerTest.each([false, true])('uses worker authentication when daemon has no key and reports missing authentication with worker name: %s', async (missing) => {
  const f = await fixture();
  try {
    const worker = credentialWorker(f, missing);
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(f.store.read().tasks[0]!.status), { timeout: 30_000 });
    if (missing) {
      expect(f.store.read().tasks[0]).toMatchObject({ status: 'failed', failure: { error: expect.stringMatching(/w1.*OpenAI.*authentication/) } });
    } else {
      expect(f.store.read().tasks[0]!.status, worker.output()).toBe('completed');
      expect(worker.calls()[0]!.api).toBe(createHash('sha256').update('worker-config-value').digest('hex'));
    }
  } finally { await f.close(); }
});

function controlledRealWorker(f: Awaited<ReturnType<typeof fixture>>, token = f.registered.token,
  protectedProjects: string[] = [f.project]) {
  const taskDir = '.takt/tasks/controlled';
  mkdirSync(join(f.project, taskDir), { recursive: true });
  writeFileSync(join(f.project, taskDir, 'order.md'), '# Controlled remote execution\n');
  writeFileSync(join(f.project, '.takt/workflows/remote-fixture.yaml'),
    'name: remote-fixture\ninitial_step: work\nsteps:\n  - name: work\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: verify\n  - name: verify\n    instruction: Verify the result\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  f.store.update((current) => ({ tasks: current.tasks.map(({ content: _content, ...task }) => task.status !== 'pending' ? { ...task, content: _content } : {
    ...task, task_dir: taskDir, workflow: 'remote-fixture',
  }) }));
  let observations = '';
  const worker = f.cliWorker(token, { forbiddenDirectories: [f.directory], prepare(home, config) {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.yaml'), 'provider: mock\nmodel: unused-worker-model\n');
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Remote test\n  email = remote@example.test\n');
    observations = join(home, 'calls'); mkdirSync(observations);
    const hook = join(home, 'controlled-provider.mjs');
    writeFileSync(hook, `
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/providers/mock.js')).href)};
const observations = ${JSON.stringify(observations)};
const daemonPaths = ${JSON.stringify(protectedProjects.map((project) => join(project, '.takt/config.yaml')))};
let number = 0;
MockProvider.prototype.setup = config => ({ call: async (prompt, options) => {
  let denied;
  for (const daemonPath of daemonPaths) {
    try { readFileSync(daemonPath); } catch (error) { denied = error.code; }
    if (denied !== 'EPERM') throw new Error('Worker could read daemon state');
  }
  const executionId = basename(process.cwd());
  const current = ++number;
  const key = executionId + '-' + current;
  const slug = 'remote-' + executionId;
  const reportDirectory = join(options.cwd, '.takt/runs', slug, 'reports');
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, 'phase-' + current + '.md'), 'remote report ' + current + '\\n');
  writeFileSync(join(observations, key + '.json'), JSON.stringify({ executionId, number: current, pid: process.pid, cwd: options.cwd, denied, prompt }));
  const aborted = () => writeFileSync(join(observations, key + '.aborted'), 'aborted');
  options.abortSignal?.addEventListener('abort', aborted, { once: true });
  if (options.abortSignal?.aborted) aborted();
  while (!existsSync(join(observations, key + '.release')) && !existsSync(join(observations, 'release-all'))
    && !existsSync(join(observations, 'fail-provider'))) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  options.abortSignal?.removeEventListener('abort', aborted);
  if (existsSync(join(observations, 'fail-provider'))) {
    return { persona: config.name, status: 'error', content: '', error: 'Mock provider failed', timestamp: new Date() };
  }
  writeFileSync(join(options.cwd, 'controlled-result.txt'), 'remote result ' + current + '\\n');
  return { persona: config.name, status: 'done', content: 'remote log ' + current, timestamp: new Date(), sessionId: randomUUID() };
} });
`);
    return ['--import', JSON.stringify(pathToFileURL(hook).href)].join(' ');
  } });
  const calls = (): RealCall[] => readdirSync(observations).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(observations, name), 'utf8')) as RealCall);
  return { ...worker, calls,
    async wait(number: number, executionId?: string) {
      const matches = () => calls().some((call) => call.number === number && (executionId === undefined || call.executionId === executionId));
      await vi.waitFor(() => expect(matches() || f.store.read().tasks.some((task) => task.status === 'failed') || worker.exit() !== undefined).toBe(true), { timeout: 20_000 });
      expect(matches(), worker.output() + JSON.stringify(f.store.read().tasks.map((task) => ({ status: task.status, failure: task.failure })))).toBe(true);
      return calls().find((call) => call.number === number && (executionId === undefined || call.executionId === executionId))!;
    },
    release(call: RealCall) { writeFileSync(join(observations, `${call.executionId}-${call.number}.release`), 'release'); },
    fail() { writeFileSync(join(observations, 'fail-provider'), 'fail'); },
    recover() { rmSync(join(observations, 'fail-provider'), { force: true }); },
    releaseAll() { writeFileSync(join(observations, 'release-all'), 'release'); },
    aborted(call: RealCall) { return existsSync(join(observations, `${call.executionId}-${call.number}.aborted`)); },
  };
}

function runPage(f: Awaited<ReturnType<typeof fixture>>, view: 'summary' | 'log' | 'report' = 'summary', report?: string, stepIndex?: number) {
  const runSlug = f.store.read().tasks[0]!.run_slug!;
  const result = getTaktRun({ cwd: f.project, runSlug, view, report, stepIndex });
  expect(result.isError, firstTextContent(result.content)).not.toBe(true);
  return JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
}

async function failDuringVerification(f: Awaited<ReturnType<typeof fixture>>, worker: ReturnType<typeof controlledRealWorker>) {
  const first = await worker.wait(1);
  worker.release(first);
  const verification = await worker.wait(2, first.executionId);
  worker.fail();
  await vi.waitFor(() => expect(f.store.read().tasks[0]!.status, worker.output()).toBe('failed'), { timeout: 20_000 });
  expect(verification.denied).toBe('EPERM');
  expect(existsSync(verification.cwd)).toBe(true);
  return { first, verification, assignment: f.store.read().tasks[0]!.remote_assignment! };
}

isolatedWorkerTest('reserves the failed worker without occupying the project slot for another worker', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  writeFileSync(join(f.project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 1\n');
  const worker = controlledRealWorker(f);
  let other: ReturnType<typeof controlledRealWorker> | undefined;
  try {
    await failDuringVerification(f, worker);
    const waiting = new TaskRunner(f.project).addTask('Waiting task', { goal_id: goalRecord().id,
      base_branch: goalRecord().branch, workflow: 'remote-fixture', worktree: false });
    const heartbeats = f.responses.filter((response) => response.kind === 'heartbeat').length;
    await vi.waitFor(() => expect(f.responses.filter((response) => response.kind === 'heartbeat').length)
      .toBeGreaterThan(heartbeats), { timeout: 15_000 });
    expect(f.store.read().tasks.find((task) => task.name === waiting.name)!.status).toBe('pending');
    const listed = JSON.parse(firstTextContent((await listTaktTasks({ cwd: f.project })).content));
    expect(listed.tasks.find((task: { name: string }) => task.name === f.task.name)).toMatchObject({ workerName: 'w1', retryReservation: { workerName: 'w1' } });
    expect(f.store.read().tasks[0]!.remote_assignment?.retryReservation).toBe(true);
    const registered = await f.registry.add('w2', 1);
    other = controlledRealWorker(f, registered.token);
    await vi.waitFor(() => expect(other!.calls()).toHaveLength(1), { timeout: 20_000 });
    expect(other.calls()[0]!.denied).toBe('EPERM');
    expect(f.store.read().tasks.find((task) => task.name === waiting.name)).toMatchObject({ status: 'running', worker_name: 'w2' });
  } finally { worker.releaseAll(); other?.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each(['requeue', 'retry'] as const)('resumes a failed clone on the same worker through %s', async (operation) => {
  const f = await fixture({ workerConcurrency: 1 });
  writeFileSync(join(f.project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 1\n');
  const worker = controlledRealWorker(f);
  try {
    const failed = await failDuringVerification(f, worker);
    writeFileSync(join(failed.verification.cwd, 'preserved-marker'), 'Uncommitted work');
    const waiting = new TaskRunner(f.project).addTask('Ordinary pending work', { goal_id: goalRecord().id,
      base_branch: goalRecord().branch, workflow: 'remote-fixture', worktree: false });
    const parentPid = worker.child.pid;
    worker.recover();
    const input = { cwd: f.project, goalId: goalRecord().id, taskName: f.task.name };
    const result = operation === 'requeue'
      ? await requeueTaktGoalTask(input, {}, new AbortController().signal)
      : await retryTaktGoalTask({ ...input, task: 'Corrected remote instructions', startStep: 'verify' }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    try {
      await vi.waitFor(() => expect(worker.calls().some((call) => call.pid !== failed.first.pid)).toBe(true), { timeout: 20_000 });
    } catch (error) {
      throw new Error('Remote retry did not start: ' + JSON.stringify({ operation, tasks: f.store.read().tasks.map((task) => ({ status: task.status, failure: task.failure,
        assignment: task.remote_assignment })), requests: f.requests.map((request) => ({ kind: request.kind,
          ...(request.kind === 'execution' ? { command: request.command.kind } : {}),
          ...('operation' in request ? { operation: request.operation, exists: request.exists, error: request.error } : {}) })),
        responses: f.responses.map((response) => ({ kind: response.kind,
          ...(response.kind === 'execution' ? { response: response.response.kind } : {}),
          ...('operation' in response ? { operation: response.operation } : {}) })),
        output: worker.output() }), { cause: error });
    }
    const resumed = worker.calls().find((call) => call.pid !== failed.first.pid)!;
    expect(worker.child.pid).toBe(parentPid);
    expect(resumed).toMatchObject({ cwd: failed.verification.cwd, denied: 'EPERM' });
    expect(readFileSync(join(resumed.cwd, 'preserved-marker'), 'utf8')).toBe('Uncommitted work');
    expect(resumed.prompt).toContain('Verify the result');
    expect(f.store.read().tasks.find((task) => task.name === waiting.name)!.status).toBe('pending');
    if (operation === 'retry') {
      const taskDir = f.store.read().tasks[0]!.task_dir!;
      expect(readFileSync(join(f.project, taskDir, 'order.md'), 'utf8')).toContain('Corrected remote instructions');
      expect(resumed.prompt).toContain('Corrected remote instructions');
    }
    const current = f.store.read().tasks[0]!.remote_assignment!;
    expect(current.executionId).not.toBe(failed.assignment.executionId);
    expect(current.assignmentGeneration).toBe(failed.assignment.assignmentGeneration + 1);
    worker.releaseAll();
    await vi.waitFor(() => {
      const task = f.store.read().tasks[0]!;
      expect(task.status, JSON.stringify({ operation, failure: task.failure, workerOutput: worker.output() })).toBe('completed');
    }, { timeout: 20_000 });
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest('removes the failed workspace before reporting removal and reuses the worker slot', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  const worker = controlledRealWorker(f);
  try {
    const failed = await failDuringVerification(f, worker);
    worker.recover();
    const result = await removeTaktGoalTask({ cwd: f.project, goalId: goalRecord().id,
      taskName: f.task.name, reason: 'Discard failed remote work', discardUnmerged: true }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(existsSync(failed.verification.cwd)).toBe(false);
    expect(f.store.read().tasks.some((task) => task.name === f.task.name)).toBe(false);
    const waiting = new TaskRunner(f.project).addTask('After removal', { goal_id: goalRecord().id,
      base_branch: goalRecord().branch, workflow: 'remote-fixture', worktree: false });
    await vi.waitFor(() => expect(f.store.read().tasks.find((task) => task.name === waiting.name))
      .toMatchObject({ status: 'running', worker_name: 'w1' }), { timeout: 20_000 });
    await vi.waitFor(() => expect(worker.calls().some((call) => call.pid !== failed.first.pid && call.denied === 'EPERM'))
      .toBe(true), { timeout: 10_000 });
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest('restarts on another worker from the saved SHA with a new generation after registration removal', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, assignment_generation: 6 })) }));
  const worker = controlledRealWorker(f);
  let other: ReturnType<typeof controlledRealWorker> | undefined;
  try {
    const failed = await failDuringVerification(f, worker);
    const advanced = spawnSync('git', ['-C', f.project, 'update-ref', `refs/heads/${goalRecord().branch}`, 'HEAD']);
    expect(advanced.status).toBe(0);
    await f.registry.remove('w1');
    const registered = await f.registry.add('w2', 1);
    other = controlledRealWorker(f, registered.token);
    const result = await requeueTaktGoalTask({ cwd: f.project, goalId: goalRecord().id,
      taskName: f.task.name }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    await vi.waitFor(() => expect(other!.calls()).toHaveLength(1), { timeout: 20_000 });
    const restarted = other.calls()[0]!;
    const current = f.store.read().tasks[0]!.remote_assignment!;
    expect(current).toMatchObject({ workerId: 'w2', originalSha: f.originalSha, assignmentGeneration: 8 });
    expect(current.executionId).not.toBe(failed.assignment.executionId);
    expect(restarted.prompt).toContain('Controlled remote execution');
    expect(restarted.prompt).not.toContain('Verify the result');
    expect(restarted.denied).toBe('EPERM');
    const head = spawnSync('git', ['-C', restarted.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect(head.status).toBe(0);
    expect(head.stdout.trim()).toBe(f.originalSha);
    const goal = await new GoalStore(f.project).get(goalRecord().id);
    expect(JSON.stringify(goal.workLog)).toMatch(/w1/);
    expect(JSON.stringify(goal.workLog)).toMatch(/removed|restart|最初|削除/i);
  } finally { worker.releaseAll(); other?.releaseAll(); await f.close(); }
});

isolatedWorkerTest('waits sixty seconds for a disconnected worker before restarting on another worker', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  try {
    const worker = controlledRealWorker(f);
    const failed = await failDuringVerification(f, worker);
    worker.child.kill('SIGTERM'); await worker.closed;
    const registered = await f.registry.add('w2', 1);
    const replacement = controlledRealWorker(f, registered.token);
    const goal = await new GoalStore(f.project).get(f.store.read().tasks[0]!.goal_id!);
    const result = await requeueTaktGoalTask({ cwd: f.project, goalId: goal.id, taskName: f.task.name }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.remote_assignment?.retryWaitUntil).toBeTypeOf('number'), { timeout: 10_000 });
    const deadline = f.store.read().tasks[0]!.remote_assignment!.retryWaitUntil!;
    expect(deadline - Date.now()).toBeGreaterThan(50_000);
    expect(f.store.read().tasks[0]!.status).toBe('pending');
    expect(replacement.calls()).toEqual([]);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.worker_name).toBe('w2'), { timeout: 70_000, interval: 500 });
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    const resumed = await replacement.wait(1);
    expect(resumed.denied).toBe('EPERM');
    expect(f.store.read().tasks[0]!.remote_assignment).toMatchObject({ originalSha: failed.assignment.originalSha,
      assignmentGeneration: failed.assignment.assignmentGeneration + 1, restartReason: expect.stringMatching(/w1.*60 seconds/) });
    expect(resumed.cwd).not.toBe(failed.verification.cwd);
    replacement.releaseAll();
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 30_000 });
  } finally { await f.close(); }
}, 120_000);

isolatedWorkerTest('restarts from the original SHA when the connected worker workspace has disappeared', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  try {
    const worker = controlledRealWorker(f);
    const failed = await failDuringVerification(f, worker);
    rmSync(failed.verification.cwd, { recursive: true, force: true });
    worker.recover();
    const goal = await new GoalStore(f.project).get(f.store.read().tasks[0]!.goal_id!);
    const result = await requeueTaktGoalTask({ cwd: f.project, goalId: goal.id, taskName: f.task.name }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    await vi.waitFor(() => expect(worker.calls().filter((call) => call.executionId !== failed.assignment.executionId)).not.toEqual([]), { timeout: 30_000 });
    const fresh = worker.calls().find((call) => call.executionId !== failed.assignment.executionId)!;
    expect(fresh.cwd).not.toBe(failed.verification.cwd);
    expect(f.store.read().tasks[0]!.remote_assignment).toMatchObject({ originalSha: failed.assignment.originalSha,
      assignmentGeneration: failed.assignment.assignmentGeneration + 1, restartReason: expect.stringMatching(/workspace was lost/) });
    expect(f.store.read().tasks[0]!.source_run_slug).toBeUndefined();
    expect(fresh.denied).toBe('EPERM');
    worker.releaseAll();
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 30_000 });
  } finally { await f.close(); }
});

isolatedWorkerTest('releases a failed reservation on goal abort and accepts work from another goal on the same worker', async () => {
  const f = await fixture({ workerConcurrency: 1 });
  const worker = controlledRealWorker(f);
  try {
    const failed = await failDuringVerification(f, worker);
    expect(failed.assignment.retryReservation).toBe(true);
    worker.recover();
    const result = await abortTaktGoal({ cwd: f.project, goalId: goalRecord().id,
      reason: 'Stop the failed goal' }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    expect(f.store.read().tasks[0]!.remote_assignment?.retryReservation).toBe(false);
    expect(existsSync(failed.verification.cwd)).toBe(true);
    const goal = await new GoalStore(f.project).create({ ...goalRecord(), id: randomUUID(), branch: 'takt/after-abort' });
    expect(spawnSync('git', ['-C', f.project, 'branch', goal.branch, f.originalSha]).status).toBe(0);
    const waiting = new TaskRunner(f.project).addTask('Other goal work', { goal_id: goal.id,
      base_branch: goal.branch, workflow: 'remote-fixture', worktree: false });
    await vi.waitFor(() => expect(f.store.read().tasks.find((task) => task.name === waiting.name))
      .toMatchObject({ status: 'running', worker_name: 'w1' }), { timeout: 20_000 });
    await vi.waitFor(() => expect(worker.calls().some((call) => call.pid !== failed.first.pid && call.denied === 'EPERM'))
      .toBe(true), { timeout: 10_000 });
  } finally { worker.releaseAll(); await f.close(); }
});

async function configuredRealWorker(f: Awaited<ReturnType<typeof fixture>>, options: {
  project?: Record<string, unknown>; global?: Record<string, unknown>; workflow?: string;
  autoPr?: boolean; prMode?: string; clonePermission?: string;
  openCode?: { workerPath: string; workerVersion: string; workerBin: string };
  guard?: { workerLimit: string; eventCount: number };
}) {
  writeFileSync(join(f.project, '.takt/config.yaml'), JSON.stringify({ provider: 'mock', concurrency: 2, ...options.project }));
  const globalPath = join(f.directory, 'config.yaml');
  writeFileSync(globalPath, JSON.stringify({ ...parseYaml(readFileSync(globalPath, 'utf8')), ...options.global }));
  writeFileSync(join(f.project, '.takt/workflows/remote-fixture.yaml'), options.workflow ??
    'name: remote-fixture\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: verify\n  - name: verify\n    instruction: Verify\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, auto_pr: options.autoPr ?? false,
    draft_pr: true, managed_pr: options.autoPr === true, worktree: options.autoPr === true || task.worktree })) }));
  let observation = '';
  const worker = f.cliWorker(f.registered.token, { forbiddenDirectories: [f.directory], prepare(home, config) {
    observation = join(home, 'observations.jsonl');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.yaml'), 'provider: mock\nlanguage: en\nignore_exceed: false\n');
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Remote test\n  email = remote@example.test\n');
    const hook = join(home, 'configured-provider.mjs');
    writeFileSync(hook, `
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/providers/mock.js')).href)};
import { GitHubProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/github/GitHubProvider.js')).href)};
import * as paths from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/config/global/globalConfigResolvers.js')).href)};
import { openCodeRuntimeSelection } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/opencode/runtime.js')).href)};
import { OpenCodeProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/providers/opencode.js')).href)};
import { resolveConfigValue } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/config/resolveConfigValue.js')).href)};
import { resolveOpenCodeGuardSuite } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/infra/opencode/guards/index.js')).href)};
const record = value => appendFileSync(${JSON.stringify(observation)}, JSON.stringify(value) + '\\n');
const cliNames = ['Codex', 'Claude', 'Cursor', 'Copilot', 'Kiro', 'Devin'];
if (process.argv.includes('worker')) {
  for (const name of cliNames) process.env['TAKT_' + name.toUpperCase() + '_CLI_PATH'] = '/worker-conflicting-cli';
  process.env.MCP_WORKER_AUTH = 'worker-mcp-auth';
  process.env.OPENAI_API_KEY = 'worker-provider-auth';
  process.env.GIT_ASKPASS = '/worker-git-auth';
  if (${JSON.stringify(options.guard !== undefined)}) {
    process.env.TAKT_OPENCODE_STREAM_EVENT_LIMIT = ${JSON.stringify(options.guard?.workerLimit)};
    record({ kind: 'worker-guard', eventLimit: process.env.TAKT_OPENCODE_STREAM_EVENT_LIMIT });
  }
  if (${JSON.stringify(options.openCode !== undefined)}) {
    process.env.TAKT_OPENCODE_PATH = ${JSON.stringify(options.openCode?.workerPath)};
    process.env.TAKT_OPENCODE_VERSION = ${JSON.stringify(options.openCode?.workerVersion)};
    process.env.PATH = ${JSON.stringify(options.openCode?.workerBin)} + ':' + process.env.PATH;
    record({ kind: 'worker-selection', path: process.env.TAKT_OPENCODE_PATH, version: process.env.TAKT_OPENCODE_VERSION });
  }
}
GitHubProvider.prototype.findExistingPr = function(branch, cwd) {
  record({ kind: 'find', branch, cwd });
  if (${JSON.stringify(options.prMode)} === 'throw') throw new Error('Unexpected PR failure');
  return ['update', 'comment-fail'].includes(${JSON.stringify(options.prMode)}) ? { number: 17, url: 'https://example.test/pr/17' } : undefined;
};
GitHubProvider.prototype.createPullRequest = function(value, cwd) {
  record({ kind: 'create', value, cwd });
  return ${JSON.stringify(options.prMode)} === 'create-fail' ? { success: false, error: 'Creation rejected' } : { success: true, url: 'https://example.test/pr/17' };
};
GitHubProvider.prototype.commentOnPr = function(number, body, cwd) {
  record({ kind: 'comment', number, body, cwd });
  return { success: ${JSON.stringify(options.prMode !== 'comment-fail')} };
};
MockProvider.prototype.setup = config => ({ call: async (prompt, call) => {
  if (${JSON.stringify(options.guard !== undefined)}) {
    const guards = resolveConfigValue(call.cwd, 'providerOptions')?.opencode?.guards;
    const suite = resolveOpenCodeGuardSuite(guards, 'probe/probe');
    let failure;
    for (let index = 0; index < ${JSON.stringify(options.guard?.eventCount)}; index++) {
      const result = suite.onEvent({ type: 'message.updated', properties: { info: {
        id: 'guard-message-' + index, sessionID: 'guard-session', role: 'assistant', time: { completed: 1 },
      } } });
      if (result.failure !== undefined) {
        failure = { guardId: result.failure.guardId, reason: result.failure.verdict.reason, at: index + 1 };
        break;
      }
    }
    record({ kind: 'guard', configured: guards, profile: suite.profile, effectiveLimit: suite.policy.streamEventLimit,
      failure, pid: process.pid, auth: [process.env.MCP_WORKER_AUTH, process.env.OPENAI_API_KEY, process.env.GIT_ASKPASS] });
    if (failure !== undefined) return { persona: config.name, status: 'error', content: failure.reason,
      error: failure.reason, timestamp: new Date() };
  }
  if (${JSON.stringify(options.openCode !== undefined)}) {
    const observation = { kind: 'opencode', selection: openCodeRuntimeSelection(), pid: process.pid,
      auth: [process.env.MCP_WORKER_AUTH, process.env.OPENAI_API_KEY, process.env.GIT_ASKPASS] };
    try {
      await new OpenCodeProvider().preflight({ cwd: call.cwd, model: 'probe/probe', abortSignal: call.abortSignal });
      record(observation);
    } catch (error) { record({ ...observation, error: String(error) }); throw error; }
  }
  let cli;
  if (${JSON.stringify(options.global?.codex_cli_path !== undefined)}) cli = cliNames.map(name => paths['resolve' + name + 'CliPath']());
  record({ kind: 'agent', prompt, permission: call.permissionMode, cli,
    auth: [process.env.MCP_WORKER_AUTH, process.env.OPENAI_API_KEY, process.env.GIT_ASKPASS] });
  mkdirSync(join(call.cwd, '.takt'), { recursive: true });
  writeFileSync(join(call.cwd, '.takt/config.yaml'), JSON.stringify({ provider: 'mock', language: 'en',
    provider_profiles: { mock: { default_permission_mode: ${JSON.stringify(options.clonePermission ?? 'full')} } } }));
  return { persona: config.name, status: 'done', content: 'completed', timestamp: new Date(), sessionId: randomUUID() };
} });
`);
    return ['--import', JSON.stringify(pathToFileURL(hook).href)].join(' ');
  } });
  await vi.waitFor(() => expect(['completed', 'failed', 'pr_failed']).toContain(f.store.read().tasks[0]!.status), { timeout: 30_000 });
  const observed = existsSync(observation) ? readFileSync(observation, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  return { worker, observed, task: f.store.read().tasks[0]! };
}

const permissionCases = [
  { name: 'project step', project: { default_permission_mode: 'full', step_permission_overrides: { work: 'readonly', verify: 'readonly' } }, global: { default_permission_mode: 'edit', step_permission_overrides: { work: 'full', verify: 'full' } }, expected: 'readonly' },
  { name: 'global step', project: { default_permission_mode: 'full' }, global: { default_permission_mode: 'readonly', step_permission_overrides: { work: 'edit', verify: 'edit' } }, expected: 'edit' },
  { name: 'project default', project: { default_permission_mode: 'full' }, global: { default_permission_mode: 'readonly' }, expected: 'full' },
  { name: 'global default', project: undefined, global: { default_permission_mode: 'readonly' }, expected: 'readonly' },
].flatMap((entry) => ['readonly', 'full'].map((clonePermission) => ({ ...entry, clonePermission })));

isolatedWorkerTest('preserves an environment reference in task text through input transfer and provider invocation', async () => {
  vi.stubEnv('REMOTE_TEST_KEY', 'fake-daemon-value');
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture();
    const task = '文字列 ${REMOTE_TEST_KEY} を説明する';
    f.store.update((current) => ({ tasks: current.tasks.map((record) => ({ ...record, content: task })) }));
    const workflow = 'name: remote-fixture\nsteps:\n  - name: work\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n';
    const result = await configuredRealWorker(f, { workflow });
    expect(result.task.status, result.worker.output()).toBe('completed');
    const agents = result.observed.filter((value) => value.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.prompt).toContain('$｛REMOTE_TEST_KEY｝');
    expect(agents[0]!.prompt).not.toContain('fake-daemon-value');
    const input = JSON.parse(readFileSync(join(f.project, '.takt/remote-executions', result.task.execution_id!, 'input/execution.json'), 'utf8'));
    expect(input.task).toBe(task);
    expect(JSON.stringify(input)).not.toContain('fake-daemon-value');
  } finally { await f?.close(); vi.unstubAllEnvs(); }
});

isolatedWorkerTest.each(permissionCases)('uses daemon $name permissions despite clone permission=$clonePermission', async (entry) => {
  const f = await fixture();
  try {
    const result = await configuredRealWorker(f, { project: { language: 'ja', provider_profiles: entry.project ? { mock: entry.project } : undefined },
      global: { provider_profiles: { mock: entry.global } }, clonePermission: entry.clonePermission });
    expect(result.task.status, result.worker.output()).toBe('completed');
    expect(result.observed.filter((value) => value.kind === 'agent').map((value) => value.permission)).toEqual([entry.expected, entry.expected]);
  } finally { await f.close(); }
});

isolatedWorkerTest.each(['ja', 'en'] as const)('uses daemon %s instructions and configured CLI paths while keeping worker authentication', async (language) => {
  const f = await fixture();
  try {
    const cliPath = language === 'ja' ? '/bin/echo' : '/usr/bin/true';
    const cli = Object.fromEntries(['codex', 'claude', 'cursor', 'copilot', 'kiro', 'devin'].map((name) => [`${name}_cli_path`, cliPath]));
    const workflow = 'name: remote-fixture\nreport_formats:\n  result-format: "# Result"\nsteps:\n  - name: work\n    edit: true\n    instruction: Work\n    output_contracts:\n      report:\n        - name: result.md\n          format: result-format\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n';
    const result = await configuredRealWorker(f, { project: { language, provider_profiles: { mock: { default_permission_mode: 'readonly' } } }, global: cli, workflow });
    expect(result.task.status, result.worker.output()).toBe('completed');
    const agents = result.observed.filter((value) => value.kind === 'agent');
    expect(agents.length).toBeGreaterThan(1);
    expect(agents[0]!.permission).toBe('edit');
    expect(agents.map((value) => value.prompt).join('\n')).toContain(language === 'ja' ? '## 作業結果' : '## Work Results');
    for (const agent of agents) { expect(agent.cli).toEqual(Array(6).fill(cliPath)); expect(agent.auth).toEqual(['worker-mcp-auth', 'worker-provider-auth', '/worker-git-auth']); }
  } finally { await f.close(); }
});

isolatedWorkerTest.each([
  { name: 'explicit baseline', daemonVersion: 'v2', workerPath: 'A', workerVersion: 'v2', pathCliVersion: '2.0.18', success: true },
  { name: 'conflicting worker path', daemonVersion: 'v2', workerPath: 'B', workerVersion: 'v2', pathCliVersion: '2.0.18', success: true },
  { name: 'conflicting worker generation', daemonVersion: 'v2', workerPath: 'A', workerVersion: 'v1', pathCliVersion: '2.0.18', success: true },
  { name: 'incompatible daemon generation', daemonVersion: 'v1', workerPath: 'A', workerVersion: 'v2', pathCliVersion: '2.0.18', success: false },
  { name: 'unspecified daemon selection', daemonVersion: undefined, workerPath: 'B', workerVersion: 'v1', pathCliVersion: '2.0.18', success: true },
  { name: 'incompatible default CLI', daemonVersion: undefined, workerPath: 'B', workerVersion: 'v1', pathCliVersion: '1.18.2', success: false },
])('resolves transferred OpenCode selection in the task child: $name', async (entry) => {
  const cliDirectory = mkdtempSync(join(tmpdir(), 'takt-remote-opencode-'));
  const probesPath = join(cliDirectory, 'probes.jsonl');
  const paths = { A: join(cliDirectory, 'daemon-opencode'), B: join(cliDirectory, 'worker-opencode') };
  for (const [path, name, version] of [[paths.A, 'A', '2.0.18'], [paths.B, 'B', '2.0.18'],
    [join(cliDirectory, 'opencode'), 'PATH', entry.pathCliVersion]]) {
    writeFileSync(path!, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(probesPath)}, JSON.stringify({ name: ${JSON.stringify(name)}, ppid: process.ppid, args: process.argv.slice(2) }) + '\\n');\nprocess.stdout.write(${JSON.stringify(version + '\n')});\n`, { mode: 0o755 });
  }
  vi.stubEnv('TAKT_OPENCODE_PATH', entry.daemonVersion === undefined ? undefined : paths.A);
  vi.stubEnv('TAKT_OPENCODE_VERSION', entry.daemonVersion);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture();
    expect(existsSync(probesPath)).toBe(false);
    const result = await configuredRealWorker(f, {
      workflow: 'name: remote-fixture\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n',
      openCode: { workerPath: entry.workerPath === 'A' ? paths.A : paths.B, workerVersion: entry.workerVersion, workerBin: cliDirectory },
    });
    expect(result.task.status, result.worker.output()).toBe(entry.success ? 'completed' : 'failed');
    expect(result.task.completion?.success).toBe(entry.success);
    expect(result.observed.find((value) => value.kind === 'worker-selection')).toMatchObject({
      path: entry.workerPath === 'A' ? paths.A : paths.B, version: entry.workerVersion,
    });
    const observations = result.observed.filter((value) => value.kind === 'opencode');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ selection: {
      command: entry.daemonVersion === undefined ? 'opencode' : paths.A, generation: entry.daemonVersion ?? 'v2',
    }, auth: ['worker-mcp-auth', 'worker-provider-auth', '/worker-git-auth'] });
    if (entry.success) expect(observations[0]).not.toHaveProperty('error');
    else {
      expect(observations[0]?.error).toMatch(/incompatible/);
      expect(result.task.failure?.error).toEqual(expect.any(String));
    }
    const probes = readFileSync(probesPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(probes).toEqual([{ name: entry.daemonVersion === undefined ? 'PATH' : 'A', ppid: observations[0]!.pid, args: ['--version'] }]);
  } finally { await f?.close(); vi.unstubAllEnvs(); rmSync(cliDirectory, { recursive: true, force: true }); }
});

isolatedWorkerTest.each([
  { name: 'configured boundary', daemon: undefined, worker: '3', events: 2, limit: 2, success: true },
  { name: 'configured overflow', daemon: undefined, worker: '3', events: 3, limit: 2, success: false },
  { name: 'daemon override boundary', daemon: '3', worker: '2', events: 3, limit: 3, success: true },
  { name: 'daemon override overflow', daemon: '3', worker: '2', events: 4, limit: 3, success: false },
  { name: 'equal worker overflow', daemon: '3', worker: '3', events: 4, limit: 3, success: false },
  { name: 'larger worker overflow', daemon: '3', worker: '100', events: 4, limit: 3, success: false },
])('uses daemon OpenCode event limit in the real task child: $name', async (entry) => {
  vi.stubEnv('TAKT_OPENCODE_STREAM_EVENT_LIMIT', entry.daemon);
  const f = await fixture();
  try {
    const result = await configuredRealWorker(f, {
      project: { provider_options: { opencode: { guards: { profile: 'minimal', event_limit: 2 } } } },
      workflow: 'name: remote-fixture\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n',
      guard: { workerLimit: entry.worker, eventCount: entry.events },
    });
    expect(result.task.status, JSON.stringify(result.task.failure) + result.worker.output()).toBe(entry.success ? 'completed' : 'failed');
    expect(result.task.completion?.success).toBe(entry.success);
    expect(result.observed.find((value) => value.kind === 'worker-guard')).toMatchObject({ eventLimit: entry.worker });
    const guards = result.observed.filter((value) => value.kind === 'guard');
    // Provider errors receive one fresh Phase 1 retry.
    expect(guards).toHaveLength(entry.success ? 1 : 2);
    for (const guard of guards) {
      expect(guard).toMatchObject({ configured: { profile: 'minimal', eventLimit: 2 }, profile: 'minimal',
        effectiveLimit: entry.limit, auth: ['worker-mcp-auth', 'worker-provider-auth', '/worker-git-auth'] });
      if (entry.success) expect(guard.failure).toBeUndefined();
      else expect(guard.failure).toMatchObject({ guardId: 'event-count', reason: expect.stringContaining('event_count'), at: entry.limit + 1 });
    }
    if (!entry.success) expect(result.task.failure?.error).toContain('event_count');
  } finally { await f.close(); vi.unstubAllEnvs(); }
});

isolatedWorkerTest.each([false, true])('uses daemon iteration limit setting ignore_exceed=%s', async (ignore) => {
  const f = await fixture();
  try {
    const workflow = 'name: remote-fixture\nmax_steps: 1\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: verify\n  - name: verify\n    instruction: Verify\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n';
    const result = await configuredRealWorker(f, { project: { ignore_exceed: ignore }, workflow });
    expect(result.task.completion?.workflowResult, result.worker.output()).toBe(ignore ? 'completed' : 'exceeded');
    expect(result.observed.filter((value) => value.kind === 'agent')).toHaveLength(ignore ? 2 : 1);
  } finally { await f.close(); }
});

isolatedWorkerTest.each(['create', 'update', 'disabled', 'create-fail', 'comment-fail', 'throw'])(
  'publishes remote PR results through storage and manager notification: %s', async (mode) => {
    const f = await fixture();
    try {
      const result = await configuredRealWorker(f, { autoPr: mode !== 'disabled', prMode: mode });
      const failed = mode.endsWith('-fail');
      expect(result.task.status, result.worker.output()).toBe(failed ? 'pr_failed' : mode === 'throw' ? 'failed' : 'completed');
      expect(result.task.completion?.success).toBe(!failed && mode !== 'throw');
      if (mode === 'throw') expect(result.task.completion).toMatchObject({ workflowResult: 'completed', sha: expect.stringMatching(/^[a-f0-9]{40}$/), failureReason: 'Unexpected PR failure' });
      if (mode === 'create' || mode === 'update') expect(result.task.pr_url).toBe('https://example.test/pr/17');
      if (mode === 'disabled') expect(result.observed.filter((value) => value.kind !== 'agent')).toEqual([]);
      if (mode === 'create') expect(result.observed.find((value) => value.kind === 'create')?.value).toMatchObject({ base: goalRecord().branch, draft: true, body: expect.any(String) });
      if (mode === 'update' || mode === 'comment-fail') expect(result.observed.filter((value) => value.kind === 'comment')).toHaveLength(1);
      await vi.waitFor(async () => {
        for (const runner of f.turnRunners) for (const call of runner.calls) if (!call.finished && !['task_completed', 'task_failed'].includes(call.input.event.event.kind)) await runner.finish(call);
        expect(f.turnRunners.flatMap((runner) => runner.calls.map((call) => call.input.event.event)))
          .toContainEqual(expect.objectContaining({ kind: failed || mode === 'throw' ? 'task_failed' : 'task_completed', result: expect.objectContaining({ success: !failed && mode !== 'throw' }) }));
      }, { timeout: 10_000 });
      expect(result.observed.filter((value) => value.kind === 'create' || value.kind === 'comment')).toHaveLength(mode === 'disabled' || mode === 'throw' ? 0 : 1);
    } finally { await f.close(); }
  });

async function waitForControlAcknowledgement(f: Awaited<ReturnType<typeof fixture>>, executionId: string, sequence: number) {
  await vi.waitFor(() => {
    const acknowledged = f.requests.some((request) => request.kind === 'execution' && request.assignment.executionId === executionId
      && request.command.kind === 'controls' && request.command.acknowledgedSequence === sequence
      && f.responses.some((response) => response.kind === 'execution' && response.requestId === request.requestId
        && response.response.kind === 'controls'));
    expect(acknowledged).toBe(true);
  }, { timeout: 10_000 });
}

isolatedWorkerTest('delivers an instruction and a stop to the same real execution and waits for the executor to stop', async () => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  try {
    const first = await worker.wait(1);
    await vi.waitFor(() => expect(runPage(f)).toMatchObject({ currentStep: 'work' }), { timeout: 10_000 });
    const runSlug = f.store.read().tasks[0]!.run_slug!;
    const content = '境界条件を確認する\n' + 'あ'.repeat(50_000);
    const told = await tellTaktRun({ cwd: f.project, runSlug, content });
    expect(told.isError, firstTextContent(told.content)).not.toBe(true);
    await vi.waitFor(() => expect(readFileSync(join(f.project, '.takt/runs', runSlug, 'remote-controls.jsonl'), 'utf8')).toContain('境界条件を確認する'), { timeout: 10_000 });
    worker.release(first);
    const second = await worker.wait(2, first.executionId);
    expect(second).toMatchObject({ pid: first.pid, denied: 'EPERM' });
    expect(second.prompt).toContain(content);
    await vi.waitFor(() => expect(runPage(f)).toMatchObject({ currentStep: 'work' }), { timeout: 10_000 });
    await vi.waitFor(() => {
      const instructions = getTaktRun({ cwd: f.project, runSlug, view: 'instructions', instructionId: 1 });
      expect(instructions.isError).not.toBe(true);
      expect(firstTextContent(instructions.content)).toContain('deliveredSameSession');
    }, { timeout: 10_000 });
    const stopped = await stopTaktGoalTask({ cwd: f.project, goalId: goalRecord().id,
      taskName: f.task.name, executionId: first.executionId }, {}, new AbortController().signal);
    expect(stopped.isError, firstTextContent(stopped.content)).not.toBe(true);
    await vi.waitFor(() => expect(worker.aborted(second)).toBe(true), { timeout: 10_000 });
    await waitForControlAcknowledgement(f, first.executionId, 2);
    expect(f.store.read().tasks[0]!.status).toBe('running');
    worker.release(second);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!).toMatchObject({ status: 'failed',
      completion: { success: false, interrupted: true, workflowResult: 'aborted' } }), { timeout: 20_000 });
    expect(f.store.read().tasks[0]!.failure?.error).toMatch(/stopped by manager/);
    expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1');
    const receipts = readFileSync(join(f.project, '.takt/runs', runSlug, 'remote-controls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts.map((receipt) => receipt.kind)).toEqual(['tell', 'stop']);
    expect(worker.calls()).toHaveLength(2);
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each(['pause', 'abort'] as const)('delivers goal %s to the same real execution and retains its run records', async (action) => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  try {
    const call = await worker.wait(1);
    await vi.waitFor(() => expect(runPage(f)).toMatchObject({ currentStep: 'work' }), { timeout: 10_000 });
    const input = { cwd: f.project, goalId: goalRecord().id };
    const result = action === 'pause' ? await pauseTaktGoal(input, {}, new AbortController().signal)
      : await abortTaktGoal({ ...input, reason: 'Stop remote work' }, {}, new AbortController().signal);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    await vi.waitFor(() => expect(worker.aborted(call)).toBe(true), { timeout: 10_000 });
    await waitForControlAcknowledgement(f, call.executionId, 1);
    expect(f.store.read().tasks[0]!.status).toBe('running');
    worker.release(call);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!).toMatchObject({ status: 'failed',
      failure: { retryable: action === 'pause' }, completion: { interrupted: true, workflowResult: 'aborted' } }), { timeout: 20_000 });
    expect(f.store.read().tasks[0]!.failure?.error).toContain(action === 'pause' ? 'paused' : 'aborted');
    expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1');
    expect(worker.calls()).toHaveLength(1);
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each([false, true])('continues the same real executor and transfers missing records after reconnect with daemon restart=%s', async (restart) => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  try {
    const first = await worker.wait(1);
    await vi.waitFor(() => expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1'), { timeout: 10_000 });
    const before = f.store.read().tasks[0]!;
    const logs = new RemoteExecutionStore(f.project, first.executionId);
    const sequence = await logs.acknowledgedSequence();
    expect(sequence).toBeGreaterThan(0);
    const runSlug = before.run_slug!;
    const told = await tellTaktRun({ cwd: f.project, runSlug, content: '切断前の指示' });
    expect(told.isError, firstTextContent(told.content)).not.toBe(true);
    await waitForControlAcknowledgement(f, first.executionId, 1);
    f.disconnect();
    const pending = await tellTaktRun({ cwd: f.project, runSlug, content: '再接続後に適用する指示' });
    expect(pending.isError, firstTextContent(pending.content)).not.toBe(true);
    if (restart) await f.stopDaemon();
    worker.release(first); const second = await worker.wait(2, first.executionId);
    expect(second.pid).toBe(first.pid);
    expect(second.prompt).toContain('切断前の指示');
    worker.release(second);
    const third = await worker.wait(3, first.executionId);
    expect(third).toMatchObject({ pid: first.pid, denied: 'EPERM' });
    expect(third.prompt).toContain('Verify the result');
    expect(third.prompt).not.toContain('再接続後に適用する指示');
    expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1');
    expect(runPage(f).stepLogs).toEqual([]);
    const deadline = f.store.read().tasks[0]!.remote_assignment!.leaseExpiresAt;
    if (restart) {
      await f.start();
      expect(f.store.read().tasks[0]!.remote_assignment!.leaseExpiresAt).toBe(deadline);
    }
    f.resume();
    await vi.waitFor(() => expect(runPage(f)).toMatchObject({ currentStep: 'verify' }), { timeout: 15_000 });
    await vi.waitFor(() => expect(JSON.stringify(runPage(f, 'report', 'phase-2.md'))).toContain('remote report 2'), { timeout: 10_000 });
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'running', execution_id: first.executionId });
    expect(await logs.acknowledgedSequence()).toBeGreaterThan(sequence);
    await waitForControlAcknowledgement(f, first.executionId, 2);
    await vi.waitFor(() => expect(JSON.stringify(runPage(f, 'log')).match(/remote log 2/g)).toHaveLength(1), { timeout: 10_000 });
    const completedWork = (runPage(f).stepLogs as { step: string; index: number }[]).filter((entry) => entry.step === 'work');
    expect(completedWork).toHaveLength(1);
    const workIndex = completedWork[0]!.index;
    expect(JSON.stringify(runPage(f, 'log', undefined, workIndex)).match(/remote log 2/g)).toHaveLength(1);
    worker.release(third);
    const fourth = await worker.wait(4, first.executionId);
    expect(fourth).toMatchObject({ pid: first.pid, denied: 'EPERM' });
    expect(fourth.prompt).toContain('再接続後に適用する指示');
    await vi.waitFor(() => expect(runPage(f)).toMatchObject({ currentStep: 'verify' }), { timeout: 15_000 });
    expect(JSON.stringify(runPage(f, 'log', undefined, workIndex)).match(/remote log 2/g)).toHaveLength(1);
    worker.release(fourth);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 20_000 });
    expect(worker.calls()).toHaveLength(4);
    expect(JSON.stringify(runPage(f, 'log', undefined, workIndex)).match(/remote log 2/g)).toHaveLength(1);
    expect(f.store.read().tasks[0]!.remote_artifacts?.finalLogSequence).toBe(await logs.acknowledgedSequence());
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each([false, true])('keeps received records after expiry and refuses the stopped real executor result on reconnect with daemon restart=%s', async (restart) => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  try {
    const call = await worker.wait(1);
    await vi.waitFor(() => expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1'), { timeout: 10_000 });
    f.disconnect();
    if (restart) await f.stopDaemon();
    f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task,
      remote_assignment: { ...task.remote_assignment!, leaseExpiresAt: 0 } })) }));
    if (restart) await f.start();
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('failed'), { timeout: 10_000 });
    const failed = f.store.read().tasks[0]!;
    expect(failed.failure?.error).toMatch(/connection.*lost|lease expired/i);
    expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1');
    f.resume();
    await vi.waitFor(() => expect(worker.aborted(call)).toBe(true), { timeout: 10_000 });
    worker.release(call);
    await vi.waitFor(() => expect(f.requests.some((request) => request.kind === 'complete' && request.assignment.executionId === call.executionId)).toBe(true), { timeout: 10_000 });
    expect(f.store.read().tasks[0]).toEqual(failed);
    expect(failed.remote_artifacts).toBeUndefined();
    expect(worker.calls()).toHaveLength(1);
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each(['fetch', 'sha'] as const)('refuses the real executor artifacts after origin %s failure before daemon receipt', async (failure) => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  let intercepted = false;
  try {
    const first = await worker.wait(1); worker.release(first);
    const second = await worker.wait(2, first.executionId);
    f.interceptRequests((request) => {
      if (request.kind !== 'complete' || request.artifacts === undefined || intercepted) return;
      intercepted = true;
      expect(request.artifacts.sha).not.toBe(f.originalSha);
      const args = failure === 'fetch' ? ['update-ref', '-d', `refs/heads/${request.artifacts.branch}`]
        : ['update-ref', `refs/heads/${request.artifacts.branch}`, f.originalSha];
      expect(spawnSync('git', ['--git-dir', f.origin, ...args]).status).toBe(0);
    });
    worker.release(second);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('failed'), { timeout: 20_000 });
    expect(intercepted).toBe(true);
    const task = f.store.read().tasks[0]!;
    expect(task.completion).toMatchObject({ success: false });
    expect(task.remote_artifacts).toBeUndefined();
    expect(task.completion?.sha).toBeUndefined();
    expect(task.failure?.error).toMatch(failure === 'sha' ? /SHA does not match/ : /fetch|remote ref/);
    const merged = await mergeTaktGoalTask({ cwd: f.project, goalId: goalRecord().id, taskName: f.task.name,
      expectedSha: f.originalSha }, {}, new AbortController().signal);
    expect(merged.isError).toBe(true);
    expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1');
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest('stops the same real executor after registration removal and refuses its late artifacts', async () => {
  const f = await fixture(); const worker = controlledRealWorker(f);
  try {
    const call = await worker.wait(1);
    await vi.waitFor(() => expect(JSON.stringify(runPage(f, 'report', 'phase-1.md'))).toContain('remote report 1'), { timeout: 10_000 });
    await f.registry.remove('w1');
    await vi.waitFor(() => expect(worker.aborted(call)).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('failed'), { timeout: 10_000 });
    const failed = f.store.read().tasks[0]!;
    expect(failed.failure?.error).toMatch(/registration.*removed/i);
    worker.release(call);
    await vi.waitFor(() => expect(worker.calls()).toHaveLength(1));
    expect(f.store.read().tasks[0]).toEqual(failed);
    expect(failed.remote_artifacts).toBeUndefined();
  } finally { worker.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each([
  { workers: 1, perWorker: 1, projectLimit: 3, running: 1 },
  { workers: 2, perWorker: 1, projectLimit: 3, running: 2 },
  { workers: 2, perWorker: 1, projectLimit: 1, running: 1 },
  { workers: 1, perWorker: 2, projectLimit: 3, running: 2 },
])('limits real executions and refills a released slot with $workers workers, worker limit $perWorker and project limit $projectLimit', async ({ workers, perWorker, projectLimit, running }) => {
  const f = await fixture();
  const clients: ReturnType<typeof controlledRealWorker>[] = [];
  try {
    writeFileSync(join(f.project, '.takt/config.yaml'), `provider: mock\nconcurrency: ${projectLimit}\n`);
    const runner = new TaskRunner(f.project);
    for (let index = 1; index < 3; index++) runner.addTask(`Independent task ${index}`, {
      goal_id: goalRecord().id, base_branch: goalRecord().branch, workflow: 'remote-fixture', worktree: false,
    });
    await vi.waitFor(async () => {
      const waiting = JSON.parse(firstTextContent((await listTaktTasks({ cwd: f.project })).content));
      expect(waiting.tasks).toHaveLength(3);
      expect(waiting.tasks.every((task: { waitingReason?: string }) => task.waitingReason?.includes('No executable worker'))).toBe(true);
    }, { timeout: 10_000 });
    expect(f.store.read().tasks.every((task) => task.status === 'pending')).toBe(true);
    await f.registry.remove('w1');
    for (let index = 1; index <= workers; index++) {
      const registered = await f.registry.add(`w${index}`, perWorker);
      clients.push(controlledRealWorker(f, registered.token));
    }
    const calls = () => clients.flatMap((client) => client.calls());
    const executions = () => [...new Set(calls().map((call) => call.executionId))];
    await vi.waitFor(() => expect(executions()).toHaveLength(running), { timeout: 25_000 });
    expect(f.store.read().tasks.filter((task) => task.status === 'running')).toHaveLength(running);
    expect(f.store.read().tasks.filter((task) => task.status === 'pending')).toHaveLength(3 - running);
    await vi.waitFor(async () => {
      const listed = JSON.parse(firstTextContent((await listTaktTasks({ cwd: f.project })).content));
      expect(listed.tasks.filter((task: { status: string }) => task.status === 'pending')
        .every((task: { waitingReason?: string }) => task.waitingReason?.includes('Waiting for an available worker slot'))).toBe(true);
    }, { timeout: 10_000 });
    expect(calls().every((call) => call.denied === 'EPERM')).toBe(true);
    for (const client of clients) expect(new Set(client.calls().map((call) => call.executionId)).size).toBeLessThanOrEqual(perWorker);
    const first = calls()[0]!;
    const owner = clients.find((client) => client.calls().some((call) => call.executionId === first.executionId))!;
    owner.release(first);
    owner.release(await owner.wait(2, first.executionId));
    await vi.waitFor(() => expect(f.store.read().tasks.some((task) => task.execution_id === first.executionId && task.status === 'completed')).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(executions()).toHaveLength(running + 1), { timeout: 20_000 });
    expect(f.store.read().tasks.filter((task) => task.status === 'running')).toHaveLength(running);
    const listed = JSON.parse(firstTextContent((await listTaktTasks({ cwd: f.project })).content));
    expect(listed.tasks.filter((task: { status: string }) => task.status === 'running').every((task: { workerName: string }) => /^w[12]$/.test(task.workerName))).toBe(true);
    expect(listed.tasks.filter((task: { status: string }) => task.status === 'running').every((task: { waitingReason?: string }) => task.waitingReason === undefined)).toBe(true);
  } finally { for (const client of clients) client.releaseAll(); await f.close(); }
});

isolatedWorkerTest.each(['originless', 'pr-merge'] as const)('keeps %s work out of the connected executable remote worker', async (kind) => {
  const f = await fixture(); const client = controlledRealWorker(f);
  try {
    if (kind === 'originless') {
      const removed = spawnSync('git', ['-C', f.project, 'remote', 'remove', 'origin']);
      expect(removed.status).toBe(0);
    } else f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, source: 'pr_review', pr_number: 123,
      merge_task: true, branch: 'remote-pr', worktree: true, base_branch: goalRecord().branch,
      merge_method: 'squash', merge_head_repository_url: f.origin, merge_head_repository_push_urls: [f.origin],
      merge_initial_head_sha: f.originalSha, merge_threat_check_max_diff_bytes: 0, merge_clone_prepared: false })) }));
    await vi.waitFor(() => expect(f.responses.some((response) => response.kind === 'heartbeat')).toBe(true), { timeout: 15_000 });
    expect(f.store.read().tasks[0]!.status).toBe('pending');
    expect(client.calls()).toEqual([]);
    expect(f.responses.filter((response) => response.kind === 'assignment' && response.assignment !== null)).toEqual([]);
  } finally { client.releaseAll(); await f.close(); }
});

isolatedWorkerTest('shares one real worker between two repositories while keeping one active execution per project', async () => {
  const f = await fixture();
  const project = mkdtempSync(join(f.directory, 'second-project-'));
  const origin = mkdtempSync(join(tmpdir(), 'takt-second-origin-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  expect(spawnSync('git', ['init', '--bare', origin]).status).toBe(0);
  git('init', '-b', 'main'); git('config', 'user.name', 'Remote fixture'); git('config', 'user.email', 'remote@example.test');
  git('commit', '--allow-empty', '-m', 'Second repository'); git('remote', 'add', 'origin', origin);
  const goal = await new GoalStore(project).create(goalRecord()); git('branch', goal.branch);
  mkdirSync(join(project, '.takt/workflows'), { recursive: true });
  writeFileSync(join(project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 1\n');
  writeFileSync(join(f.project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 1\n');
  const runner = new TaskRunner(f.project); const secondRunner = new TaskRunner(project);
  runner.addTask('Another first-project task', { goal_id: goal.id, base_branch: goal.branch, workflow: 'remote-fixture', worktree: false });
  for (let index = 0; index < 2; index++) secondRunner.addTask(`Second-project task ${index}`, {
    goal_id: goal.id, base_branch: goal.branch, workflow: 'remote-fixture', worktree: false,
  });
  const client = controlledRealWorker(f, f.registered.token, [f.project, project]);
  writeFileSync(join(project, '.takt/workflows/remote-fixture.yaml'), readFileSync(join(f.project, '.takt/workflows/remote-fixture.yaml')));
  await registerProject({ globalConfigDirectory: f.directory, projectDirectory: project, command: 'manager', managerUsed: true });
  const secondStore = new TaskStore(project);
  try {
    await vi.waitFor(() => expect(client.calls().filter((call) => call.number === 1)).toHaveLength(2), { timeout: 25_000 });
    for (const store of [f.store, secondStore]) {
      expect(store.read().tasks.filter((task) => task.status === 'running')).toHaveLength(1);
      expect(store.read().tasks.filter((task) => task.status === 'pending')).toHaveLength(1);
      expect(store.read().tasks.find((task) => task.status === 'running')!.worker_name).toBe('w1');
    }
    expect(client.calls().every((call) => call.denied === 'EPERM')).toBe(true);
  } finally { client.releaseAll(); await f.close(); rmSync(origin, { recursive: true, force: true }); }
});

it('exposes only the worker endpoint and rejects conversation messages on the network listener', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`http://127.0.0.1:${f.port}/conversation`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(404);
    const invalid = await fetch(`http://127.0.0.1:${f.port}/worker`, { method: 'POST',
      headers: { authorization: `Bearer ${f.registered.token}` }, body: JSON.stringify({ kind: 'human_command', text: 'private conversation' }) + '\n',
      signal: AbortSignal.timeout(10_000) });
    expect(await invalid.json()).toEqual({ kind: 'rejected', reason: 'Invalid worker protocol message' });
    expect(f.store.read().tasks[0]!.status).toBe('pending');
  } finally { await f.close(); }
});

it('rejects unregistered, removed and mismatched-version workers before any task is delivered and accepts the new registration', async () => {
  const f = await fixture();
  try {
    const altered = f.registered.token.slice(0, -2) + 'xx';
    const unregistered = f.worker(altered);
    expect((await unregistered.wait('rejected')).reason).toMatch(/not registered|removed/i);
    await unregistered.closed;
    await f.registry.remove('w1'); const replacement = await f.registry.add('w1', 2);
    expect(replacement.registration.registrationGeneration).not.toBe(f.registered.registration.registrationGeneration);
    const old = f.worker(); expect((await old.wait('rejected')).reason).toMatch(/not registered|removed/i); await old.closed;
    const mismatched = f.worker(replacement.token, 'different-version');
    expect((await mismatched.wait('rejected')).reason).toMatch(/version/i); await mismatched.closed;
    for (const worker of [unregistered, old, mismatched]) expect(worker.events.some((event) => event.kind === 'started')).toBe(false);
    expect(f.store.read().tasks[0]!.status).toBe('pending');
    const current = f.worker(replacement.token); await current.wait('started');
    expect(f.store.read().tasks[0]!.remote_assignment?.registrationGeneration).toBe(replacement.registration.registrationGeneration);
  } finally { await f.close(); }
});

it('keeps the same worker and executor through disconnection and a daemon restart without granting a new lease at restore', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(); const started = await worker.wait('started');
    const executionId = started.assignment!.executionId;
    f.disconnect(); await f.stopDaemon();
    await vi.waitFor(() => expect(f.refusedConnections).toBeGreaterThan(0), { timeout: 10_000 });
    const deadline = f.store.read().tasks[0]!.remote_assignment!.leaseExpiresAt;
    await f.start();
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'running', remote_assignment: { executionId, leaseExpiresAt: deadline } });
    expect(worker.events.filter((event) => event.kind === 'rejected')).toEqual([]);
    expect(worker.events.filter((event) => event.kind === 'stopped')).toHaveLength(0);
    f.resume(); await worker.wait('connected', 2);
    expect(worker.events.filter((event) => event.kind === 'started')).toHaveLength(1);
    expect(worker.child.pid).toBe(started.pid);
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'running', remote_assignment: { executionId } });
    worker.child.send({ kind: 'complete', executionId });
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 10_000 });
  } finally { await f.close(); }
});

it('stops the same executor on reconnect after an expired saved lease and preserves the failed task', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(f.registered.token, packageVersion, 'late-expired'); const started = await worker.wait('started');
    f.disconnect(); await f.stopDaemon();
    f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task,
      remote_assignment: { ...task.remote_assignment!, leaseExpiresAt: Date.now() - 1 } })) }));
    await f.start();
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'failed', failure: { error: expect.stringMatching(/connection.*lost/i) } });
    f.resume(); const stopped = await worker.wait('stopped');
    expect(stopped.executionId).toBe(started.assignment!.executionId);
    expect(stopped.pid).toBe(started.pid);
    await vi.waitFor(() => expect(worker.events.filter((event) => event.kind === 'connected')).toHaveLength(2), { timeout: 10_000 });
    expect(worker.events.filter((event) => event.kind === 'started')).toHaveLength(1);
    worker.child.send({ kind: 'late-complete', executionId: started.assignment!.executionId });
    expect((await worker.wait('late-sent')).pid).toBe(started.pid);
    await vi.waitFor(() => {
      const complete = f.requests.find((request) => request.kind === 'complete' && request.assignment.executionId === started.assignment!.executionId);
      expect(complete).toBeDefined();
      expect(f.responses).toContainEqual(expect.objectContaining({ kind: 'completed', requestId: complete!.requestId, accepted: false }));
    }, { timeout: 10_000 });
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'failed', failure: { error: expect.stringMatching(/connection.*lost/i) } });
  } finally { await f.close(); }
});

it('applies registration removal to the live connection and stops its existing executor', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(f.registered.token, packageVersion, 'late-removed'); const started = await worker.wait('started');
    const removed = await new AsyncCommand().run({ executable: process.execPath,
      args: [join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier', 'worker', 'remove', 'w1'],
      cwd: f.project, env: { ...process.env, TAKT_CONFIG_DIR: f.directory, NODE_OPTIONS: '' }, maxOutputBytes: 64 * 1024,
    }, { signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(removed.code, Buffer.from(removed.stderr).toString()).toBe(0);
    const stopped = await worker.wait('stopped'); await worker.wait('rejected');
    expect(stopped.executionId).toBe(started.assignment!.executionId);
    await vi.waitFor(() => expect(f.store.read().tasks[0]!).toMatchObject({
      status: 'failed', failure: { error: expect.stringMatching(/registration.*removed/i) },
    }), { timeout: 10_000 });
    expect(worker.events.filter((event) => event.kind === 'started')).toHaveLength(1);
    worker.child.send({ kind: 'late-complete', executionId: started.assignment!.executionId });
    const result = await worker.wait('late-result');
    expect(result.pid).toBe(started.pid);
    expect(result.response).toMatchObject({ kind: 'rejected', reason: expect.stringMatching(/not registered|removed/i) });
    expect(f.requests.some((request) => request.kind === 'complete' && request.assignment.executionId === started.assignment!.executionId)).toBe(true);
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'failed', failure: { error: expect.stringMatching(/registration.*removed/i) } });
  } finally { await f.close(); }
});

it.each(['unregistered', 'removed', 'version'] as const)('prints a reason and exits the public CLI for %s rejection without receiving task data', async (condition) => {
  const f = await fixture(condition === 'version' ? { version: 'different-version' } : {});
  try {
    let token = f.registered.token;
    if (condition === 'unregistered') token = token.slice(0, -2) + 'xx';
    if (condition === 'removed') await f.registry.remove('w1');
    const worker = f.cliWorker(token);
    await vi.waitFor(() => expect(worker.exit()).not.toBeUndefined(), { timeout: 20_000 });
    expect(worker.exit()).not.toBe(0);
    expect(worker.output()).toMatch(condition === 'version' ? /version/i : /not registered|removed/i);
    if (condition === 'version') expect(f.requests.some((request) => request.kind === 'connect')).toBe(true);
    expect(f.responses.length).toBeGreaterThan(0);
    expect(f.responses.every((response) => response.kind === 'rejected')).toBe(true);
    expect(f.responses).not.toContainEqual(expect.objectContaining({ assignment: expect.anything() }));
    expect(worker.output()).not.toContain(token);
    expect(f.store.read().tasks[0]!.status).toBe('pending');
  } finally { await f.close(); }
});

it('removes origin userinfo before snapshot, assignment, history and worker delivery', async () => {
  const f = await fixture({ origin: 'https://fixture:credential@example.invalid/project.git' });
  try {
    const worker = f.worker(); const started = await worker.wait('started');
    expect(started.assignment!.origin).toBe('https://example.invalid/project.git');
    expect(f.store.read().tasks[0]!.remote_assignment!.origin).toBe(started.assignment!.origin);
    expect(JSON.stringify(f.responses)).not.toMatch(/fixture:|credential/);
    expect(storedText(join(f.directory, 'worker-pull-responses'))).not.toMatch(/fixture:|credential/);
    expect(readFileSync(f.store.getTasksFilePath(), 'utf8')).not.toMatch(/fixture:|credential/);
    if (existsSync(join(f.directory, 'daemon-logs'))) expect(storedText(join(f.directory, 'daemon-logs'))).not.toMatch(/fixture:|credential/);
  } finally { await f.close(); }
});

it('keeps the same remote execution exclusive against public run and watch while the daemon is stopped', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(); const started = await worker.wait('started');
    f.disconnect(); await f.stopDaemon();
    const saved = f.store.read();
    for (const command of ['run', 'watch']) {
      const result = await new AsyncCommand().run({ executable: process.execPath,
        args: [join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier', command], cwd: f.project,
        env: { ...process.env, TAKT_CONFIG_DIR: f.directory, NODE_OPTIONS: '' }, maxOutputBytes: 64 * 1024,
      }, { signal: new AbortController().signal, timeoutMs: 10_000 });
      expect(result.code).not.toBe(0);
      expect(Buffer.from(result.stderr).toString() + Buffer.from(result.stdout).toString()).toMatch(/remote.*w1/i);
      expect(f.store.read()).toEqual(saved);
    }
    await f.start();
    expect(f.store.read().tasks[0]!.remote_assignment!.leaseExpiresAt).toBe(saved.tasks[0]!.remote_assignment!.leaseExpiresAt);
    f.resume(); await worker.wait('connected', 2);
    expect(worker.child.pid).toBe(started.pid);
    expect(worker.events.filter((event) => event.kind === 'started')).toHaveLength(1);
    worker.child.send({ kind: 'complete', executionId: started.assignment!.executionId });
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 10_000 });
  } finally { await f.close(); }
});

it('waits through heartbeats without response files and assigns work added to the same idle worker', async () => {
  const f = await fixture();
  try {
    const saved = f.store.read(); f.store.update(() => ({ tasks: [] }));
    const worker = f.worker(); await worker.wait('connected');
    const history = join(f.directory, 'worker-pull-responses');
    const size = () => existsSync(history) ? storedText(history).length : 0;
    const initial = size();
    await vi.waitFor(() => expect(f.responses.filter((response) => response.kind === 'heartbeat').length).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
    expect(size()).toBe(initial);
    expect(f.requests.filter((request) => request.kind === 'pull')).toHaveLength(1);
    expect(worker.events.filter((event) => event.kind === 'started')).toHaveLength(0);
    f.store.update(() => saved);
    const started = await worker.wait('started');
    expect(started.assignment!.taskName).toBe(f.task.name);
    expect(f.requests.filter((request) => request.kind === 'pull')[0]!.requestId).toBe(started.assignment!.requestId);
    expect(size()).toBeGreaterThan(initial);
  } finally { await f.close(); }
});

it('reclaims only a removed registration generation and preserves another registration history', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(); await worker.wait('started');
    const root = join(f.directory, 'worker-pull-responses');
    const first = join(root, f.registered.registration.registrationGeneration);
    const names = readdirSync(first);
    expect(names).toHaveLength(1);
    const other = await f.registry.add('w2', 0);
    const second = join(root, other.registration.registrationGeneration);
    mkdirSync(second, { mode: 0o700 });
    const response = JSON.parse(readFileSync(join(first, names[0]!), 'utf8')) as Record<string, unknown>;
    const content = JSON.stringify({ ...response, workerId: 'w2', registrationGeneration: other.registration.registrationGeneration,
      requestId: 'saved-empty', assignment: null });
    writeFileSync(join(second, 'saved.json'), content, { mode: 0o600 });
    await f.registry.remove('w1');
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(join(second, 'saved.json'), 'utf8')).toBe(content);
    await expect(f.registry.authorize(other.token, async (registration) => registration.name)).resolves.toBe('w2');
    await expect(f.registry.authorize(f.registered.token, async () => true)).rejects.toThrow();
  } finally { await f.close(); }
});
