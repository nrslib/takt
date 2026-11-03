import type { ConversationActor } from '../../infra/conversations/schema.js';
import type { GoalQuestion, GoalTaskResult } from '../../infra/goals/schema.js';
import type { ConversationCommand } from '../../features/manager/conversationPort.js';
import type { AssistantCliOverrides } from '../config/provider-resolution.js';

/** F が入力を検証して作り、D が会話操作として使う。 */
export type HumanCommand = Exclude<ConversationCommand, { kind: 'abort_turn' | 'answer_question' }>;

/** C/E が実行結果から作り、C/D が同じ実行の照合に使う。 */
export interface TaskRef {
  repositoryDirectory: string;
  goalId: string;
  taskName: string;
  runSlug?: string;
  executionId?: string;
}

/** E が証拠から作り、C/D が状態を再確認して扱う。unknown を死亡とみなさない。 */
export type WatchObservation = {
  targetId: string;
  generation: string;
  observedAt: string;
} & (
  | { kind: 'run_process_lost'; task: TaskRef; pid: number; startTime: string | null }
  | { kind: 'run_log_stalled'; task: TaskRef; lastUpdatedAt: string }
  | { kind: 'pr_changed'; repositoryDirectory: string; goalId: string; url: string; state: 'MERGED' | 'CLOSED' }
  | { kind: 'pr_mismatch'; repositoryDirectory: string; goalId: string; url: string; reason: string }
  | { kind: 'inquiry_stalled'; repositoryDirectory: string; questionId: string; goalId: string | null }
  | { kind: 'goal_stalled'; repositoryDirectory: string; goalId: string; lastUpdatedAt: string }
  | { kind: 'run_launch_stalled'; repositoryDirectory: string }
  | { kind: 'watch_failed'; reason: string }
  | { kind: 'director_state_changed'; managerConversationId: string; repositoryDirectory: string; goalId: string | null; state: string }
);

/** F/C/E が作り、A が優先度を決め、D が同じ会話の文脈で処理する。 */
export type TurnEvent =
  // 接続ごとの指定を発言に固定する。session の provider/model は上書き指定の代用にしない。
  | { kind: 'human_command'; command: HumanCommand; speaker: ConversationActor; agentOverrides?: AssistantCliOverrides }
  | { kind: 'inquiry_answer'; command: Extract<ConversationCommand, { kind: 'answer_question' }> }
  | { kind: 'task_completed' | 'task_failed'; task: TaskRef; result: GoalTaskResult }
  | { kind: 'director_message'; directorConversationId: string; text: string }
  | { kind: 'goal_registered' | 'goal_resumed'; repositoryDirectory: string; goalId: string }
  | { kind: 'inquiry_answered'; repositoryDirectory: string; goalId: string; questionId: string; answer: NonNullable<GoalQuestion['answer']> }
  | { kind: 'watch_observation'; observation: WatchObservation };

/** F が作り、A がキューを経由せず現在の実行だけへ配送する。 */
export type ControlEvent =
  | { kind: 'interrupt'; conversationId: string; operationId: string; generation: number }
  | { kind: 'stop' };

/** F/C/E が作り、A/B が受付と重複排除に使う。受け箱の eventId はファイル再読込でも固定。 */
export interface EventInput {
  eventId: string;
  requestId: string;
  conversationId: string;
  source: 'tui' | 'slack' | 'run' | 'director' | 'watcher' | 'daemon';
  occurredAt: string;
  event: TurnEvent;
}

/** A が最初の await 前に採番し、B が保存、C/D が実行する。sequence は daemon 全体で単調増加。 */
export interface AcceptedEvent extends EventInput {
  operationId: string;
  acceptedSequence: number;
  lane: 'human' | 'other';
}

/** A が永続化後に作り、F/C/E が業務上の受付確認に使う。 */
export type Admission =
  | { kind: 'accepted'; eventId: string; operationId: string; acceptedSequence: number; queuedMessageCount?: number }
  | { kind: 'rejected'; reason: 'capacity' | 'storage' | 'stopping' };

/** A が作り、F が中断対象の一致と停止完了を表示する。 */
export type ControlReceipt = { kind: 'interrupted' | 'ignored' | 'stopped' };
