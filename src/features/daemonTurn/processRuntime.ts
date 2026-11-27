import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { TurnIdentity, TurnOutcome, TurnStart } from '../../core/daemon/messages.js';
import { TURN_PROTOCOL_VERSION,
  parseDaemonProcessMessage, parseTurnProcessMessage,
  type DaemonStateRequest, type DaemonStateReply, type TurnProcessMessage } from '../../core/daemon/processProtocol.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { MAX_PROCESS_PROGRESS_BYTES } from '../../core/daemon/processProtocol.js';
import type { ConversationProgress } from '../../shared/types/conversation-activity.js';
import { SerialSender } from '../../shared/utils/serialSender.js';

export interface TurnIo {
  signal: AbortSignal;
  request(request: DaemonStateRequest, signal?: AbortSignal): Promise<DaemonStateReply>;
  progress(message: ConversationProgress): void | Promise<void>;
}
export interface TurnBusiness {
  execute(input: TurnStart, io: TurnIo): Promise<TurnOutcome>;
  close(): Promise<void>;
}
export interface TurnTransport {
  send(message: TurnProcessMessage): Promise<void>;
}
interface PendingRequest {
  turn: TurnIdentity;
  signal?: AbortSignal;
  resolve(reply: DaemonStateReply): void;
  reject(error: unknown): void;
  listener?: ReturnType<typeof addAbortListener>;
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
  const requests = new Map<string, PendingRequest>();
  let progressCompletion = Promise.resolve();
  let progressAvailable = true;
  const sender = new SerialSender<TurnProcessMessage>((message, done) => {
    input.transport.send(message).then(() => { done(null); }, done);
  });
  const envelope = () => {
    if (initialized === undefined) throw new Error('Turn process is not initialized');
    return { protocolVersion: TURN_PROTOCOL_VERSION, launchId: initialized.launchId } as const;
  };
  const send = async (value: unknown): Promise<void> => {
    await sender.send(parseTurnProcessMessage(value, envelope().launchId));
  };
  const removeRequest = (requestId: string) => {
    const pending = requests.get(requestId);
    requests.delete(requestId);
    pending?.listener?.[Symbol.dispose]();
    return pending;
  };
  const rejectRequests = (error: unknown): void => {
    for (const requestId of requests.keys()) removeRequest(requestId)?.reject(error);
  };
  const cancelRequest = (requestId: string, pending: PendingRequest): void => {
    if (requests.get(requestId) !== pending) return;
    void send({ ...envelope(), kind: 'cancel_daemon_request', turn: pending.turn, requestId }).catch((error: unknown) => {
      removeRequest(requestId)?.reject(error);
      input.onFatal(error);
    });
  };
  const request = (turn: TurnIdentity, value: DaemonStateRequest, signal?: AbortSignal): Promise<DaemonStateReply> => {
    if (active === undefined || !sameTurn(active.turn, turn) || active.outcome !== undefined || closing !== undefined) {
      return Promise.reject(new Error('Turn is no longer active'));
    }
    active.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const requestId = randomUUID();
    const message: TurnProcessMessage = { ...envelope(), kind: 'daemon_request', turn, requestId, request: value };
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { turn, signal, resolve, reject };
      requests.set(requestId, pending);
      const sending = send(message);
      if (signal !== undefined && requests.get(requestId) === pending) {
        pending.listener = addAbortListener(signal, () => cancelRequest(requestId, pending));
      }
      void sending.catch((error: unknown) => {
        removeRequest(requestId)?.reject(error);
        input.onFatal(error);
      });
    });
  };
  const shutdown = (): Promise<void> => closing ??= (async () => {
    active?.controller.abort();
    for (const [requestId, pending] of requests) {
      if (pending.signal === undefined) removeRequest(requestId)?.reject(new Error('Turn process is shutting down'));
      else cancelRequest(requestId, pending);
    }
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
      if (message.kind === 'daemon_reply') {
        const pending = requests.get(message.requestId);
        if (pending !== undefined && sameTurn(pending.turn, message.turn)) {
          removeRequest(message.requestId);
          pending.resolve(message.reply);
        }
        return;
      }
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
          progressCompletion = Promise.resolve();
          progressAvailable = true;
          current.completion = Promise.resolve().then(async () => {
            let outcome: TurnOutcome;
            try {
              outcome = await business!.execute(message.input, { signal: controller.signal,
                request: (value, signal) => request(current.turn, value, signal),
                progress: (value) => {
                  if (controller.signal.aborted || current.outcome !== undefined) return Promise.resolve();
                  const message = typeof value === 'string' ? truncateUtf8(value, MAX_PROCESS_PROGRESS_BYTES).value
                    : value.kind === 'turn_text' ? { ...value, message: truncateUtf8(value.message, MAX_PROCESS_PROGRESS_BYTES).value } : value;
                  const delivery = progressCompletion.then(async () => {
                    if (!controller.signal.aborted && progressAvailable) await send({ ...envelope(), kind: 'turn_progress', turn: current.turn, message });
                  });
                  // void の provider callback が使われても、終了通知は全配信を待つ。
                  progressCompletion = delivery.catch(() => { progressAvailable = false; });
                  return progressCompletion;
                } });
            } catch {
              outcome = controller.signal.aborted ? { kind: 'interrupted' } : { kind: 'failed', message: 'Turn execution failed' };
            }
            await progressCompletion;
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
      }
    },
    async disconnect(): Promise<void> { await shutdown(); },
    /** IPC が切れた後は送信の完了通知が来ないので、送信待ちを解放してから終了する。 */
    async transportClosed(): Promise<void> {
      sender.close(new Error('Turn transport disconnected'));
      rejectRequests(new Error('Turn transport disconnected'));
      await shutdown();
    },
  };
}
