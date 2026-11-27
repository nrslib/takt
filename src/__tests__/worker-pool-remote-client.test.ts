import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runRemoteWorker } from '../features/workerPool/remoteWorker.js';
import { RemoteAssignmentSchema, executionIdentity, type RemoteAssignment, type WorkerRequest, type WorkerResponse } from '../core/worker-pool/remoteProtocol.js';

const doubles = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../infra/worker-pool/remoteTransport.js', () => ({ connectWorkerTransport: doubles.open }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

function fixture(withExecutor = true) {
  const identity = { workerId: 'w1', registrationGeneration: randomUUID() };
  const token = `${Buffer.from(JSON.stringify(identity)).toString('base64url')}.test`;
  const connections: { send: ReturnType<typeof vi.fn>; close(): void; receive(message: WorkerResponse): void; disconnect(): void }[] = [];
  doubles.open.mockImplementation((input: { onResponse(message: WorkerResponse): void }) => {
    let resolve!: () => void;
    const closed = new Promise<void>((finish) => { resolve = finish; });
    const connection = { send: vi.fn(), close: () => resolve(), receive: input.onResponse, disconnect: () => resolve(), closed };
    connections.push(connection);
    return connection;
  });
  const finishers: ((result: { success: boolean }) => void)[] = [];
  const signals: AbortSignal[] = [];
  const executor = { workspace: vi.fn(async (_assignment: RemoteAssignment, operation: 'inspect' | 'remove') => operation === 'inspect'),
    execute: vi.fn(async (_assignment: RemoteAssignment, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<{ success: boolean }>((resolve) => {
      finishers.push(resolve);
      signal.addEventListener('abort', () => resolve({ success: false }), { once: true });
    });
  }) };
  const controller = new AbortController();
  const result = runRemoteWorker({ url: 'http://localhost:1234', token, version: '1.0', executor: withExecutor ? executor : undefined, signal: controller.signal });
  const envelope = () => ({ ...identity, requestId: randomUUID(), protocolVersion: 1 as const });
  const connected = (index: number, running: ReturnType<typeof RemoteAssignmentSchema.parse>[]) => {
    connections[index]!.receive({ ...envelope(), kind: 'connected', concurrency: 2, running, stop: [] });
  };
  const assign = (taskName: string, deliver = true) => {
    const connection = connections.at(-1)!;
    const sent = connection.send.mock.calls.map(([message]) => message as WorkerRequest);
    const pull = [...sent].reverse().find((message) => message.kind === 'pull')!;
    const assignment = RemoteAssignmentSchema.parse({ ...identity, projectId: '/p', taskName, workerName: 'w1',
      requestId: pull.requestId, executionId: randomUUID(), assignmentGeneration: 1, origin: 'https://example.test/r.git',
      originalSha: 'a'.repeat(40), branch: 'result', leaseExpiresAt: 60_000, lastAcknowledgedLogSequence: 0,
      controlSequence: 0, workLocation: null, retryReservation: false });
    if (deliver) connection.receive({ ...envelope(), requestId: pull.requestId, kind: 'assignment', assignment });
    return assignment;
  };
  return { identity, connections, finishers, signals, executor, controller, result, envelope, connected, assign };
}

it.each(['inspect', 'remove'] as const)('waits for the previous executor to settle before workspace %s and ACK', async (operation) => {
  const f = fixture();
  try {
    f.connected(0, []);
    const assignment = f.assign('failed');
    await vi.advanceTimersByTimeAsync(0);
    const connection = f.connections[0]!;
    connection.receive({ ...f.envelope(), kind: 'workspace', assignment, operation });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.workspace).not.toHaveBeenCalled();
    expect(connection.send.mock.calls.some(([message]) => message.kind === 'workspace')).toBe(false);
    f.finishers[0]!({ success: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.workspace).toHaveBeenCalledWith(assignment, operation);
    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workspace', operation,
      assignment: executionIdentity(assignment), exists: operation === 'inspect' }));
  } finally { f.controller.abort(); await f.result; }
});

