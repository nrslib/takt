import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { WORKER_FRAME_MAX_BYTES, WORKER_LEASE_MS, WORKER_PROTOCOL_VERSION, RemoteAssignmentSchema, WorkerRejectedError,
  executionIdentity, sameExecution, type RemoteAssignment, type RemoteTaskRecord,
  type WorkerConnectionSink, type WorkerRegistration, type WorkerRequest,
  type RemoteProjectRequest, type RemoteProjectReply } from '../../core/worker-pool/remoteProtocol.js';
import { WorkerRegistry, WORKER_PULL_RESPONSES_DIRECTORY } from '../../infra/worker-pool/workerRegistry.js';
import { readPrivateFile, writePrivateFile } from '../../infra/daemon/privateFile.js';
import type { TaskDispatcher } from '../daemon/taskDispatcher.js';
import type { RemoteCredentialsConfig } from '../../core/models/daemon-config-schema.js';
import { resolveRemoteCredentials } from './remoteCredentials.js';

const savedResponseSchema = z.object({ workerId: z.string(), registrationGeneration: z.string(),
  requestId: z.string(), assignment: RemoteAssignmentSchema.nullable() }).strict();
type SavedResponse = z.infer<typeof savedResponseSchema>;
type Connection = { registration: WorkerRegistration; token: string; sink: WorkerConnectionSink; canExecute: boolean };
type PendingPull = { request: Extract<WorkerRequest, { kind: 'pull' }>; sink: WorkerConnectionSink };

function responseKey(input: Pick<SavedResponse, 'workerId' | 'registrationGeneration' | 'requestId'>): string {
  return JSON.stringify([input.workerId, input.registrationGeneration, input.requestId]);
}

