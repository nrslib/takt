import { z } from 'zod/v4';
import { ApprovalSchema, ConversationActorSchema, ConversationAgentOverridesSchema, PendingSummarySchema } from '../conversations/schema.js';
import { GoalAnswerSchema, GoalSchema, GoalTaskResultSchema } from '../goals/schema.js';
import { ConversationCommandSchema } from '../../features/manager/conversationCommands.js';
import { MAX_PROCESS_MESSAGE_BYTES } from '../../core/daemon/processProtocol.js';
import type { AcceptedEvent, EventInput } from '../../core/daemon/events.js';
import type { ConversationChange, TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import { conversationId } from '../conversations/identity.js';

const id = z.string().min(1).max(128);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const task = z.object({ repositoryDirectory: z.string(), goalId: id, taskName: z.string(), runSlug: id.optional(), executionId: id.optional() }).strict();
const observed = { targetId: id, generation: id, observedAt: z.iso.datetime() };
const repositoryGoal = { repositoryDirectory: z.string(), goalId: id };
// 廃止した観測は保存データの読み飛ばしにだけ使い、新規受付には戻さない。
const retiredWatchEvent = z.object({
  event: z.object({ kind: z.literal('watch_observation'), observation: z.object({
    kind: z.enum(['run_too_long', 'run_step_repeated', 'run_log_stalled', 'inquiry_stalled', 'goal_stalled', 'goal_pr_retry']),
  }) }),
});
export function isRetiredWatchEvent(input: unknown): boolean {
  return retiredWatchEvent.safeParse(input).success;
}
const observation = z.discriminatedUnion('kind', [
  z.object({ ...observed, kind: z.literal('run_process_lost'), task, pid: z.number().int().positive(), startTime: id.nullable() }).strict(),
  z.object({ ...observed, kind: z.literal('pr_changed'), ...repositoryGoal, url: z.string(), state: z.enum(['MERGED', 'CLOSED']) }).strict(),
  z.object({ ...observed, kind: z.literal('pr_conflicting'), ...repositoryGoal, url: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('pr_mismatch'), ...repositoryGoal, url: z.string(), reason: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('run_launch_stalled'), repositoryDirectory: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('watch_failed'), reason: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('director_state_changed'), managerConversationId: id, repositoryDirectory: z.string(), goalId: id.nullable(), state: z.string() }).strict(),
]);
const event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inquiry_answered'), ...repositoryGoal, goalId: id, questionId: id, answer: GoalAnswerSchema }).strict(),
  z.object({ kind: z.literal('human_command'), command: ConversationCommandSchema.refine((command) => command.kind !== 'abort_turn' && command.kind !== 'answer_question'),
    speaker: ConversationActorSchema, agentOverrides: ConversationAgentOverridesSchema.optional() }).strict(),
  z.object({ kind: z.literal('inquiry_answer'), command: ConversationCommandSchema.refine((command) => command.kind === 'answer_question') }).strict(),
  z.object({ kind: z.enum(['task_completed', 'task_failed']), task, result: GoalTaskResultSchema }).strict(),
  z.object({ kind: z.literal('director_message'), directorConversationId: id, text: z.string() }).strict(),
  z.object({ kind: z.literal('goal_pr_failed'), ...repositoryGoal, expectedSha: z.string(), reason: z.string() }).strict(),
  z.object({ kind: z.enum(['goal_registered', 'goal_resumed']), repositoryDirectory: z.string(), goalId: id }).strict(),
  z.object({ kind: z.literal('watch_observation'), observation }).strict(),
  z.object({ kind: z.literal('patrol'), repositoryDirectory: z.string().min(1), goalIds: z.array(z.uuid()).min(1) }).strict(),
]);
export const EventInputSchema = z.object({
  eventId: id, requestId: id, conversationId: id, source: z.enum(['tui', 'slack', 'run', 'director', 'watcher', 'daemon']),
  occurredAt: z.iso.datetime(), event,
}).strict() satisfies z.ZodType<EventInput>;
export const AcceptedEventSchema = EventInputSchema.extend({ operationId: id, acceptedSequence: sequence, lane: z.enum(['human', 'other']) })
  .strict().refine((value) => (value.lane === 'human') === ['human_command', 'inquiry_answer'].includes(value.event.kind)) as z.ZodType<AcceptedEvent>;