it.each([false, true])('announces executor availability on every connection with executor=%s', async (withExecutor) => {
  const f = fixture(withExecutor);
  try {
    expect(f.connections[0]!.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connect', canExecute: withExecutor }));
    f.connected(0, []);
    f.connections[0]!.disconnect(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.connections).toHaveLength(2);
    expect(f.connections[1]!.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connect', canExecute: withExecutor }));
  } finally { f.controller.abort(); await f.result; }
});

it('pulls only into available slots and sends heartbeat every five seconds', async () => {
  const f = fixture();
  try {
    f.connected(0, []); f.assign('a'); f.assign('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
    expect(f.connections[0]!.send.mock.calls.filter(([message]) => message.kind === 'pull')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.connections[0]!.send.mock.calls.filter(([message]) => message.kind === 'heartbeat')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.connections[0]!.send.mock.calls.filter(([message]) => message.kind === 'heartbeat')).toHaveLength(1);
    f.finishers[0]!({ success: true }); await vi.advanceTimersByTimeAsync(0);
    expect(f.connections[0]!.send.mock.calls.filter(([message]) => message.kind === 'pull')).toHaveLength(2);
    const completion = f.connections[0]!.send.mock.calls.map(([message]) => message as WorkerRequest)
      .find((message) => message.kind === 'complete')!;
    f.connections[0]!.receive({ ...f.envelope(), kind: 'completed', requestId: completion.requestId, accepted: true });
    expect(f.connections[0]!.send.mock.calls.filter(([message]) => message.kind === 'pull')).toHaveLength(3);
    for (const [assignment] of f.executor.execute.mock.calls) expect(assignment).not.toHaveProperty('token');
  } finally { f.controller.abort(); await f.result; }
});

it('stays connected and sends heartbeats without pulling or failing tasks when no executor is configured', async () => {
  const f = fixture(false);
  try {
    f.connected(0, []);
    await vi.advanceTimersByTimeAsync(15_000);
    const messages = f.connections[0]!.send.mock.calls.map(([message]) => message as WorkerRequest);
    expect(messages.filter((message) => message.kind === 'heartbeat')).toHaveLength(3);
    expect(messages.filter((message) => message.kind === 'pull' || message.kind === 'complete')).toEqual([]);
    expect(f.executor.execute).not.toHaveBeenCalled();
    f.connections[0]!.receive({ ...f.envelope(), kind: 'connected', concurrency: 2, stop: [], running: [{
      ...f.identity, projectId: '/p', taskName: 'existing', workerName: 'w1', requestId: 'old', executionId: randomUUID(),
      assignmentGeneration: 1, origin: 'https://example.test/r.git', originalSha: 'a'.repeat(40), branch: 'result',
      leaseExpiresAt: 60_000, lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false,
    }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connections[0]!.send.mock.calls.some(([message]) => message.kind === 'complete')).toBe(false);
  } finally { f.controller.abort(); await f.result; }
});

it('keeps the same executor and execution through reconnect and stops it when the daemon rejects the assignment', async () => {
  const f = fixture();
  try {
    f.connected(0, []); const assignment = f.assign('a'); await vi.advanceTimersByTimeAsync(0);
    f.connections[0]!.disconnect(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.connections).toHaveLength(2);
    expect(f.signals[0]!.aborted).toBe(false);
    f.connected(1, [assignment]); await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.execute).toHaveBeenCalledOnce();
    f.connections[1]!.receive({ ...f.envelope(), kind: 'stop', assignment: executionIdentity(assignment), reason: 'Lease expired' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signals[0]!.aborted).toBe(true);
    expect(f.executor.execute).toHaveBeenCalledOnce();
  } finally { f.controller.abort(); await f.result; }
});

it('ends on an authentication rejection instead of retrying the same credentials', async () => {
  const f = fixture();
  const rejection = expect(f.result).rejects.toThrow('Worker registration was removed');
  f.connections[0]!.receive({ kind: 'rejected', reason: 'Worker registration was removed' });
  await rejection;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.connections).toHaveLength(1);
});

it('replays an unacknowledged completion without starting its executor again after reconnect', async () => {
  const f = fixture();
  try {
    f.connected(0, []); const assignment = f.assign('a'); await vi.advanceTimersByTimeAsync(0);
    f.connections[0]!.disconnect(); await vi.advanceTimersByTimeAsync(0);
    f.finishers[0]!({ success: true }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    f.connected(1, [assignment]); await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.connections[1]!.send.mock.calls.some(([message]) => message.kind === 'complete'
      && message.assignment.executionId === assignment.executionId)).toBe(true);
  } finally { f.controller.abort(); await f.result; }
});

it('recovers a claim whose pull response was lost without executing a late duplicate response', async () => {
  const f = fixture();
  try {
    f.connected(0, []); const assignment = f.assign('a', false);
    f.connections[0]!.disconnect(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.executor.execute).not.toHaveBeenCalled();
    f.connected(1, [assignment]); await vi.advanceTimersByTimeAsync(0);
    f.connections[1]!.receive({ ...f.envelope(), requestId: assignment.requestId, kind: 'assignment', assignment });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.executor.execute.mock.calls[0]![0].executionId).toBe(assignment.executionId);
  } finally { f.controller.abort(); await f.result; }
});
