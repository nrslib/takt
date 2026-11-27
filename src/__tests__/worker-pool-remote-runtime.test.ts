import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { deferred } from './helpers/controlledDaemon.js';
import { RemoteWorkerRuntime } from '../features/workerPool/remoteWorkerRuntime.js';
import type { RemoteCredentialsConfig } from '../core/models/daemon-config-schema.js';
import { RemoteAssignmentSchema, WorkerRejectedError, WorkerRequestSchema, executionIdentity, sameExecution, type RemoteTaskRecord, type WorkerRegistration,
  type RemoteProjectRequest, type RemoteProjectReply, type WorkerRequest, type WorkerResponse } from '../core/worker-pool/remoteProtocol.js';

const doubles = vi.hoisted(() => ({
  workers: new Map<string, { registration: WorkerRegistration; registered: boolean }>(),
  events: [] as string[], list: vi.fn(), authorize: vi.fn(), files: new Map<string, Buffer>(), write: vi.fn(),
}));
vi.mock('../infra/daemon/privateFile.js', () => ({
  readPrivateFile: async (path: string) => doubles.files.get(path),
  writePrivateFile: async (path: string, bytes: string) => { doubles.write(path, bytes); doubles.files.set(path, Buffer.from(bytes)); },
}));
vi.mock('../infra/worker-pool/workerRegistry.js', () => ({ WORKER_PULL_RESPONSES_DIRECTORY: 'worker-pull-responses', WorkerRegistry: class {
  list() {
    doubles.list();
    doubles.events.push('list');
    return Promise.resolve([...doubles.workers.values()].filter((worker) => worker.registered).map((worker) => structuredClone(worker.registration)));
  }
  async authorize<T>(token: string, action: (registration: WorkerRegistration) => Promise<T>) {
    const worker = doubles.workers.get(token);
    const name = worker?.registration.name ?? 'unregistered';
    doubles.events.push(`authorize:${name}`);
    doubles.authorize(name);
    if (worker === undefined || !worker.registered) {
      doubles.events.push(`rejected:${name}`);
      throw new WorkerRejectedError('Worker registration was removed');
    }
    return action(structuredClone(worker.registration));
  }
} }));
beforeEach(() => {
  doubles.workers.clear(); doubles.events.length = 0; doubles.files.clear();
  doubles.write.mockReset(); doubles.authorize.mockReset(); doubles.list.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  let now = 1000;
  let snapshotAvailable = true;
  let refuseClaim = false;
  const records: RemoteTaskRecord[] = [];
  const pending = ['a', 'b', 'c'];
  const operations: RemoteProjectRequest[] = [];
  const remote = vi.fn(async (request: RemoteProjectRequest): Promise<RemoteProjectReply> => {
    operations.push(request);
    if (request.kind === 'claim') {
      if (refuseClaim) return { kind: 'claim', assignment: null };
      const index = pending.indexOf(request.taskName);
      if (index < 0) return { kind: 'claim', assignment: null };
      pending.splice(index, 1);
      const assignment = RemoteAssignmentSchema.parse({ projectId: '/project', taskName: request.taskName,
        workerId: request.workerId, workerName: request.workerId, registrationGeneration: request.registrationGeneration,
        executionId: randomUUID(), assignmentGeneration: 1, requestId: request.requestId, originalSha: 'a'.repeat(40),
        origin: 'https://example.test/repo.git', branch: 'result', leaseExpiresAt: request.leaseExpiresAt,
        lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
      records.push({ assignment, status: 'running' });
      return { kind: 'claim', assignment: structuredClone(assignment) };
    }
    const record = records.find((record) => record.status === 'running' && sameExecution(record.assignment, request.assignment));
    if (record === undefined || 'now' in request && record.assignment.leaseExpiresAt <= request.now) {
      return { kind: 'updated', record: null };
    }
    if (request.kind === 'execution') {
      if (request.command.kind !== 'record') throw new Error('Unexpected execution command in scheduler fixture');
      return { kind: 'execution', response: { kind: 'record', acknowledgedSequence: request.command.record.sequence } };
    }
    if (request.kind === 'renew') record.assignment.leaseExpiresAt = request.leaseExpiresAt;
    else if (request.kind === 'fail') { record.status = 'failed'; record.failureReason = request.reason; }
    else if (request.kind === 'finish') record.status = request.success ? 'completed' : 'failed';
    else throw new Error('Unexpected project request in scheduler fixture');
    return { kind: 'updated', record: structuredClone(record) };
  });
  const pool = {
    setRemoteWorkers: vi.fn(), dispatch: vi.fn(async () => {}), remoteRecords: () => snapshotAvailable ? structuredClone(records) : [],
    hasProjectSnapshot: () => snapshotAvailable,
    hasCompleteSnapshot: () => snapshotAvailable, restore: vi.fn(async () => {}),
    project: vi.fn((projectId: string) => projectId === '/project' ? ({ inspect: async () => ({ concurrency: 2, available: true, tasks: [] }),
      remote, start: async () => ({ kind: 'declined' as const }), setWaitingReasons: async () => ({ kind: 'updated' as const }), close: async () => {} }) : undefined),
    pull: vi.fn((workerName: string) => pending[0] === undefined ? undefined : { projectId: '/project', taskName: pending[0], workerName }),
    decline: vi.fn(), release: vi.fn(), close: async () => {},
    get activeTaskCount() { return records.filter((record) => record.status === 'running').length; },
  };
  const makeRuntime = (credentials?: RemoteCredentialsConfig) => new RemoteWorkerRuntime({ directory: '/config', dispatcher: pool, version: '1.0', now: () => now, credentials });
  const worker = (name: string) => {
    const token = `test-${name}`;
    const registration = { name, registrationGeneration: randomUUID(), concurrency: 2, tokenHash: 'a'.repeat(64) };
    const entry = { registration, registered: true };
    doubles.workers.set(token, entry);
    const messages: WorkerResponse[] = [];
    const sink = {
      send: (response: WorkerResponse) => { messages.push(response); doubles.events.push(`send:${name}:${response.kind}`); },
      close: vi.fn(() => { doubles.events.push(`close:${name}`); }),
      fail: vi.fn((error: unknown) => {
        doubles.events.push(`failed:${name}`);
        if (error instanceof WorkerRejectedError) sink.send({ kind: 'rejected', reason: error.message });
        sink.close();
      }),
    };
    const message = <T extends object>(body: T) => ({ protocolVersion: 1 as const, requestId: randomUUID() as string,
      workerId: name, registrationGeneration: registration.registrationGeneration, ...body });
    const send = (runtime: RemoteWorkerRuntime, request: WorkerRequest) => runtime.receive(token, request, sink);
    const connect = async (runtime: RemoteWorkerRuntime, canExecute = true) => send(runtime, message({ kind: 'connect' as const, version: '1.0', canExecute, active: [] }));
    const remove = () => { entry.registered = false; doubles.events.push(`remove:${name}`); };
    return { messages, sink, message, connect, send, remove };
  };
  return { pool, records, pending, operations, remote, makeRuntime, ...worker('w1'), worker,
    refuseClaim: (value: boolean) => { refuseClaim = value; },
    setSnapshotAvailable: (value: boolean) => { snapshotAvailable = value; },
    advance: (ms: number) => { now += ms; } };
}

const receiveCases = ['connect', 'heartbeat', 'complete', 'pull', 'check'] as const;

it('authenticates without registering a connection or changing task dispatch', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.authenticate('test-w1');
    expect(doubles.authorize).toHaveBeenCalledExactlyOnceWith('w1');
    expect(runtime.connectionCount).toBe(0);
    expect(f.pool.setRemoteWorkers).not.toHaveBeenCalled();
    expect(f.pool.dispatch).not.toHaveBeenCalled();
    expect(f.pool.pull).not.toHaveBeenCalled();
    expect(f.operations).toEqual([]);
    expect(f.messages).toEqual([]);
  } finally { await runtime.close(); }
});

it.each(['unregistered', 'removed', 'stopped'] as const)('rejects %s at connection authentication', async (condition) => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    if (condition === 'removed') f.remove();
    if (condition === 'stopped') await runtime.close();
    await expect(runtime.authenticate(condition === 'unregistered' ? 'unknown' : 'test-w1')).rejects.toBeInstanceOf(WorkerRejectedError);
    expect(runtime.connectionCount).toBe(0);
    expect(f.pool.dispatch).not.toHaveBeenCalled();
    expect(f.messages).toEqual([]);
  } finally { await runtime.close(); }
});