const retiredAcceptedEvent = EventInputSchema.omit({ event: true }).extend({
  operationId: id, acceptedSequence: sequence, lane: z.literal('other'),
  event: retiredWatchEvent.shape.event.extend({ observation: retiredWatchEvent.shape.event.shape.observation.extend(observed).passthrough() }).strict(),
}).strict();
const legacyStandaloneAnswerEvent = z.union([
  z.object({ kind: z.literal('workspace_inquiry_answered'), questionId: id, answer: GoalAnswerSchema }).strict(),
  z.object({ kind: z.literal('inquiry_answered'), ...repositoryGoal, goalId: z.null(), questionId: id, answer: GoalAnswerSchema }).strict(),
]);
const legacyStandaloneAnswer = z.object({
  eventId: id, requestId: id, conversationId: id,
  source: z.enum(['tui', 'slack', 'run', 'director', 'watcher', 'daemon']), occurredAt: z.iso.datetime(),
  event: legacyStandaloneAnswerEvent, operationId: id, acceptedSequence: sequence, lane: z.literal('other'),
}).strict().transform(({ eventId, requestId, conversationId: target, source, occurredAt, event: saved, operationId, acceptedSequence }) => ({
  eventId, requestId, conversationId: target, source, occurredAt, operationId, acceptedSequence, lane: 'other' as const,
  event: { kind: 'director_message' as const, directorConversationId: conversationId({ kind: 'daemon' }),
    text: `A person answered a standalone inquiry. ${JSON.stringify({ questionId: saved.questionId, answer: saved.answer })}` },
}));
// 旧イベントは不透明な保存値として扱い、索引と結果の確定にだけ渡す。新規受付・ターン実行には使わない。
const storedAcceptedEvent = z.union([AcceptedEventSchema, legacyStandaloneAnswer, retiredAcceptedEvent]) as z.ZodType<AcceptedEvent>;
// 保存済みの許可回答だけを正規化し、新しいコマンドの受付スキーマには許可文を戻さない。
const storedAnswer = z.object({
  kind: z.literal('inquiry_answer'),
  command: z.object({ kind: z.literal('answer_question'), permission: z.unknown().optional() }).passthrough(),
}).passthrough().transform(({ command: { permission: _legacyPermission, ...answer }, ...event }) => ({ ...event, command: answer }));
const storedEvent = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || !('event' in input)) return input;
  const answer = storedAnswer.safeParse(input.event);
  return answer.success ? { ...input, event: answer.data } : input;
}, storedAcceptedEvent);
export const StoredTurnSchema = z.object({ conversationId: id, operationId: id, generation: sequence }).strict() satisfies z.ZodType<TurnIdentity>;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(MAX_PROCESS_MESSAGE_BYTES);
export const ConversationChangeSchema = z.object({
  operationId: id, expectedVersion: version,
  session: z.object({ provider: id, model: text.nullable(), sessionId: text.nullable(), agentOverrides: ConversationAgentOverridesSchema.optional() }).strict().optional(),
  proposal: z.object({ revision: version, pending: PendingSummarySchema.nullable() }).strict().optional(),
  approval: ApprovalSchema.nullable().optional(),
  interruptedMessage: text.nullable().optional(),
}).strict().refine((value) => value.session !== undefined || value.proposal !== undefined || value.approval !== undefined
  || value.interruptedMessage !== undefined) satisfies z.ZodType<ConversationChange>;
const operationResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message: text }).strict(),
  z.object({ kind: z.literal('notice'), message: text }).strict(),
  z.object({ kind: z.literal('goal_registered'), goal: GoalSchema }).strict(),
  z.object({ kind: z.literal('answer_saved'), answerSaved: z.boolean(), message: text }).strict(),
  z.object({ kind: z.literal('error'), code: id, message: text, answerSaved: z.boolean().optional(), permissionAppended: z.boolean().optional() }).strict()
    .transform(({ permissionAppended: _legacyPermission, ...result }) => result),
]);
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deferred') }).strict(),
  z.object({ kind: z.literal('completed'), result: operationResult, change: ConversationChangeSchema.optional() }).strict(),
  z.object({ kind: z.literal('failed'), message: text, change: ConversationChangeSchema.optional() }).strict(),
  z.object({ kind: z.literal('interrupted'), change: ConversationChangeSchema.optional() }).strict(),
]);
export const StoredResultSchema: z.ZodType<TurnResult> = z.object({ ...StoredTurnSchema.shape, event: storedEvent, outcome }).strict();
export const EventRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('queued'), event: storedEvent }).strict(),
  z.object({ state: z.literal('running'), event: storedEvent, turn: StoredTurnSchema }).strict(),
  z.object({ state: z.enum(['settling', 'settled']), event: storedEvent, result: StoredResultSchema }).strict(),
]);
export type EventRecord = z.infer<typeof EventRecordSchema>;
