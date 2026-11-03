import type { AcceptedEvent, Admission, ControlEvent, ControlReceipt, EventInput } from '../../core/daemon/events.js';
import type { ConversationSnapshot, ConversationTurnState, RuntimeMessage, TurnIdentity } from '../../core/daemon/messages.js';
import type { EventStore, StoredEvent } from '../../core/daemon/ports.js';
import type { DaemonStateReply, DaemonStateRequest } from '../../core/daemon/processProtocol.js';

export interface Reply<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function reply<T>(): Reply<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export type Completion<T> = { ok: true; value: T } | { ok: false; error: unknown };
export type OwnerSnapshot = Omit<ConversationSnapshot, 'operationId' | 'generation'>;

export type DispatcherNotice =
  | { kind: 'restore_sequence'; sequence: number }
  | { kind: 'restore_event'; stored: StoredEvent }
  | { kind: 'restore_complete'; reply: Reply<void> }
  | { kind: 'accept'; input: EventInput; operationId: string; response: { reply: Reply<Admission> } }
  | { kind: 'admission_saved'; event: AcceptedEvent; attempt: number; result: Completion<Awaited<ReturnType<EventStore['accept']>>> }
  | { kind: 'start_saved'; turn: TurnIdentity; result: Completion<void> }
  | { kind: 'turn_state_read'; turn: TurnIdentity; result: Completion<ConversationTurnState> }
  | { kind: 'process_started'; turn: TurnIdentity; result: Completion<void> }
  | { kind: 'runtime'; message: RuntimeMessage; reply: Reply<void> }
  | { kind: 'progress_delivered'; turn: TurnIdentity; id: number; result: Completion<void> }
  | { kind: 'request'; turn: TurnIdentity; request: DaemonStateRequest; signal: AbortSignal; reply: Reply<DaemonStateReply> }
  | { kind: 'request_completed'; turn: TurnIdentity; id: number; result: Completion<DaemonStateReply> }
  | { kind: 'result_saved' | 'result_applied' | 'result_settled' | 'result_committed'; turn: TurnIdentity; attempt: number; result: Completion<void> }
  | { kind: 'snapshot'; conversationId: string; reply: Reply<ConversationSnapshot> }
  | { kind: 'snapshot_read'; id: number; conversationId: string; reply: Reply<ConversationSnapshot>; result: Completion<OwnerSnapshot> }
  | { kind: 'control'; event: ControlEvent; response: { reply: Reply<ControlReceipt> } }
  | { kind: 'runner_closed' | 'resources_closed'; result: Completion<void> }
  | { kind: 'shutdown_drained' }
  | { kind: 'retry_storage' | 'drain'; reply: Reply<void> }
  | { kind: 'effect_completed'; id: number; result: Completion<void> };

/** 副作用は状態を捕捉せず、完了値だけをメールボックスへ返す。 */
export type DispatcherEffect = () => Promise<DispatcherNotice>;

export function effect<T>(action: () => T | Promise<T>, complete: (result: Completion<T>) => DispatcherNotice): DispatcherEffect {
  return async () => {
    try { return complete({ ok: true, value: await action() }); }
    catch (error) { return complete({ ok: false, error }); }
  };
}