export class RemoteWorkerRuntime {
  private readonly registry: WorkerRegistry;
  private readonly responseDirectory: string;
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingPull>();
  private records: RemoteTaskRecord[] = [];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly input: { directory: string;
    dispatcher: Pick<TaskDispatcher, 'setRemoteWorkers' | 'restore' | 'dispatch' | 'remoteRecords' | 'hasProjectSnapshot' | 'hasCompleteSnapshot' | 'project' | 'pull' | 'decline' | 'release'>;
    version: string; now(): number; credentials?: RemoteCredentialsConfig }) {
    this.registry = new WorkerRegistry(input.directory);
    this.responseDirectory = join(input.directory, WORKER_PULL_RESPONSES_DIRECTORY);
  }

  async restore(): Promise<void> {
    await this.input.dispatcher.restore();
    if (!this.input.dispatcher.hasCompleteSnapshot()) throw new Error('Worker pool project assignments could not be restored');
    await this.check();
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(action);
    // A failed request must reject its caller without preventing the next serialized operation.
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  get connectionCount(): number { return this.connections.size; }

  check(): Promise<void> { return this.serialize(() => this.refresh()); }

  private async project(projectId: string, request: RemoteProjectRequest): Promise<RemoteProjectReply> {
    const project = this.input.dispatcher.project(projectId);
    if (project?.remote === undefined) throw new Error('Remote worker project is unavailable');
    return project.remote(request);
  }

  private updateRecord(record: RemoteTaskRecord): void {
    this.records = this.records.map((current) => sameExecution(current.assignment, record.assignment) ? record : current);
  }

  private async refresh(): Promise<void> {
    if (this.closed) return;
    const registered = await this.registry.list();
    this.setWorkers(registered);
    await this.input.dispatcher.dispatch();
    const observed = this.input.dispatcher.remoteRecords();
    this.records = [...observed, ...this.records.filter((record) =>
      !this.input.dispatcher.hasProjectSnapshot(record.assignment.projectId))];
    if (!this.input.dispatcher.hasCompleteSnapshot()) throw new Error('Worker pool project assignments could not be restored');
    for (const record of this.records) {
      if (record.cleanupId !== undefined && !record.cleanupAcknowledged) {
        const connection = this.connections.get(record.assignment.workerId);
        if (connection?.registration.registrationGeneration === record.assignment.registrationGeneration) {
          connection.sink.send({ ...this.envelope(record.assignment), kind: 'workspace', assignment: record.assignment,
            operation: 'remove', cleanupId: record.cleanupId });
        }
      }
      if (record.status === 'pending' && record.assignment.retryReservation) {
        const assignment = record.assignment;
        const removed = !registered.some((worker) => worker.name === assignment.workerId
          && worker.registrationGeneration === assignment.registrationGeneration);
        const connection = this.connections.get(assignment.workerId);
        const connected = connection?.registration.registrationGeneration === assignment.registrationGeneration;
        const deadline = assignment.retryWaitUntil ?? this.input.now() + WORKER_LEASE_MS;
        const restartReason = removed ? `Worker ${assignment.workerName} registration was removed`
          : !connected && deadline <= this.input.now() ? `Connection to worker ${assignment.workerName} was lost for 60 seconds` : undefined;
        if (restartReason !== undefined || !connected && assignment.retryWaitUntil === undefined) {
          const result = await this.project(assignment.projectId, { kind: 'retry-state', assignment: executionIdentity(assignment),
            ...(restartReason === undefined ? { waitUntil: deadline } : { restartReason }) });
          if (result.kind === 'updated' && result.record !== null) { this.updateRecord(result.record); this.input.dispatcher.release(assignment); }
        } else if (connected && !assignment.retryReady) {
          connection.sink.send({ ...this.envelope(assignment), kind: 'workspace', assignment, operation: 'inspect' });
        }
      }
      if (record.status !== 'running') continue;
      const assignment = record.assignment;
      const removed = !registered.some((worker) => worker.name === assignment.workerId
        && worker.registrationGeneration === assignment.registrationGeneration);
      if (!removed && assignment.leaseExpiresAt > this.input.now()) continue;
      const reason = removed ? `Worker ${assignment.workerName} registration was removed`
        : `Connection to worker ${assignment.workerName} was lost and its lease expired`;
      const result = await this.project(assignment.projectId, { kind: 'fail', assignment: executionIdentity(assignment), reason });
      if (result.kind !== 'updated' || result.record === null) throw new Error('Remote assignment failure was not saved');
      this.updateRecord(result.record);
      this.input.dispatcher.release(assignment);
      this.connections.get(assignment.workerId)?.sink.send({ ...this.envelope(assignment), kind: 'stop',
        assignment: executionIdentity(assignment), reason });
    }
    for (const [name, connection] of this.connections) {
      if (registered.some((worker) => worker.name === name
        && worker.registrationGeneration === connection.registration.registrationGeneration)) continue;
      this.failConnection(connection, new WorkerRejectedError('Worker registration was removed'));
    }
    for (const [key, pending] of this.pending) {
      const connection = this.connections.get(pending.request.workerId);
      if (connection?.sink !== pending.sink) { this.pending.delete(key); continue; }
      const failure = await this.registry.authorize(connection.token, async (registration) => {
        try {
          await this.answerPull(pending.request, registration, pending.sink);
          return undefined;
        } catch (error) { return { error }; }
      }).catch((error: unknown) => {
        if (!(error instanceof WorkerRejectedError)) throw error;
        return { error };
      });
      if (failure !== undefined) this.failConnection(connection, failure.error);
    }
  }

  private setWorkers(registered: readonly WorkerRegistration[]): void {
    this.input.dispatcher.setRemoteWorkers(registered.flatMap((registration) => {
      const connection = this.connections.get(registration.name);
      return connection?.canExecute === true && connection.registration.registrationGeneration === registration.registrationGeneration
        ? [{ name: registration.name, kind: 'remote' as const, concurrency: registration.concurrency,
          registrationGeneration: registration.registrationGeneration }] : [];
    }));
  }

  private failConnection(connection: Connection, error: unknown): void {
    this.disconnect(connection.sink);
    connection.sink.fail(error);
  }

  private envelope(identity: { workerId: string; registrationGeneration: string }, requestId: string = randomUUID()) {
    return { protocolVersion: WORKER_PROTOCOL_VERSION, requestId, workerId: identity.workerId,
      registrationGeneration: identity.registrationGeneration } as const;
  }

  receive(token: string, request: WorkerRequest, sink: WorkerConnectionSink): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new WorkerRejectedError('Daemon worker listener is stopping');
      await this.refresh();
      await this.registry.authorize(token, async (registration) => {
        if (registration.name !== request.workerId || registration.registrationGeneration !== request.registrationGeneration) {
          throw new WorkerRejectedError('Worker registration does not match the connection');
        }
        if (request.kind === 'connect') {
          if (request.version !== this.input.version) throw new WorkerRejectedError('Worker TAKT version does not match daemon TAKT version');
          const previous = this.connections.get(registration.name);
          if (previous !== undefined && previous.sink !== sink) previous.sink.close();
          if (previous !== undefined && previous.sink !== sink) this.disconnect(previous.sink);
          this.connections.set(registration.name, { registration, token, sink, canExecute: request.canExecute });
          this.setWorkers([...this.connections.values()].map((connection) => connection.registration));
          const owned = this.records.filter((record) => record.assignment.workerId === registration.name
            && record.assignment.registrationGeneration === registration.registrationGeneration);
          const running: RemoteAssignment[] = [];
          for (const record of owned) if (record.status === 'running') {
            const assignment = await this.renew(record.assignment);
            if (assignment !== undefined) running.push(assignment);
          }
          const stop = [...owned.filter((record) => record.status !== 'running').map((record) => executionIdentity(record.assignment)),
            ...request.active.filter((active) => !running.some((assignment) => sameExecution(assignment, active)))];
          sink.send({ ...this.envelope(request, request.requestId), kind: 'connected', concurrency: registration.concurrency, running, stop });
          return;
        }
        if (this.connections.get(registration.name)?.sink !== sink) throw new WorkerRejectedError('Worker connection is no longer current');
        const envelope = this.envelope(request, request.requestId);
        if (request.kind === 'pull') {
          this.pending.set(responseKey(request), { request, sink });
          await this.answerPull(request, registration, sink);
        } else if (request.kind === 'heartbeat') {
          const stop = [];
          for (const active of request.active) {
            if (active.workerId !== request.workerId || active.registrationGeneration !== request.registrationGeneration) {
              throw new WorkerRejectedError('Heartbeat assignment does not belong to this worker');
            }
            const record = this.records.find((record) => record.status === 'running' && sameExecution(record.assignment, active));
            if (record === undefined || await this.renew(record.assignment) === undefined) stop.push(active);
          }
          sink.send({ ...envelope, kind: 'heartbeat', stop });
        } else if (request.kind === 'workspace') {
          if (request.assignment.workerId !== request.workerId || request.assignment.registrationGeneration !== request.registrationGeneration) {
            throw new WorkerRejectedError('Workspace assignment does not belong to this worker');
          }
          if (request.error !== undefined || request.operation === 'remove' && request.exists) return;
          const result = await this.project(request.assignment.projectId, request.operation === 'remove'
            ? { kind: 'cleanup', assignment: request.assignment, cleanupId: request.cleanupId ?? '' }
            : { kind: 'retry-state', assignment: request.assignment, ...(request.exists ? { ready: true }
              : { restartReason: `Worker ${request.workerId} workspace was lost` }) });
          if (result.kind === 'updated' && result.record !== null) this.updateRecord(result.record);
        } else if (request.kind === 'execution') {
          if (request.assignment.workerId !== request.workerId || request.assignment.registrationGeneration !== request.registrationGeneration) {
            throw new WorkerRejectedError('Execution assignment does not belong to this worker');
          }
          if (request.command.kind === 'credentials') {
            const record = this.records.find((record) => record.status === 'running' && sameExecution(record.assignment, request.assignment)
              && record.assignment.leaseExpiresAt > this.input.now());
            if (record === undefined) throw new WorkerRejectedError('Remote credential assignment is no longer valid');
            try {
              const environment = resolveRemoteCredentials(this.input.credentials, process.env);
              if (Object.values(environment).some((value) => value.includes(token))) throw new Error('Worker connection token cannot be used as a task credential');
              sink.send({ ...envelope, kind: 'execution', response: { kind: 'credentials',
                environment } });
            } catch (error) {
              sink.send({ ...envelope, kind: 'execution', response: { kind: 'credentials', environment: {},
                error: error instanceof Error ? error.message : 'Remote credential resolution failed' } });
            }
            return;
          }
          const result = await this.project(request.assignment.projectId, { kind: 'execution', assignment: request.assignment,
            now: this.input.now(), command: request.command });
          if (result.kind !== 'execution') throw new Error('Unexpected remote execution result');
          sink.send({ ...envelope, kind: 'execution', response: result.response });
        } else {
          if (request.assignment.workerId !== request.workerId || request.assignment.registrationGeneration !== request.registrationGeneration) {
            throw new WorkerRejectedError('Completion assignment does not belong to this worker');
          }
          const result = await this.project(request.assignment.projectId, { kind: 'finish', assignment: request.assignment,
            interrupted: request.interrupted, retryable: request.retryable, workflowResult: request.workflowResult,
            prUrl: request.prUrl, prFailed: request.prFailed, prError: request.prError?.replaceAll(token, '[REDACTED]'),
            now: this.input.now(), success: request.success, reason: request.reason?.replaceAll(token, '[REDACTED]'), artifacts: request.artifacts });
          if (result.kind !== 'updated') throw new Error('Unexpected remote completion result');
          if (result.record !== null) {
            this.updateRecord(result.record);
            this.input.dispatcher.release(result.record.assignment);
          }
          sink.send({ ...envelope, kind: 'completed', accepted: result.record !== null });
        }
      });
    });
  }

  private async answerPull(request: Extract<WorkerRequest, { kind: 'pull' }>, registration: WorkerRegistration, sink: WorkerConnectionSink): Promise<void> {
    const assignment = await this.pull(request, registration);
    if (assignment === undefined) return;
    this.pending.delete(responseKey(request));
    const envelope = this.envelope(request, request.requestId);
    if (assignment !== null && !this.records.some((record) => record.status === 'running' && sameExecution(record.assignment, assignment))) {
      sink.send({ ...envelope, kind: 'stop', assignment: executionIdentity(assignment), reason: 'Remote assignment is no longer running' });
    }
    sink.send({ ...envelope, kind: 'assignment', assignment });
  }

  private async renew(assignment: RemoteAssignment): Promise<RemoteAssignment | undefined> {
    const result = await this.project(assignment.projectId, { kind: 'renew', assignment: executionIdentity(assignment),
      now: this.input.now(), leaseExpiresAt: this.input.now() + WORKER_LEASE_MS });
    if (result.kind !== 'updated') throw new Error('Unexpected remote lease result');
    if (result.record === null) return undefined;
    this.updateRecord(result.record);
    return result.record.assignment;
  }

  private async pull(request: Extract<WorkerRequest, { kind: 'pull' }>, registration: WorkerRegistration): Promise<RemoteAssignment | null | undefined> {
    const key = responseKey(request);
    const path = join(this.responseDirectory, request.registrationGeneration, `${createHash('sha256').update(key).digest('hex')}.json`);
    const bytes = await readPrivateFile(path, WORKER_FRAME_MAX_BYTES);
    if (bytes !== undefined) return savedResponseSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown).assignment;
    // A claim may have committed immediately before a daemon crash, before the response journal was written.
    let assignment = this.records.find((record) => record.assignment.workerId === request.workerId
      && record.assignment.registrationGeneration === request.registrationGeneration && record.assignment.requestId === request.requestId)?.assignment ?? null;
    const occupied = this.records.filter((record) => record.status === 'running' && record.assignment.workerId === registration.name
      && record.assignment.registrationGeneration === registration.registrationGeneration).length;
    if (assignment === null) {
      if (occupied >= registration.concurrency) return undefined;
      const selected = this.input.dispatcher.pull(registration.name);
      if (selected === undefined) return undefined;
      try {
        const result = await this.project(selected.projectId, { kind: 'claim', taskName: selected.taskName,
          workerId: registration.name, registrationGeneration: registration.registrationGeneration,
          requestId: request.requestId, leaseExpiresAt: this.input.now() + WORKER_LEASE_MS });
        if (result.kind !== 'claim') throw new Error('Unexpected remote claim result');
        assignment = result.assignment;
        if (assignment === null) this.input.dispatcher.decline(selected, { kind: 'declined' });
        else this.records.push({ assignment, status: 'running' });
      } catch (error) {
        this.input.dispatcher.decline(selected, { kind: 'declined' });
        throw error;
      }
    }
    const response: SavedResponse = { workerId: request.workerId, registrationGeneration: request.registrationGeneration,
      requestId: request.requestId, assignment };
    await writePrivateFile(path, JSON.stringify(response));
    return assignment;
  }

  disconnect(sink: WorkerConnectionSink): void {
    for (const [name, connection] of this.connections) if (connection.sink === sink) this.connections.delete(name);
    for (const [key, pull] of this.pending) if (pull.sink === sink) this.pending.delete(key);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    for (const connection of this.connections.values()) connection.sink.close();
    this.connections.clear();
    this.pending.clear();
  }
}
