import { randomUUID } from 'node:crypto';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { TurnIdentity, TurnOutcome, TurnStart } from '../../core/daemon/messages.js';
import { TURN_PROTOCOL_VERSION, MAX_PROCESS_PENDING_BYTES, MAX_PROCESS_PENDING_REQUESTS,
  parseDaemonProcessMessage, parseTurnProcessMessage, processRequestBytes,
  type DaemonStateRequest, type DaemonStateReply, type TurnProcessMessage } from '../../core/daemon/processProtocol.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { MAX_PROCESS_PROGRESS_BYTES } from '../../core/daemon/processProtocol.js';

export interface TurnIo {
  signal: AbortSignal;
  request(request: DaemonStateRequest): Promise<DaemonStateReply>;
  progress(message: string): void;
}
export interface TurnBusiness {
  execute(input: TurnStart, io: TurnIo): Promise<TurnOutcome>;
  close(): Promise<void>;
}
export interface TurnTransport {
  send(message: TurnProcessMessage): Promise<void>;
}
const sameTurn = (a: TurnIdentity, b: TurnIdentity): boolean => a.conversationId === b.conversationId
  && a.operationId === b.operationId && a.generation === b.generation;

export function createTurnProcessRuntime(input: {
  transport: TurnTransport;
  createBusiness(configDirectory: string, assignment: ConversationAssignment): TurnBusiness | Promise<TurnBusiness>;
  onFatal(error: unknown): void;
}) {
  let initialized: { launchId: string; conversationId: string; assignment: ConversationAssignment } | undefined;
  let business: TurnBusiness | undefined;
  let initialization: Promise<void> | undefined;
  let active: { turn: TurnIdentity; controller: AbortController; completion: Promise<void>; outcome?: TurnOutcome } | undefined;
  let closing: Promise<void> | undefined;
  const requests = new Map<string, { turn: TurnIdentity; bytes: number; resolve(reply: DaemonStateReply): void; reject(error: unknown): void }>();
  let requestBytes = 0;
  let sendCount = 0;
  let sendBytes = 0;
  const envelope = () => {
    if (initialized === undefined) throw new Error('Turn process is not initialized');
    return { protocolVersion: TURN_PROTOCOL_VERSION, launchId: initialized.launchId } as const;
  };
  const send = async (value: unknown): Promise<void> => {
    const message = parseTurnProcessMessage(value, envelope().launchId);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (sendCount >= MAX_PROCESS_PENDING_REQUESTS || sendBytes + bytes > MAX_PROCESS_PENDING_BYTES) throw new Error('Process send capacity exceeded');
    sendCount++;
    sendBytes += bytes;
    try { await input.transport.send(message); }
    finally { sendCount--; sendBytes -= bytes; }
  };
  const rejectRequests = (error: unknown): void => {
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
    requestBytes = 0;
  };
  const request = (turn: TurnIdentity, value: DaemonStateRequest): Promise<DaemonStateReply> => {
    if (active === undefined || !sameTurn(active.turn, turn) || active.outcome !== undefined || closing !== undefined) {
      return Promise.reject(new Error('Turn is no longer active'));
    }
    active.controller.signal.throwIfAborted();
    const requestId = randomUUID();
    const message: TurnProcessMessage = { ...envelope(), kind: 'daemon_request', turn, requestId, request: value };
    const bytes = processRequestBytes(requests.size, requestBytes, message);
    return new Promise((resolve, reject) => {
      requests.set(requestId, { turn, bytes, resolve, reject });
      requestBytes += bytes;
      void send(message).catch((error: unknown) => {
        if (requests.delete(requestId)) requestBytes -= bytes;
        reject(error);
        input.onFatal(error);
      });
    });
  };
  const shutdown = (): Promise<void> => closing ??= (async () => {
    active?.controller.abort();
    rejectRequests(new Error('Turn process is shutting down'));
    await initialization;
    const results = await Promise.allSettled([active?.completion, business?.close()]);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'Turn shutdown failed');
    if (initialized !== undefined) await send({ ...envelope(), kind: 'shutdown_complete' });
  })();
  return {
    async receive(value: unknown): Promise<void> {
      const launchId = initialized?.launchId ?? (typeof value === 'object' && value !== null && 'launchId' in value && typeof value.launchId === 'string'
        ? value.launchId : '');
      const message = parseDaemonProcessMessage(value, launchId);
      if (message.kind === 'initialize') {
        if (initialized !== undefined || closing !== undefined) throw new Error('Turn process already initialized');
        initialized = { launchId: message.launchId, conversationId: message.conversationId, assignment: message.assignment };
        initialization = Promise.resolve(input.createBusiness(message.configDirectory, message.assignment)).then((value) => { business = value; });
        await initialization;
        if (closing === undefined) await send({ ...envelope(), kind: 'ready' });
        return;
      }
      if (initialized === undefined) throw new Error('Initialize the turn process first');
      if (message.kind === 'shutdown') { await shutdown(); return; }
      if (closing !== undefined) return;
      if (business === undefined) throw new Error('Turn process initialization is not complete');
      switch (message.kind) {
        case 'start_turn': {
          if (active !== undefined) throw new Error('Turn process is busy until result_committed');
          if (message.input.turn.conversationId !== initialized.conversationId
            || JSON.stringify(message.input.state.assignment) !== JSON.stringify(initialized.assignment)) throw new Error('Turn assignment mismatch');
          const controller = new AbortController();
          const current = { turn: message.input.turn, controller, completion: Promise.resolve(), outcome: undefined as TurnOutcome | undefined };
          active = current;
          current.completion = Promise.resolve().then(async () => {
            let outcome: TurnOutcome;
            try {
              outcome = await business!.execute(message.input, { signal: controller.signal,
                request: (value) => request(current.turn, value),
                progress: (value) => {
                  if (controller.signal.aborted) return;
                  void send({ ...envelope(), kind: 'turn_progress', turn: current.turn,
                    message: truncateUtf8(value, MAX_PROCESS_PROGRESS_BYTES).value }).catch(input.onFatal);
                } });
            } catch {
              outcome = controller.signal.aborted ? { kind: 'interrupted' } : { kind: 'failed', message: 'Turn execution failed' };
            }
            if (controller.signal.aborted && outcome.kind !== 'interrupted') outcome = { kind: 'interrupted' };
            current.outcome = outcome;
            await send({ ...envelope(), kind: 'turn_finished', turn: current.turn, outcome });
          });
          void current.completion.catch(input.onFatal);
          break;
        }
        case 'interrupt':
          if (active !== undefined && sameTurn(active.turn, message.turn) && active.outcome === undefined) active.controller.abort();
          break;
        case 'result_committed':
          if (active !== undefined && sameTurn(active.turn, message.turn)) {
            if (active.outcome === undefined) throw new Error('Cannot commit an unfinished turn');
            active = undefined;
          }
          break;
        case 'daemon_reply': {
          const pending = requests.get(message.requestId);
          if (pending === undefined || !sameTurn(pending.turn, message.turn)) return;
          requests.delete(message.requestId);
          requestBytes -= pending.bytes;
          pending.resolve(message.reply);
          break;
        }
      }
    },
    async disconnect(): Promise<void> { await shutdown(); },
  };
}
