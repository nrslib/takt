import { z } from 'zod/v4';
import { ApprovalSchema, ConversationActorSchema, ConversationAgentOverridesSchema, PendingSummarySchema } from '../conversations/schema.js';
import { GoalAnswerSchema, GoalSchema, GoalTaskResultSchema } from '../goals/schema.js';
import { ConversationCommandSchema } from '../../features/manager/conversationCommands.js';
import { MAX_PROCESS_MESSAGE_BYTES } from '../../core/daemon/processProtocol.js';
import type { AcceptedEvent, EventInput } from '../../core/daemon/events.js';
import type { ConversationChange, TurnIdentity, TurnResult } from '../../core/daemon/messages.js';

const id = z.string().min(1).max(128);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const task = z.object({ repositoryDirectory: z.string(), goalId: id, taskName: z.string(), runSlug: id.optional(), executionId: id.optional() }).strict();
const observed = { targetId: id, generation: id, observedAt: z.iso.datetime() };
const repositoryGoal = { repositoryDirectory: z.string(), goalId: id };
const observation = z.discriminatedUnion('kind', [
  z.object({ ...observed, kind: z.literal('run_process_lost'), task, pid: z.number().int().positive(), startTime: id.nullable() }).strict(),
  z.object({ ...observed, kind: z.literal('run_log_stalled'), task, lastUpdatedAt: z.iso.datetime() }).strict(),
  z.object({ ...observed, kind: z.literal('run_too_long'), task, startedAt: z.iso.datetime() }).strict(),
  z.object({ ...observed, kind: z.literal('run_step_repeated'), task, workflow: z.string().min(1), step: z.string().min(1), stepIdentity: z.string().min(1), count: z.number().int().positive() }).strict(),
  z.object({ ...observed, kind: z.literal('pr_changed'), ...repositoryGoal, url: z.string(), state: z.enum(['MERGED', 'CLOSED']) }).strict(),
  z.object({ ...observed, kind: z.literal('goal_pr_retry'), ...repositoryGoal, reason: z.string(),
    failureId: id, expectedSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), attempt: z.number().int().positive(), maxAttempts: z.number().int().positive(),
  }).strict(),
  z.object({ ...observed, kind: z.literal('pr_mismatch'), ...repositoryGoal, url: z.string(), reason: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('inquiry_stalled'), repositoryDirectory: z.string(), questionId: id, goalId: id.nullable() }).strict(),
  z.object({ ...observed, kind: z.literal('goal_stalled'), ...repositoryGoal, lastUpdatedAt: z.iso.datetime() }).strict(),
  z.object({ ...observed, kind: z.literal('run_launch_stalled'), repositoryDirectory: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('watch_failed'), reason: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('director_state_changed'), managerConversationId: id, repositoryDirectory: z.string(), goalId: id.nullable(), state: z.string() }).strict(),
]);
const event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inquiry_answered'), ...repositoryGoal, questionId: id, answer: GoalAnswerSchema }).strict(),
  z.object({ kind: z.literal('human_command'), command: ConversationCommandSchema.refine((command) => command.kind !== 'abort_turn' && command.kind !== 'answer_question'),
    speaker: ConversationActorSchema, agentOverrides: ConversationAgentOverridesSchema.optional() }).strict(),
  z.object({ kind: z.literal('inquiry_answer'), command: ConversationCommandSchema.refine((command) => command.kind === 'answer_question') }).strict(),
  z.object({ kind: z.enum(['task_completed', 'task_failed']), task, result: GoalTaskResultSchema }).strict(),
  z.object({ kind: z.literal('director_message'), directorConversationId: id, text: z.string() }).strict(),
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
// 保存済みの許可回答だけを正規化し、新しいコマンドの受付スキーマには許可文を戻さない。
const storedAnswer = z.object({
  kind: z.literal('inquiry_answer'),
  command: z.object({ kind: z.literal('answer_question'), permission: z.unknown().optional() }).passthrough(),
}).passthrough().transform(({ command: { permission: _legacyPermission, ...answer }, ...event }) => ({ ...event, command: answer }));
const storedEvent = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || !('event' in input)) return input;
  const answer = storedAnswer.safeParse(input.event);
  return answer.success ? { ...input, event: answer.data } : input;
}, AcceptedEventSchema);
export const StoredTurnSchema = z.object({ conversationId: id, operationId: id, generation: sequence }).strict() satisfies z.ZodType<TurnIdentity>;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(MAX_PROCESS_MESSAGE_BYTES);
export const ConversationChangeSchema = z.object({
  operationId: id, expectedVersion: version,
  session: z.object({ provider: id, model: text.nullable(), sessionId: text.nullable(), agentOverrides: ConversationAgentOverridesSchema.optional() }).strict().optional(),
  proposal: z.object({ revision: version, pending: PendingSummarySchema.nullable() }).strict().optional(),
  approval: ApprovalSchema.nullable().optional(),
}).strict().refine((value) => value.session !== undefined || value.proposal !== undefined || value.approval !== undefined) satisfies z.ZodType<ConversationChange>;
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
