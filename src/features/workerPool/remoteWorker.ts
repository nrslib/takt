import { randomUUID } from 'node:crypto';
import { WORKER_HEARTBEAT_MS, WORKER_PROTOCOL_VERSION, WorkerRejectedError, executionIdentity, validateWorkerUrl,
  type RemoteAssignment, type RemoteExecutionIdentity, type WorkerRequest, type WorkerResponse,
  type WorkerIdentity } from '../../core/worker-pool/remoteProtocol.js';
import { workerTokenIdentity } from '../../infra/worker-pool/workerRegistry.js';
import { connectWorkerTransport, type WorkerTransport } from '../../infra/worker-pool/remoteTransport.js';
import type { RemoteArtifacts, RemoteExecutionCommand, RemoteExecutionResponse } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export interface RemoteExecutionPort {
  request(command: RemoteExecutionCommand): Promise<RemoteExecutionResponse>;
}

export interface RemoteTaskExecutor {
  workspace?(assignment: RemoteAssignment, operation: 'inspect' | 'remove'): Promise<boolean>;
  execute(assignment: RemoteAssignment, signal: AbortSignal, port: RemoteExecutionPort): Promise<{
    success: boolean; reason?: string; artifacts?: RemoteArtifacts; interrupted?: boolean; retryable?: boolean;
    workflowResult?: 'completed' | 'aborted' | 'exceeded' | 'error';
    prUrl?: string; prFailed?: boolean; prError?: string;
  }>;
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
  const requests = new Map<string, { message: Extract<WorkerRequest, { kind: 'execution' }>;
    resolve(response: RemoteExecutionResponse): void; reject(error: unknown): void }>();
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
    for (const [id, pending] of requests) if (pending.message.assignment.executionId === assignment.executionId) {
      requests.delete(id); pending.reject(new Error('Remote assignment is no longer valid'));
    }
  };
  const pull = (): void => {
    clearTimeout(poll);
    if (input.executor === undefined || ending || !connected || pendingPull !== undefined || running.size + completions.size >= concurrency) return;
    pendingPull = { ...envelope(), kind: 'pull' };
    transport!.send(pendingPull);
  };
  const execute = (assignment: RemoteAssignment): void => {
    const executor = input.executor;
    if (executor === undefined) return;
    if (running.has(assignment.executionId) || stopped.has(assignment.executionId)
      || [...completions.values()].some((message) => message.assignment.executionId === assignment.executionId)) return;
    const controller = new AbortController();
    const port: RemoteExecutionPort = { request: (command) => new Promise((resolve, reject) => {
      if (ending || controller.signal.aborted) { reject(new Error('Remote execution stopped')); return; }
      const message: Extract<WorkerRequest, { kind: 'execution' }> = { ...envelope(), kind: 'execution', assignment: executionIdentity(assignment), command };
      requests.set(message.requestId, { message, resolve, reject });
      if (connected) transport!.send(message);
    }) };
    const operation = Promise.resolve().then(() => executor.execute(structuredClone(assignment), controller.signal, port))
      .catch((error: unknown) => ({ success: false, reason: sanitizeSensitiveText(error instanceof Error ? error.message : String(error)) }))
      .then((result) => {
        const artifacts = 'artifacts' in result ? result.artifacts : undefined;
        const reason = result.success && artifacts === undefined ? 'Remote executor returned success without published artifacts' : result.reason;
        const message: Extract<WorkerRequest, { kind: 'complete' }> = { ...envelope(), kind: 'complete',
          ...('interrupted' in result ? { interrupted: result.interrupted } : {}),
          ...('retryable' in result ? { retryable: result.retryable } : {}),
          ...('workflowResult' in result ? { workflowResult: result.workflowResult } : {}),
          ...('prUrl' in result ? { prUrl: result.prUrl } : {}),
          ...('prFailed' in result ? { prFailed: result.prFailed } : {}),
          ...('prError' in result ? { prError: result.prError } : {}),
          assignment: executionIdentity(assignment), success: result.success && artifacts !== undefined,
          ...('artifacts' in result && result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
          ...(reason === undefined ? {} : { reason: reason.replaceAll(input.token, '[REDACTED]').slice(0, 8192) }) };
        completions.set(message.requestId, message);
        if (connected && !ending) transport!.send(message);
      }).finally(() => {
        running.delete(assignment.executionId);
        for (const [id, pending] of requests) if (pending.message.assignment.executionId === assignment.executionId) {
          requests.delete(id); pending.reject(new Error('Remote execution has settled'));
        }
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
      case 'workspace': {
        void (async () => {
          await running.get(message.assignment.executionId)?.operation;
          let exists = false;
          let error: string | undefined;
          try {
            if (input.executor?.workspace === undefined) throw new Error('Worker cannot manage execution workspaces');
            exists = await input.executor.workspace(message.assignment, message.operation);
          } catch (failure) { error = sanitizeSensitiveText(failure instanceof Error ? failure.message : String(failure)); }
          if (connected && !ending) transport!.send({ ...envelope(), kind: 'workspace', assignment: executionIdentity(message.assignment),
            operation: message.operation, cleanupId: message.cleanupId, exists, error });
        })();
        break;
      }
      case 'connected':
        connected = true;
        concurrency = message.concurrency;
        for (const assignment of message.stop) stopExecution(assignment);
        for (const assignment of message.running) {
          if (pendingPull?.requestId === assignment.requestId) pendingPull = undefined;
          execute(assignment);
        }
        for (const completion of completions.values()) transport!.send(completion);
        for (const pending of requests.values()) transport!.send(pending.message);
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
      case 'execution': {
        const pending = requests.get(message.requestId);
        if (pending === undefined) break;
        requests.delete(message.requestId);
        pending.resolve(message.response);
        break;
      }
      case 'completed': completions.delete(message.requestId); pull(); break;
    }
  };
  const open = (): void => {
    if (ending) return;
    connected = false;
    const connection = connectWorkerTransport({ url, token: input.token, onResponse: receive });
    transport = connection;
    connection.send({ ...envelope(), kind: 'connect', version: input.version, canExecute: input.executor !== undefined,
      active: [...running.values()].map((entry) => executionIdentity(entry.assignment)).concat([...completions.values()].map((entry) => entry.assignment)) });
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
        active: [...running.values()].map((entry) => executionIdentity(entry.assignment)).concat([...completions.values()].map((entry) => entry.assignment)) });
    }, WORKER_HEARTBEAT_MS);
    open();
    await done;
  } finally {
    ending = true;
    clearTimeout(poll); clearTimeout(retry); clearInterval(heartbeat);
    input.signal.removeEventListener('abort', abort);
    for (const entry of running.values()) entry.controller.abort(new Error('Worker stopped'));
    for (const pending of requests.values()) pending.reject(new Error('Worker stopped'));
    requests.clear();
    transport?.close();
    await Promise.allSettled([...running.values()].map((entry) => entry.operation));
  }
  if (rejected !== undefined) throw rejected;
}