it.each([
  'valid', 'before-expiry', 'worker', 'connection-generation', 'assignment-worker', 'assignment-generation',
  'projectId', 'taskName', 'executionId', 'assignmentGeneration', 'missing-record',
  'pending', 'failed', 'completed', 'at-expiry', 'after-expiry', 'replaced-connection',
] as const)('delivers credentials only for a current valid assignment: %s', async (condition) => {
  vi.stubEnv('FIXTURE_REMOTE_API_KEY', 'fake-runtime-distributed-key');
  const f = fixture();
  const runtime = f.makeRuntime({ providers: { openai: '${FIXTURE_REMOTE_API_KEY}' } });
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const record = f.records[0]!;
    const request = f.message({ kind: 'execution' as const, assignment: executionIdentity(record.assignment),
      command: { kind: 'credentials' as const } });
    switch (condition) {
      case 'worker': request.workerId = 'w2'; break;
      case 'connection-generation': request.registrationGeneration = randomUUID(); break;
      case 'assignment-worker': request.assignment.workerId = 'w2'; break;
      case 'assignment-generation': request.assignment.registrationGeneration = randomUUID(); break;
      case 'projectId': request.assignment.projectId = '/other-project'; break;
      case 'taskName': request.assignment.taskName = 'other-task'; break;
      case 'executionId': request.assignment.executionId = randomUUID(); break;
      case 'assignmentGeneration': request.assignment.assignmentGeneration += 1; break;
      case 'missing-record': f.records.splice(0); break;
      case 'pending': case 'failed': case 'completed': record.status = condition; break;
      case 'before-expiry': f.advance(record.assignment.leaseExpiresAt - 1000 - 1); break;
      case 'at-expiry': f.advance(record.assignment.leaseExpiresAt - 1000); break;
      case 'after-expiry': f.advance(record.assignment.leaseExpiresAt - 1000 + 1); break;
      case 'replaced-connection': {
        const replacement = { ...f.sink, send: vi.fn(), close: vi.fn(), fail: vi.fn() };
        await runtime.receive('test-w1', f.message({ kind: 'connect', version: '1.0', canExecute: true, active: [] }), replacement);
        break;
      }
      case 'valid': break;
    }
    f.messages.length = 0;
    if (condition === 'valid' || condition === 'before-expiry') {
      await f.send(runtime, request);
      expect(f.messages).toContainEqual(expect.objectContaining({ kind: 'execution', requestId: request.requestId,
        response: { kind: 'credentials', environment: { OPENAI_API_KEY: 'fake-runtime-distributed-key',
          TAKT_OPENAI_API_KEY: 'fake-runtime-distributed-key' } } }));
    } else {
      await expect(f.send(runtime, request)).rejects.toBeInstanceOf(WorkerRejectedError);
      expect(f.messages.filter((message) => message.kind === 'execution')).toEqual([]);
      expect(JSON.stringify(f.messages).includes('fake-runtime-distributed-key')).toBe(false);
    }
  } finally { await runtime.close(); }
});

