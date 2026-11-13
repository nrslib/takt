import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { TaskDispatcher } from '../features/daemon/taskDispatcher.js';
import { RemoteWorkerRuntime } from '../features/workerPool/remoteWorkerRuntime.js';
import * as privateFile from '../infra/daemon/privateFile.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { WorkerRegistry } from '../infra/worker-pool/workerRegistry.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { packageVersion } from '../shared/package-info.js';
import { RemoteAssignmentSchema, executionIdentity, sameExecution, WorkerRejectedError, WorkerRequestSchema, WorkerResponseSchema,
  type WorkerConnectionSink, type RemoteProjectRequest, type RemoteProjectReply, type RemoteTaskRecord,
  type WorkerRequest, type RemoteAssignment, type WorkerResponse } from '../core/worker-pool/remoteProtocol.js';
import { createWorkerServer, connectWorkerTransport } from '../infra/worker-pool/remoteTransport.js';
import { randomUUID } from 'node:crypto';
import { ControlledTurnRunner, deferred } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { installDaemonErrorLog } from '../infra/daemon/diagnostics.js';
import { AsyncCommand } from '../infra/daemon/command.js';

interface WorkerEvent { kind: string; pid?: number; assignment?: RemoteAssignment; executionId?: string; reason?: string; response?: WorkerResponse }

function storedText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== '.git').map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? storedText(path) : entry.isFile() ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

