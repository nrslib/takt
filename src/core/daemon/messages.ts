import type { ConversationAssignment, ConversationRecord } from '../../infra/conversations/schema.js';
import type { OperationResult, SnapshotRead, SnapshotItem, QuestionTarget } from '../../features/manager/conversationPort.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import type { AcceptedEvent } from './events.js';
import type { AssistantCliOverrides } from '../config/provider-resolution.js';
import type { ConversationProgress } from '../../shared/types/conversation-activity.js';

export interface TurnIdentity {
  conversationId: string;
  operationId: string;
  generation: number;
}

export interface ConversationSession {
  provider: string;
  model: string | null;
  sessionId: string | null;
  agentOverrides?: AssistantCliOverrides;
}

/** version は条件付き保存の版。提案の revision とは独立して増える。 */
export interface ConversationTurnState {
  version: number;
  assignment: ConversationAssignment;
  session: ConversationSession;
  revision: number;
  pending: ConversationRecord['pending'];
  approval: ConversationRecord['approval'];
}

/** 同じ operationId の再反映は、版の検証より先に保存済みの結果を返す。 */
export interface ConversationChange {
  operationId: string;
  expectedVersion: number;
  session?: ConversationSession;
  proposal?: { revision: number; pending: ConversationRecord['pending'] };
  approval?: ConversationRecord['approval'];
}

export interface TurnStart {
  // C は event.event の発言ごとの agentOverrides を準備・設定解決へ渡す。
  event: AcceptedEvent;
  turn: TurnIdentity;
  state: ConversationTurnState;
}

export type TurnOutcome =
  | { kind: 'deferred'; change?: never }
  | { kind: 'completed'; result: OperationResult; change?: ConversationChange }
  | { kind: 'failed'; message: string; change?: ConversationChange }
  // 現ターンの中断処理で確定した session 更新・承認予約の解除等。中断後も反映する。
  // 中断済みターンの completed/failed の change と、別ターン・世代の通知は反映しない。
  | { kind: 'interrupted'; change?: ConversationChange };

/** saveResult → apply → markSettled。復元時もこの値だけを再反映する。 */
export interface TurnResult extends TurnIdentity {
  event: AcceptedEvent;
  outcome: TurnOutcome;
}

export type RuntimeMessage =
  | { kind: 'turn_progress'; turn: TurnIdentity; message: ConversationProgress }
  | { kind: 'turn_finished'; turn: TurnIdentity; outcome: TurnOutcome };

export interface InquiryNotice {
  conversationId: string;
  target: QuestionTarget;
  question: GoalQuestion;
}

/** items は遅延生成する。ターン開始の読取は turnState を取得して cancel する。 */
export interface ConversationSnapshot extends SnapshotRead {
  items: AsyncIterable<SnapshotItem & { recordedAt?: string }>;
  queuedMessageCount?: number;
  generation: number | null;
  turnState: ConversationTurnState;
}