it('routes repeated log records to their project without redispatching all workers', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const assignment = executionIdentity(f.records[0]!.assignment);
    f.pool.dispatch.mockClear();
    f.pool.project.mockClear();
    f.operations.length = 0;
    f.messages.length = 0;

    const requests = [1, 2, 3].map((sequence) => {
      const data = Buffer.from(`entry-${sequence}\n`);
      return WorkerRequestSchema.parse(f.message({ kind: 'execution' as const, assignment,
        command: { kind: 'record' as const, record: { sequence, runSlug: 'test-run', path: 'logs/session.jsonl',
          offset: (sequence - 1) * data.length, mode: 'append' as const, final: true,
          data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') } } }));
    });
    for (const request of requests) await f.send(runtime, request);

    expect(f.pool.dispatch).not.toHaveBeenCalled();
    expect(f.pool.project.mock.calls).toEqual([['/project'], ['/project'], ['/project']]);
    expect(f.operations.map((operation) => operation.kind)).toEqual(['execution', 'execution', 'execution']);
    expect(f.messages).toEqual(requests.map((request, index) => expect.objectContaining({
      kind: 'execution', requestId: request.requestId, response: { kind: 'record', acknowledgedSequence: index + 1 },
    })));
  } finally { await runtime.close(); }
});

it('uses the same execution capability for connection, refresh and replacement while retaining heartbeats', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    f.pending.splice(0); await runtime.restore(); await f.connect(runtime, false);
    expect(runtime.connectionCount).toBe(1);
    expect(f.pool.setRemoteWorkers).toHaveBeenLastCalledWith([]);
    await runtime.check(); expect(f.pool.setRemoteWorkers).toHaveBeenLastCalledWith([]);
    await f.send(runtime, f.message({ kind: 'heartbeat' as const, active: [] }));
    expect(f.messages.at(-1)).toMatchObject({ kind: 'heartbeat', stop: [] });
    await f.connect(runtime, true);
    expect(f.pool.setRemoteWorkers).toHaveBeenLastCalledWith([{ name: 'w1', kind: 'remote', concurrency: 2,
      registrationGeneration: f.message({ kind: 'pull' }).registrationGeneration }]);
    await runtime.check();
    expect(f.pool.setRemoteWorkers).toHaveBeenLastCalledWith([{ name: 'w1', kind: 'remote', concurrency: 2,
      registrationGeneration: f.message({ kind: 'pull' }).registrationGeneration }]);
    await f.connect(runtime, false); await runtime.check();
    expect(f.pool.setRemoteWorkers).toHaveBeenLastCalledWith([]);
  } finally { await runtime.close(); }
});

it.each(['list', 'dispatch'])('propagates a shared %s failure instead of assigning it to an idle connection', async (stage) => {
  const f = fixture(); const other = f.worker('w2'); const runtime = f.makeRuntime();
  try {
    f.pending.splice(0); await runtime.restore(); await f.connect(runtime); await other.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const failure = new Error('Shared dependency failed');
    if (stage === 'list') doubles.list.mockImplementationOnce(() => { throw failure; });
    else f.pool.dispatch.mockRejectedValueOnce(failure);
    await expect(other.send(runtime, other.message({ kind: 'heartbeat' as const, active: [] }))).rejects.toBe(failure);
    expect(f.sink.fail).not.toHaveBeenCalled(); expect(other.sink.fail).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
const deletionCases = receiveCases.flatMap((kind) => [false, true].flatMap((removed) =>
  [1, 2].map((attempt) => ({ kind, removed, attempt }))));

it.each(deletionCases)('keeps the valid worker during $kind when another idle registration is removed=$removed, attempt=$attempt', async ({ kind, removed }) => {
  const f = fixture(); const other = f.worker('w2'); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const first = structuredClone(f.records[0]!);
    if (kind !== 'connect') {
      await other.connect(runtime);
      await other.send(runtime, other.message({ kind: 'pull' as const }));
    }
    const second = structuredClone(f.records.find((record) => record.assignment.workerId === 'w2'));
    f.pending.splice(0);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const waiting = other.message({ kind: 'pull' as const });
    if (kind === 'check') await other.send(runtime, waiting);
    f.advance(5000);
    doubles.events.length = 0;
    const entered = deferred<void>(); const resumed = deferred<void>();
    f.pool.dispatch.mockImplementationOnce(async () => {
      doubles.events.push('dispatch:waiting'); entered.resolve();
      await resumed.promise; doubles.events.push('dispatch:resumed');
    });
    const invoke = () => {
      switch (kind) {
        case 'connect': return other.connect(runtime);
        case 'heartbeat': return other.send(runtime, other.message({ kind, active: [executionIdentity(second!.assignment)] }));
        case 'complete': return other.send(runtime, other.message({ kind, assignment: executionIdentity(second!.assignment), success: true }));
        case 'pull': return other.send(runtime, waiting);
        case 'check': return runtime.check();
      }
    };
    const pulls = f.pool.pull.mock.calls.length;
    const outcome = invoke().then(() => undefined, (error: unknown) => error);
    await entered.promise;
    expect(doubles.events).toEqual(['list', 'dispatch:waiting']);
    if (removed) f.remove();
    resumed.resolve();
    const result = await outcome;
    expect(result, JSON.stringify(doubles.events)).toBeUndefined();
    expect(doubles.events.indexOf('authorize:w1')).toBeGreaterThan(doubles.events.indexOf('dispatch:resumed'));
    expect(doubles.events.indexOf('authorize:w2')).toBeGreaterThan(doubles.events.indexOf('authorize:w1'));
    expect(other.messages.some((message) => message.kind === 'rejected')).toBe(false);
    expect(other.sink.close).not.toHaveBeenCalled();
    if (removed) {
      expect(f.messages.at(-1)).toMatchObject({ kind: 'rejected' });
      expect(f.sink.close).toHaveBeenCalledOnce();
      expect(f.pool.pull.mock.calls.slice(pulls).some(([name]) => name === 'w1')).toBe(false);
    } else {
      expect(f.sink.close).not.toHaveBeenCalled();
      expect(f.messages.some((message) => message.kind === 'rejected')).toBe(false);
    }
    if (kind === 'connect') expect(other.messages.at(-1)).toMatchObject({ kind: 'connected' });
    if (kind === 'heartbeat') {
      expect(other.messages.at(-1)).toMatchObject({ kind: 'heartbeat', stop: [] });
      expect(f.records.find((record) => record.assignment.executionId === second!.assignment.executionId))
        .toMatchObject({ status: 'running', assignment: { leaseExpiresAt: second!.assignment.leaseExpiresAt + 5000 } });
    }
    if (kind === 'complete') {
      expect(other.messages.at(-1)).toMatchObject({ kind: 'completed', accepted: true });
      expect(f.records.find((record) => record.assignment.executionId === second!.assignment.executionId)?.status).toBe('completed');
    }
    await runtime.check();
    expect(f.records.find((record) => record.assignment.executionId === first.assignment.executionId))
      .toMatchObject(removed ? { status: 'failed', failureReason: expect.stringMatching(/registration.*removed/i) } : first);
    if (removed) expect(f.pool.release).toHaveBeenCalledWith(expect.objectContaining({ executionId: first.assignment.executionId }));
    if (kind === 'pull' || kind === 'check') {
      f.pending.push('c', 'd'); await runtime.check();
      expect(other.messages).toContainEqual(expect.objectContaining({ kind: 'assignment', requestId: waiting.requestId,
        assignment: expect.objectContaining({ workerId: 'w2' }) }));
    }
    expect(other.sink.close).not.toHaveBeenCalled();
    if (second !== undefined && kind !== 'heartbeat' && kind !== 'complete') {
      expect(f.records.find((record) => record.assignment.executionId === second.assignment.executionId)).toEqual(second);
    }
  } finally { await runtime.close(); }
});

it('propagates a shared authorization failure without rejecting another connection', async () => {
  const f = fixture(); const other = f.worker('w2'); const runtime = f.makeRuntime();
  try {
    f.pending.splice(0);
    await runtime.restore(); await f.connect(runtime); await other.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const failure = new Error('Pending pull dependency failed');
    doubles.authorize.mockImplementationOnce(() => { throw failure; });
    await expect(other.send(runtime, other.message({ kind: 'heartbeat' as const, active: [] }))).rejects.toBe(failure);
    expect(f.sink.close).not.toHaveBeenCalled(); expect(other.sink.close).not.toHaveBeenCalled();
    expect([...f.messages, ...other.messages].some((message) => message.kind === 'rejected')).toBe(false);
  } finally { await runtime.close(); }
});

const failureCases = receiveCases.flatMap((kind) => ['project', 'storage'].flatMap((stage) =>
  [false, true].flatMap((failed) => [1, 2].map((attempt) => ({ kind, stage, failed, attempt })))));

it.each(failureCases)('keeps the other worker during $kind with pending $stage failure=$failed, attempt=$attempt', async ({ kind, stage, failed }) => {
  const f = fixture(); const other = f.worker('w2'); const runtime = f.makeRuntime();
  try {
    f.pending.splice(0);
    await runtime.restore(); await f.connect(runtime);
    if (kind !== 'connect') {
      await other.connect(runtime); f.pending.push('b');
      await other.send(runtime, other.message({ kind: 'pull' as const }));
    }
    const second = structuredClone(f.records.find((record) => record.assignment.workerId === 'w2'));
    const firstPull = f.message({ kind: 'pull' as const });
    await f.send(runtime, firstPull);
    const waiting = other.message({ kind: 'pull' as const });
    if (kind === 'check') await other.send(runtime, waiting);
    const entered = deferred<void>(); const resumed = deferred<void>();
    f.pool.dispatch.mockImplementationOnce(async () => { entered.resolve(); await resumed.promise; });
    const failure = new Error('Pending request failed');
    const invoke = () => {
      switch (kind) {
        case 'connect': return other.connect(runtime);
        case 'heartbeat': return other.send(runtime, other.message({ kind, active: [executionIdentity(second!.assignment)] }));
        case 'complete': return other.send(runtime, other.message({ kind, assignment: executionIdentity(second!.assignment), success: true }));
        case 'pull': return other.send(runtime, waiting);
        case 'check': return runtime.check();
      }
    };
    const result = invoke().then(() => undefined, (error: unknown) => error);
    await entered.promise;
    f.pending.push('a', 'c');
    if (failed) {
      if (stage === 'project') f.remote.mockRejectedValueOnce(failure);
      else doubles.write.mockImplementationOnce(() => { throw failure; });
    }
    resumed.resolve();
    expect(await result, JSON.stringify(doubles.events)).toBeUndefined();
    expect(other.sink.close).not.toHaveBeenCalled();
    expect(other.sink.fail).not.toHaveBeenCalled();
    if (failed) {
      expect(f.sink.fail).toHaveBeenCalledExactlyOnceWith(failure);
      expect(f.sink.close).toHaveBeenCalledOnce();
      if (stage === 'storage') {
        const executionId = f.records.find((record) => record.assignment.workerId === 'w1')!.assignment.executionId;
        expect(f.messages.some((message) => message.kind === 'assignment')).toBe(false);
        await f.connect(runtime); await f.send(runtime, firstPull);
        expect(f.messages.at(-1)).toMatchObject({ kind: 'assignment', assignment: { executionId } });
        expect(f.operations.filter((request) => request.kind === 'claim' && request.workerId === 'w1')).toHaveLength(1);
      }
    } else expect(f.sink.fail).not.toHaveBeenCalled();
    if (kind === 'connect') expect(other.messages.at(-1)).toMatchObject({ kind: 'connected' });
    if (kind === 'heartbeat') expect(other.messages.at(-1)).toMatchObject({ kind: 'heartbeat', stop: [] });
    if (kind === 'complete') {
      expect(other.messages.at(-1)).toMatchObject({ kind: 'completed', accepted: true });
      expect(f.records.find((record) => record.assignment.executionId === second!.assignment.executionId)?.status).toBe('completed');
    }
    if (kind === 'pull' || kind === 'check') expect(other.messages).toContainEqual(expect.objectContaining({
      kind: 'assignment', requestId: waiting.requestId, assignment: expect.objectContaining({ workerId: 'w2' }),
    }));
  } finally { await runtime.close(); }
});

it('returns the same persisted assignment to simultaneous retries and restores it after a runtime restart', async () => {
  const f = fixture(); let runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    const pull = f.message({ kind: 'pull' as const });
    await Promise.all([f.send(runtime, pull), f.send(runtime, pull)]);
    const replies = f.messages.filter((message) => message.kind === 'assignment');
    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual(replies[1]);
    expect(f.operations.filter((operation) => operation.kind === 'claim')).toHaveLength(1);
    expect(f.pool.activeTaskCount).toBe(1);
    await runtime.close(); runtime = f.makeRuntime();
    await runtime.restore(); await f.connect(runtime); await f.send(runtime, pull);
    expect(f.messages.at(-1)).toEqual(replies[0]);
    expect(f.operations.filter((operation) => operation.kind === 'claim')).toHaveLength(1);
  } finally { await runtime.close(); await f.pool.close(); }
});

it('holds an idle pull without growing response history and continues heartbeats until work arrives', async () => {
  const f = fixture(); f.pending.splice(0); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    const pull = f.message({ kind: 'pull' as const });
    await f.send(runtime, pull);
    for (let tick = 0; tick < 20; tick++) {
      f.advance(5000); await runtime.check();
      await f.send(runtime, f.message({ kind: 'heartbeat' as const, active: [] }));
      await f.send(runtime, pull);
    }
    expect(f.messages.filter((message) => message.kind === 'heartbeat')).toHaveLength(20);
    expect(f.messages.filter((message) => message.kind === 'assignment')).toHaveLength(0);
    expect(doubles.files.size).toBe(0);
    f.pending.push('a'); await runtime.check();
    expect(f.messages.at(-1)).toMatchObject({ kind: 'assignment', requestId: pull.requestId, assignment: { taskName: 'a' } });
    expect(doubles.files.size).toBe(1);
  } finally { await runtime.close(); }
});

it('replays a saved empty result after work becomes pending and acquires only for a new request', async () => {
  const f = fixture(); f.refuseClaim(true); let runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    const pull = f.message({ kind: 'pull' as const });
    await f.send(runtime, pull);
    const empty = f.messages.at(-1);
    expect(empty).toMatchObject({ kind: 'assignment', assignment: null });
    await Promise.all([f.send(runtime, pull), f.send(runtime, pull)]);
    expect(f.messages.slice(-2)).toEqual([empty, empty]);
    await runtime.close(); runtime = f.makeRuntime(); await runtime.restore(); await f.connect(runtime);
    f.refuseClaim(false);
    await f.send(runtime, pull);
    expect(f.messages.at(-1)).toMatchObject({ kind: 'assignment', assignment: null });
    expect(f.operations.filter((operation) => operation.kind === 'claim')).toHaveLength(1);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    expect(f.messages.at(-1)).toMatchObject({ kind: 'assignment', assignment: { taskName: 'a' } });
  } finally { await runtime.close(); await f.pool.close(); }
});