it('keeps communication failures retryable while returning a terminal reason for authentication rejection', async () => {
  const token = 'private-test-token';
  const errors = vi.fn();
  const runtime = { receive: vi.fn(async (_token: string, _request: WorkerRequest, _sink: WorkerConnectionSink): Promise<void> => {
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
    else record.status = request.success ? 'completed' : 'failed';
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

async function fixture(options: { origin?: string; version?: string } = {}) {
  const directory = getGlobalConfigDir();
  const logger = new DaemonLogger(directory);
  const restoreLog = installDaemonErrorLog((message) => logger.write('error', message));
  const project = mkdtempSync(join(directory, 'remote-project-'));
  mkdirSync(join(project, '.takt'), { recursive: true });
  writeFileSync(join(project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 2\n');
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\ndaemon:\n  builtin_worker:\n    concurrency: 0\n  remote_worker:\n    host: 127.0.0.1\n    port: 0\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', project, ...args], { env: process.env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Worker test'); git('config', 'user.email', 'worker@example.test');
  git('commit', '--allow-empty', '-m', 'fixture'); git('remote', 'add', 'origin', options.origin ?? 'https://example.invalid/project.git');
  const goal = await new GoalStore(project).create(goalRecord()); git('branch', goal.branch);
  const originalSha = git('rev-parse', goal.branch);
  git('commit', '--allow-empty', '-m', 'Advance HEAD independently of the task base');
  const task = new TaskRunner(project).addTask('remote task', { goal_id: goal.id, base_branch: goal.branch, worktree: false });
  await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Test process identity is unavailable');
  const owner = { pid: process.pid, identity, version: options.version ?? packageVersion, cliPath: daemonEntryPath() };
  const registry = new WorkerRegistry(directory);
  const registered = await registry.add('w1', 2);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let controller: AbortController | undefined;
  let targetPort = 0;
  let blocked = false;
  let refusedConnections = 0;
  const sockets = new Set<Socket>();
  const requests: WorkerRequest[] = [];
  const responses: WorkerResponse[] = [];
  const observe = (socket: Socket, direction: 'request' | 'response') => {
    let buffer = '';
    socket.on('data', (bytes: Buffer) => {
      buffer += bytes.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line.startsWith('{')) continue;
        const value: unknown = JSON.parse(line);
        if (direction === 'request') { const parsed = WorkerRequestSchema.safeParse(value); if (parsed.success) requests.push(parsed.data); }
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
  const start = async () => {
    controller = new AbortController();
    await writeDaemonOwner(directory, owner);
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { const turns = new ControlledTurnRunner(); turns.bus = bus; return turns; } });
    if (daemon.workerPort === undefined) throw new Error('Worker listener is missing');
    targetPort = daemon.workerPort;
  };
  const disconnect = () => { blocked = true; for (const socket of sockets) socket.destroy(); };
  await start();
  const store = new TaskStore(project);
  return { project, task, store, directory, registry, registered, originalSha, start, disconnect, requests, responses,
    get port() { return targetPort; },
    get refusedConnections() { return refusedConnections; },
    resume() { blocked = false; },
    cliWorker(token = registered.token) {
      const home = mkdtempSync(join(tmpdir(), 'takt-remote-cli-worker-'));
      const config = join(home, '.takt');
      const child = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier',
        'worker', '--url', `http://127.0.0.1:${address.port}`, '--token', token], {
        cwd: home, env: { ...process.env, NODE_OPTIONS: '', HOME: home, USERPROFILE: home, TAKT_CONFIG_DIR: config },
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
    },
  };
}

it('authenticates a separate worker process and persists its assignment and worker name through the task list', async () => {
  const f = await fixture();
  try {
    const worker = f.worker(); const started = await worker.wait('started');
    expect(started.pid).not.toBe(process.pid);
    const assignment = started.assignment!;
    const saved = f.store.read().tasks[0]!;
    expect(saved).toMatchObject({ status: 'running', owner_pid: null, worker_name: 'w1', execution_id: assignment.executionId,
      remote_assignment: assignment });
    expect(assignment.origin).toBe('https://example.invalid/project.git');
    expect(assignment.originalSha).toBe(f.originalSha);
    const listed = await listTaktTasks({ cwd: f.project });
    expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ tasks: [expect.objectContaining({ name: f.task.name, workerName: 'w1' })] });
    expect(JSON.stringify(worker.events)).not.toContain(f.registered.token);
    expect(readFileSync(join(f.directory, 'workers.json'), 'utf8')).not.toContain(f.registered.token);
    expect(storedText(join(f.directory, 'worker-pull-responses'))).not.toContain(f.registered.token);
    worker.child.send({ kind: 'complete', executionId: assignment.executionId });
    await vi.waitFor(() => expect(f.store.read().tasks[0]!.status).toBe('completed'), { timeout: 10_000 });
    expect(storedText(f.directory)).not.toContain(f.registered.token);
  } finally { await f.close(); }
});

it('connects the public worker CLI without consuming pending tasks when no executor is configured', async () => {
  const f = await fixture();
  try {
    const listed = async () => JSON.parse(firstTextContent((await listTaktTasks({ cwd: f.project })).content)) as {
      tasks: { name: string; waitingReason?: string }[];
    };
    await vi.waitFor(async () => expect((await listed()).tasks[0]!.waitingReason).toMatch(/No executable worker/i), { timeout: 10_000 });
    const worker = f.cliWorker();
    await vi.waitFor(() => expect(worker.output()).toMatch(/w1 connected/), { timeout: 20_000 });
    expect(existsSync(worker.config)).toBe(false);
    await vi.waitFor(() => expect(f.responses.some((response) => response.kind === 'heartbeat')).toBe(true), { timeout: 10_000 });
    expect(f.requests.some((request) => request.kind === 'pull' || request.kind === 'complete')).toBe(false);
    expect(f.store.read().tasks[0]!).toMatchObject({ status: 'pending' });
    expect((await listed()).tasks[0]!.waitingReason).toMatch(/No executable worker/i);
    expect(worker.output()).not.toContain(f.registered.token);
    expect(storedText(f.directory)).not.toContain(f.registered.token);
    worker.child.kill('SIGTERM'); await worker.closed;
    const executable = f.worker(); await executable.wait('started');
    expect(f.store.read().tasks[0]!.status).toBe('running');
    expect((await listed()).tasks[0]!.waitingReason).toBeUndefined();
  } finally { await f.close(); }
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
    expect(f.requests.some((request) => request.kind === 'connect')).toBe(true);
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
