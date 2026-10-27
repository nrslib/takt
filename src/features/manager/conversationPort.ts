import type { Goal, GoalAnswerInput, GoalQuestion } from '../../infra/goals/schema.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import type { ConversationActor, ConversationAssignment, ConversationRecord, PortBinding } from '../../infra/conversations/schema.js';
import type { WritablePermissionScope } from './scopedPermissionStorage.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { ManagerAssignment } from './startupResolution.js';
import type { ManagerDisplayEvent } from './savedEvents.js';

export type ConversationCommand =
  | { kind: 'message'; text: string }
  | { kind: 'approve_summary' | 'dismiss_summary'; revision: number }
  | { kind: 'answer_question'; target: QuestionTarget; questionId: string; answer: GoalAnswerInput;
      permission?: { scope: WritablePermissionScope; sentence: string } }
  | { kind: 'pause_goal' | 'resume_goal' | 'abort_goal'; goalId: string }
  | { kind: 'abort_turn'; operationId: string };
export type QuestionTarget = { goalId: string; repositoryDirectory: string } | { goalId: null; owner: InquiryOwner };
export interface ConversationState {
  conversationId: string;
  assignment: ConversationAssignment;
  revision: number;
  pending: ConversationRecord['pending'];
  approval: ConversationRecord['approval'];
  running: { operationId: string; kind: string } | null;
  interrupted: boolean;
}
export type SnapshotValue =
  | { kind: 'state'; state: ConversationState }
  | { kind: 'assignment'; assignment: ManagerAssignment }
  | { kind: 'goal'; goal: Pick<Goal, 'id' | 'objective' | 'status' | 'executionStatus'> & { repositoryDirectory: string } }
  | { kind: 'inquiry'; inquiry: { target: QuestionTarget; question: GoalQuestion; objective?: string } }
  | { kind: 'display_event'; event: ManagerDisplayEvent };
export type SnapshotItem = SnapshotValue | { kind: 'remove'; key: string };
export type SnapshotMode = 'initial' | 'delta';
export interface OutputVersion { revision: number; stateSequence: number; operationId: string | null }
export interface SnapshotRead extends OutputVersion {
  transferId: string;
  conversationId: string;
  mode: SnapshotMode;
  items: AsyncIterable<SnapshotItem>;
  complete(): void;
  cancel(): void;
}
export type Submission = { kind: 'accepted' | 'busy'; operationId: string } | { kind: 'error'; code: string; message: string };
export type OperationResult =
  | { kind: 'reply'; message: string }
  | { kind: 'goal_registered'; goal: Goal }
  | { kind: 'answer_saved'; answerSaved: boolean; message: string }
  | { kind: 'error'; code: string; message: string; answerSaved?: boolean; permissionAppended?: boolean };
export type PortOutput =
  | { kind: 'snapshot'; read: SnapshotRead }
  | { kind: 'reply' | 'progress'; operationId: string; message: string }
  | { kind: 'pending' | 'running'; state: ConversationState }
  | { kind: 'notice'; id: string; message: string }
  | { kind: 'inquiry'; target: QuestionTarget; question: GoalQuestion }
  | { kind: 'result'; operationId: string; result: OperationResult };
export interface ConversationDelivery {
  deliver(conversationId: string, output: PortOutput, version: OutputVersion): Promise<
    { kind: 'delivered' } | { kind: 'unavailable'; reason: string }>;
}
export interface ConversationOpen {
  conversationId: string;
  assignment: ConversationAssignment;
  binding: PortBinding;
  speaker: ConversationActor;
  agentOverrides?: AssistantCliOverrides;
}
export interface ConversationInput {
  open(input: ConversationOpen, delivery: ConversationDelivery): Promise<{ attachmentId: string; read: SnapshotRead }>;
  submit(input: { attachmentId: string; requestId: string; speaker: ConversationActor; command: ConversationCommand }): Promise<Submission>;
  snapshot(attachmentId: string): Promise<SnapshotRead>;
  detach(attachmentId: string): void;
}
export interface ConversationPort<Endpoint> {
  resolve(endpoint: Endpoint): Promise<ConversationOpen>;
  delivery: ConversationDelivery;
}