it('recovers the committed claim after response persistence fails without acquiring a second task', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    const pull = f.message({ kind: 'pull' as const });
    doubles.write.mockImplementationOnce(() => { throw new Error('Response storage failed'); });
    await expect(f.send(runtime, pull)).rejects.toThrow('Response storage failed');
    const executionId = f.records[0]!.assignment.executionId;
    expect(f.messages.some((message) => message.kind === 'assignment')).toBe(false);
    await f.send(runtime, pull);
    expect(f.messages.at(-1)).toMatchObject({ kind: 'assignment', assignment: { executionId } });
    expect(f.operations.filter((operation) => operation.kind === 'claim')).toHaveLength(1);
  } finally { await runtime.close(); await f.pool.close(); }
});

it('retains the occupied slots during disconnection, continues within the lease and refuses late completion after expiry', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const assignment = structuredClone(f.records[0]!.assignment);
    runtime.disconnect(f.sink); f.advance(59_999); await runtime.check();
    expect(f.records[0]!.status).toBe('running');
    expect(f.pool.activeTaskCount).toBe(1);
    await f.connect(runtime);
    expect(f.records[0]!.assignment.executionId).toBe(assignment.executionId);
    expect(f.records[0]!.status).toBe('running');
    runtime.disconnect(f.sink); f.advance(60_001); await runtime.check();
    expect(f.records[0]).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/connection.*lost/i) });
    expect(f.pool.activeTaskCount).toBe(0);
    expect(f.pending).not.toContain(assignment.taskName);
    await f.connect(runtime);
    expect(f.messages.at(-1)).toMatchObject({ kind: 'connected', stop: expect.arrayContaining([executionIdentity(assignment)]) });
    await f.send(runtime, f.message({ kind: 'complete' as const, assignment: executionIdentity(assignment), success: true }));
    expect(f.messages.at(-1)).toMatchObject({ kind: 'completed', accepted: false });
    expect(f.records[0]!.status).toBe('failed');
  } finally { await runtime.close(); await f.pool.close(); }
});

