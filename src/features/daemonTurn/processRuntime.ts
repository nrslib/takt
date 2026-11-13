import { randomUUID } from 'node:crypto';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import type { TurnIdentity, TurnOutcome, TurnStart } from '../../core/daemon/messages.js';
import { TURN_PROTOCOL_VERSION, MAX_PROCESS_PENDING_PROGRESS, MAX_PROCESS_PROGRESS_BYTES,
  parseDaemonProcessMessage, parseTurnProcessMessage,
  type DaemonStateRequest, type DaemonStateReply, type TurnProcessMessage } from '../../core/daemon/processProtocol.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { SerialSender } from '../../shared/utils/serialSender.js';
import { isToolHistoryProgress, type ConversationActivity, type ConversationProgress } from '../../shared/types/conversation-activity.js';
import { DroppedToolOutputs } from '../../shared/tool-activity/droppedOutputs.js';

export interface TurnIo {
  signal: AbortSignal;
  request(request: DaemonStateRequest): Promise<DaemonStateReply>;
  progress(message: ConversationProgress): void;
}
export interface TurnBusiness {
  execute(input: TurnStart, io: TurnIo): Promise<TurnOutcome>;
  close(): Promise<void>;
}
export interface TurnTransport {
  send(message: TurnProcessMessage): Promise<void>;
}
interface ActiveTurn {
  turn: TurnIdentity;
  controller: AbortController;
  completion: Promise<void>;
  outcome?: TurnOutcome;
  /** 直前の要求の返信を待ち終えると解決する。 */
  requestSlot: Promise<void>;
  droppedOutputs: DroppedToolOutputs;
}
const sameTurn = (a: TurnIdentity, b: TurnIdentity): boolean => a.conversationId === b.conversationId
  && a.operationId === b.operationId && a.generation === b.generation;

function mergeToolOutput(previous: ConversationProgress, next: ConversationProgress): ConversationProgress | undefined {
  if (typeof previous === 'string' || previous.kind !== 'tool_event' || typeof next === 'string' || next.kind !== 'tool_event') return undefined;
  const before = previous.event;
  const after = next.event;
  if (before.type !== 'tool_output' || after.type !== 'tool_output' || before.data.id !== after.data.id
    || before.data.tool !== after.data.tool || before.toolActivity?.callId !== after.toolActivity?.callId) return undefined;
  return { ...previous, event: { ...before, data: { ...before.data, output: before.data.output + after.data.output } } };
}

/** 待機対象の Promise は失敗しない。中断されたら待つのをやめる。 */
function untilAborted(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}

