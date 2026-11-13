import { randomUUID } from 'node:crypto';
import { WORKER_HEARTBEAT_MS, WORKER_PROTOCOL_VERSION, WorkerRejectedError, executionIdentity, validateWorkerUrl,
  type RemoteAssignment, type RemoteExecutionIdentity, type WorkerRequest, type WorkerResponse,
  type WorkerIdentity } from '../../core/worker-pool/remoteProtocol.js';
import { workerTokenIdentity } from '../../infra/worker-pool/workerRegistry.js';
import { connectWorkerTransport, type WorkerTransport } from '../../infra/worker-pool/remoteTransport.js';

export interface RemoteTaskExecutor {
  execute(assignment: RemoteAssignment, signal: AbortSignal): Promise<{ success: boolean; reason?: string }>;
}

export async function runRemoteWorker(input: {
  url: string; token: string; version: string; executor?: RemoteTaskExecutor; signal: AbortSignal;
  onConnected?(worker: WorkerIdentity): void;
}): Promise<void> {
  const url = validateWorkerUrl(input.url);
  const identity = workerTokenIdentity(input.token);
  const running = new Map<string, { assignment: RemoteAssignment; controller: AbortController; operation: Promise<void> }>();
  const stopped = new Set<string>();
  const completions = new Map<string, Extract<WorkerRequest, { kind: 'complete' }>>();
  let transport: WorkerTransport | undefined;
  let concurrency = 0;
  let connected = false;
  let pendingPull: Extract<WorkerRequest, { kind: 'pull' }> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ending = false;
  let rejected: unknown;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const envelope = () => ({ protocolVersion: WORKER_PROTOCOL_VERSION, ...identity, requestId: randomUUID() } as const);
  const stopExecution = (assignment: RemoteExecutionIdentity): void => {
    stopped.add(assignment.executionId);
    running.get(assignment.executionId)?.controller.abort(new Error('Remote assignment is no longer valid'));
  };
  const pull = (): void => {
    clearTimeout(poll);
    if (input.executor === undefined || ending || !connected || pendingPull !== undefined || running.size >= concurrency) return;
    pendingPull = { ...envelope(), kind: 'pull' };
    transport!.send(pendingPull);
  };
  const execute = (assignment: RemoteAssignment): void => {
    const executor = input.executor;
    if (executor === undefined) return;
    if (running.has(assignment.executionId) || stopped.has(assignment.executionId)
      || [...completions.values()].some((message) => message.assignment.executionId === assignment.executionId)) return;
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => executor.execute(structuredClone(assignment), controller.signal))
      .catch(() => ({ success: false, reason: 'Remote executor failed' }))
      .then((result) => {
        const message: Extract<WorkerRequest, { kind: 'complete' }> = { ...envelope(), kind: 'complete',
          assignment: executionIdentity(assignment), success: result.success,
          ...(result.reason === undefined ? {} : { reason: result.reason.replaceAll(input.token, '[REDACTED]').slice(0, 8192) }) };
        completions.set(message.requestId, message);
        if (connected && !ending) transport!.send(message);
      }).finally(() => {
        running.delete(assignment.executionId);
        if (!ending) pull();
      });
    running.set(assignment.executionId, { assignment, controller, operation });
  };
  const receive = (message: WorkerResponse): void => {
    if (message.kind === 'rejected') {
      rejected = new WorkerRejectedError(message.reason);
      ending = true;
      transport?.close();
      finish();
      return;
    }
    if (message.workerId !== identity.workerId || message.registrationGeneration !== identity.registrationGeneration) {
      rejected = new WorkerRejectedError('Daemon returned a different worker registration');
      ending = true; transport?.close(); finish(); return;
    }
    switch (message.kind) {
      case 'connected':
        connected = true;
        concurrency = message.concurrency;
        for (const assignment of message.stop) stopExecution(assignment);
        for (const assignment of message.running) {
          if (pendingPull?.requestId === assignment.requestId) pendingPull = undefined;
          execute(assignment);
        }
        for (const completion of completions.values()) transport!.send(completion);
        if (pendingPull !== undefined) transport!.send(pendingPull);
        else pull();
        input.onConnected?.(identity);
        break;
      case 'assignment':
        if (pendingPull?.requestId !== message.requestId) break;
        pendingPull = undefined;
        if (message.assignment === null) poll = setTimeout(pull, 1000);
        else { execute(message.assignment); pull(); }
        break;
      case 'heartbeat': for (const assignment of message.stop) stopExecution(assignment); break;
      case 'stop': stopExecution(message.assignment); break;
      case 'completed': completions.delete(message.requestId); break;
    }
  };
  const open = (): void => {
    if (ending) return;
    connected = false;
    const connection = connectWorkerTransport({ url, token: input.token, onResponse: receive });
    transport = connection;
    connection.send({ ...envelope(), kind: 'connect', version: input.version, canExecute: input.executor !== undefined,
      active: [...running.values()].map((entry) => executionIdentity(entry.assignment)) });
    void connection.closed.catch((error: unknown) => {
      if (error instanceof WorkerRejectedError) { rejected = error; ending = true; finish(); }
    }).finally(() => {
      if (transport !== connection) return;
      connected = false;
      if (!ending) retry = setTimeout(open, 1000);
    });
  };
  const abort = (): void => { ending = true; transport?.close(); finish(); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    input.signal.throwIfAborted();
    heartbeat = setInterval(() => {
      if (connected) transport!.send({ ...envelope(), kind: 'heartbeat',
        active: [...running.values()].map((entry) => executionIdentity(entry.assignment)) });
    }, WORKER_HEARTBEAT_MS);
    open();
    await done;
  } finally {
    ending = true;
    clearTimeout(poll); clearTimeout(retry); clearInterval(heartbeat);
    input.signal.removeEventListener('abort', abort);
    for (const entry of running.values()) entry.controller.abort(new Error('Worker stopped'));
    transport?.close();
    await Promise.allSettled([...running.values()].map((entry) => entry.operation));
  }
  if (rejected !== undefined) throw rejected;
}