it('restores the original lease without extending it and expires it across a daemon restart', async () => {
  const f = fixture(); let runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const deadline = f.records[0]!.assignment.leaseExpiresAt;
    await runtime.close(); f.advance(59_000); runtime = f.makeRuntime(); await runtime.restore();
    expect(f.records[0]!.assignment.leaseExpiresAt).toBe(deadline);
    expect(f.records[0]!.status).toBe('running');
    expect(f.pool.activeTaskCount).toBe(1);
    f.advance(1001); await runtime.check();
    expect(f.records[0]!.status).toBe('failed');
    expect(f.pool.activeTaskCount).toBe(0);
  } finally { await runtime.close(); await f.pool.close(); }
});

it('retains the known execution when a local project host temporarily cannot return its snapshot', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const assignment = structuredClone(f.records[0]!.assignment);
    runtime.disconnect(f.sink); f.setSnapshotAvailable(false);
    await expect(runtime.check()).rejects.toThrow('could not be restored');
    await expect(f.connect(runtime)).rejects.toThrow('could not be restored');
    f.setSnapshotAvailable(true); await runtime.check(); await f.connect(runtime);
    expect(f.messages.at(-1)).toMatchObject({ kind: 'connected', running: [expect.objectContaining({ executionId: assignment.executionId })], stop: [] });
    expect(f.pool.activeTaskCount).toBe(1);
    f.setSnapshotAvailable(true); await runtime.check();
    expect(f.records[0]!.status).toBe('running');
  } finally { await runtime.close(); await f.pool.close(); }
});