export function createTurnProcessRuntime(input: {
  transport: TurnTransport;
  createBusiness(configDirectory: string, assignment: ConversationAssignment): TurnBusiness | Promise<TurnBusiness>;
  onFatal(error: unknown): void;
}) {
  let initialized: { launchId: string; conversationId: string; assignment: ConversationAssignment } | undefined;
  let business: TurnBusiness | undefined;
  let initialization: Promise<void> | undefined;
  let active: ActiveTurn | undefined;
  let closing: Promise<void> | undefined;
  const requests = new Map<string, { turn: TurnIdentity; resolve(reply: DaemonStateReply): void; reject(error: unknown): void }>();
  let pendingActivity: { turn: TurnIdentity; activity: ConversationActivity } | undefined;
  let sendingActivity = false;
  let activityUnavailable = false;
  let progressUnavailable = false;
  const progressQueue: Array<{ turn: TurnIdentity; message: ConversationProgress; signal: AbortSignal }> = [];
  let flushingProgress = false;
  let progressCompletion = Promise.resolve();
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
  const flushActivity = async (): Promise<void> => {
    sendingActivity = true;
    try {
      while (pendingActivity !== undefined) {
        if (flushingProgress) await progressCompletion;
        if (pendingActivity === undefined) break;
        const { turn, activity } = pendingActivity;
        pendingActivity = undefined;
        if (active === undefined || !sameTurn(active.turn, turn) || active.controller.signal.aborted || active.outcome !== undefined) continue;
        await send({ ...envelope(), kind: 'turn_progress', turn, message: activity });
      }
    } catch {
      // 表示の配送が使えなくても、ターンの結果は通常の経路で確定する。
      activityUnavailable = true;
    } finally {
      pendingActivity = undefined;
      sendingActivity = false;
    }
  };
  const flushProgress = async (): Promise<void> => {
    flushingProgress = true;
    try {
      while (progressQueue.length > 0) {
        const pending = progressQueue[0]!;
        try {
          if (!pending.signal.aborted) await send({ ...envelope(), kind: 'turn_progress', turn: pending.turn, message: pending.message });
        } finally {
          progressQueue.shift();
        }
      }
    } catch {
      // 途中表示の送信失敗は、実行結果の確定に影響させない。
      progressUnavailable = true;
      progressQueue.length = 0;
    } finally { flushingProgress = false; }
  };
  const queueProgress = (current: ActiveTurn, message: ConversationProgress): void => {
    if (current.droppedOutputs.follows(message)) return;
    // 送信中の先頭は書き換えない。
    const last = progressQueue.length > (flushingProgress ? 1 : 0) ? progressQueue.at(-1) : undefined;
    const merged = last === undefined ? undefined : mergeToolOutput(last.message, message);
    if (last !== undefined && merged !== undefined) {
      progressQueue[progressQueue.length - 1] = { ...last, message: merged };
      return;
    }
    // 送信が詰まっている間は途中表示だけを間引き、空きが戻れば再び送る。
    if (!isToolHistoryProgress(message)
      && progressQueue.filter((pending) => !isToolHistoryProgress(pending.message)).length >= MAX_PROCESS_PENDING_PROGRESS) {
      current.droppedOutputs.record(message);
      return;
    }
    progressQueue.push({ turn: current.turn, message, signal: current.controller.signal });
    if (!flushingProgress) progressCompletion = flushProgress();
  };
  const rejectRequests = (error: unknown): void => {
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
  };
  const sendRequest = async (current: ActiveTurn, value: DaemonStateRequest): Promise<DaemonStateReply> => {
    if (active !== current || current.outcome !== undefined || closing !== undefined) throw new Error('Turn is no longer active');
    current.controller.signal.throwIfAborted();
    const requestId = randomUUID();
    const message: TurnProcessMessage = { ...envelope(), kind: 'daemon_request', turn: current.turn, requestId, request: value };
    return new Promise((resolve, reject) => {
      requests.set(requestId, { turn: current.turn, resolve, reject });
      void send(message).catch((error: unknown) => {
        requests.delete(requestId);
        reject(error);
        input.onFatal(error);
      });
    });
  };
  // 返信を待つ要求は 1 ターンにつき 1 件に限る。後続の要求は前の返信を待ち、中断・終了で待つのをやめる。
  const request = async (current: ActiveTurn, value: DaemonStateRequest): Promise<DaemonStateReply> => {
    const previous = current.requestSlot;
    let release!: () => void;
    const finished = new Promise<void>((resolve) => { release = resolve; });
    current.requestSlot = previous.then(() => finished);
    try {
      await untilAborted(previous, current.controller.signal);
      return await sendRequest(current, value);
    } finally { release(); }
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
          const current: ActiveTurn = { turn: message.input.turn, controller, completion: Promise.resolve(), requestSlot: Promise.resolve(),
            droppedOutputs: new DroppedToolOutputs() };
          active = current;
          activityUnavailable = false;
          progressUnavailable = false;
          progressCompletion = Promise.resolve();
          current.completion = Promise.resolve().then(async () => {
            let outcome: TurnOutcome;
            try {
              outcome = await business!.execute(message.input, { signal: controller.signal,
                request: (value) => request(current, value),
                progress: (value) => {
                  if (controller.signal.aborted || current.outcome !== undefined || progressUnavailable) return;
                  if (typeof value !== 'string' && value.kind !== 'turn_text' && value.kind !== 'tool_event') {
                    if (activityUnavailable) return;
                    pendingActivity = { turn: current.turn, activity: value };
                    if (!sendingActivity) void flushActivity();
                    return;
                  }
                  queueProgress(current, typeof value === 'string' ? truncateUtf8(value, MAX_PROCESS_PROGRESS_BYTES).value
                    : value.kind === 'turn_text' ? { kind: value.kind, message: truncateUtf8(value.message, MAX_PROCESS_PROGRESS_BYTES).value }
                    : value);
                } });
            } catch {
              outcome = controller.signal.aborted ? { kind: 'interrupted' } : { kind: 'failed', message: 'Turn execution failed' };
            }
            await progressCompletion;
            if (controller.signal.aborted && outcome.kind !== 'interrupted') outcome = { kind: 'interrupted' };
            current.outcome = outcome;
            pendingActivity = undefined;
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
          pending.resolve(message.reply);
          break;
        }
      }
    },
    async disconnect(): Promise<void> { await shutdown(); },
  };
}
