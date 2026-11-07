import type { AcceptedEvent, Admission, ControlEvent, ControlReceipt, EventInput } from './events.js';
import type { DaemonStateRequest, DaemonStateReply } from './processProtocol.js';
import type { ConversationSnapshot, RuntimeMessage, TurnIdentity, TurnResult, TurnStart } from './messages.js';
import type { ConversationProgress } from '../../shared/types/conversation-activity.js';

/** A′ が提供し、D/C/E が受付・制御に使う。invalid な入力の検証は adapter が担う。 */
export interface DaemonIngress {
  accept(input: EventInput): Promise<Admission>;
  control(event: ControlEvent): Promise<ControlReceipt>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
}

/** A が B に保存させ、再起動時に A が未終了分だけ復元する。running は人の入力を中断し、other を再配信する。 */
export type StoredEvent =
  | { state: 'queued'; event: AcceptedEvent }
  | { state: 'running'; event: AcceptedEvent; turn: TurnIdentity }
  | { state: 'settling'; event: AcceptedEvent; result: TurnResult };

/** B が実装し、A が使う。各更新は atomic・冪等。重複キーは eventId または conversationId/requestId。 */
export interface EventStore {
  // 発言ごとの agentOverrides を含むイベント全体を保存し、restore/duplicate でも保持する。
  // 失敗時は保存途中のイベントも破棄し、復元で実行しない。
  accept(event: AcceptedEvent): Promise<
    { kind: 'stored' } | { kind: 'duplicate'; event: AcceptedEvent; state: 'queued' | 'running' | 'settling' | 'settled' }
  >;
  markStarted(eventId: string, turn: TurnIdentity): Promise<void>;
  // apply の前に結果を durable にし、再起動時も provider を呼び直さない。
  saveResult(eventId: string, result: TurnResult): Promise<void>;
  // deferred はターンだけを終え、元イベントを queued に戻す。
  markSettled(eventId: string, result: TurnResult): Promise<void>;
  restore(): Promise<{ lastAcceptedSequence: number; pending: AsyncIterable<StoredEvent> }>;
}

/** A のキュー実装を dispatcher が使う。add は保存前の順序予約、confirm は永続化完了。pending は保留以外の未終了分（実行中も含む）。 */
export interface TurnQueues {
  add(event: AcceptedEvent): void;
  confirm(eventId: string): void;
  peekNext(canStart: (conversationId: string) => boolean): AcceptedEvent | undefined;
  markStarted(eventId: string): void;
  defer(eventId: string): void;
  resumeGoal(target: { repositoryDirectory: string; goalId: string } | { conversationId: string; goalId: string }): void;
  remove(eventId: string): void;
  pending(conversationId: string): readonly AcceptedEvent[];
}

/** daemon の保存所有者。apply は turn と change.operationId で冪等にする。 */
export interface ConversationOwner {
  inquiry(notice: import('./messages.js').InquiryNotice): Promise<void>;
  apply(result: TurnResult): Promise<void>;
  progress(turn: TurnIdentity, message: ConversationProgress): Promise<void>;
  // 実行中ターンの識別情報は、それを所有する dispatcher が付ける。
  snapshot(conversationId: string): Promise<Omit<ConversationSnapshot, 'operationId' | 'generation'>>;
}

/** C が実装し、A′ が開始・中断を送る。start は待たず、終了は必ず bus.post(turn_finished) で通知する。 */
export interface TurnRunner {
  start(input: TurnStart, signal: AbortSignal): void;
  resultCommitted(turn: TurnIdentity): void;
  interrupt(turn: TurnIdentity): void;
  // IPC の通知だけでなく、所有する実プロセスの終了と全ターンの終了通知まで待つ。
  close(): Promise<void>;
}

/** B/D が実装。対象・世代・期待版・操作 ID を検証し、業務判断は行わない。
 * 保存確定前に signal を再確認し、取消時も副作用と後始末が終了してから Promise を完了する。
 * 取消より先に確定した保存は成功を返してよい。dispatcher は全要求の完了後に結果を反映する。
 */
export interface DaemonStateOwner {
  handle(turn: TurnIdentity, request: DaemonStateRequest, signal: AbortSignal): Promise<DaemonStateReply>;
}

/** 進捗・終了と、daemon が所有する限定状態の操作だけを受ける。 */
export interface DaemonBus {
  post(message: RuntimeMessage): Promise<void>;
  request(turn: TurnIdentity, request: DaemonStateRequest, signal: AbortSignal): Promise<DaemonStateReply>;
}

/** 監視・通信の終了確認。ターン子は TurnRunner だけが所有する。 */
export interface DaemonResources {
  close(): Promise<void>;
}

/** A が保存失敗を作り、組立側がログと保存回復後の retryStorage 呼出しに使う。 */
export interface DispatchFailure {
  phase: 'accept' | 'start' | 'settle' | 'progress';
  event: AcceptedEvent;
  error: unknown;
}