it('refuses startup and new pull requests until every project assignment snapshot has been restored', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    f.setSnapshotAvailable(false);
    await expect(runtime.restore()).rejects.toThrow('could not be restored');
    await expect(f.send(runtime, f.message({ kind: 'pull' as const }))).rejects.toThrow('could not be restored');
    expect(f.pool.pull).not.toHaveBeenCalled();
    expect(doubles.write).not.toHaveBeenCalled();
    f.setSnapshotAvailable(true); await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    expect(f.records).toHaveLength(1);
  } finally { await runtime.close(); await f.pool.close(); }
});

it('fails the running assignment and disconnects the same connection when its registration is removed', async () => {
  const f = fixture(); const runtime = f.makeRuntime();
  try {
    await runtime.restore(); await f.connect(runtime);
    await f.send(runtime, f.message({ kind: 'pull' as const }));
    const lateCompletion = f.message({ kind: 'complete' as const, assignment: executionIdentity(f.records[0]!.assignment), success: true });
    f.remove(); await runtime.check();
    expect(f.records[0]).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/registration.*removed/i) });
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(runtime.connectionCount).toBe(0);
    await expect(f.send(runtime, lateCompletion)).rejects.toBeInstanceOf(WorkerRejectedError);
    expect(f.records[0]!.status).toBe('failed');
  } finally { await runtime.close(); await f.pool.close(); }
});
