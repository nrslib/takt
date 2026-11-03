import { z } from 'zod/v4';
import { ApprovalSchema, ConversationActorSchema, ConversationAgentOverridesSchema, PendingSummarySchema } from '../conversations/schema.js';
import { GoalSchema, GoalTaskResultSchema } from '../goals/schema.js';
import { ConversationCommandSchema } from '../../features/manager/conversationCommands.js';
import { MAX_PROCESS_MESSAGE_BYTES } from '../../core/daemon/processProtocol.js';
import type { AcceptedEvent } from '../../core/daemon/events.js';
import type { ConversationChange, TurnIdentity, TurnResult } from '../../core/daemon/messages.js';

const id = z.string().min(1).max(128);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const task = z.object({ repositoryDirectory: z.string(), goalId: id, taskName: z.string(), runSlug: id, executionId: id.optional() }).strict();
const observed = { targetId: id, generation: id, observedAt: z.iso.datetime() };
const repositoryGoal = { repositoryDirectory: z.string(), goalId: id };
const observation = z.discriminatedUnion('kind', [
  z.object({ ...observed, kind: z.literal('run_process_lost'), task, pid: z.number().int().positive(), startTime: id }).strict(),
  z.object({ ...observed, kind: z.literal('run_log_stalled'), task, lastUpdatedAt: z.iso.datetime() }).strict(),
  z.object({ ...observed, kind: z.literal('pr_changed'), ...repositoryGoal, url: z.string(), state: z.enum(['MERGED', 'CLOSED']) }).strict(),
  z.object({ ...observed, kind: z.literal('pr_mismatch'), ...repositoryGoal, url: z.string(), reason: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('inquiry_stalled'), repositoryDirectory: z.string(), questionId: id, goalId: id.nullable() }).strict(),
  z.object({ ...observed, kind: z.literal('goal_stalled'), ...repositoryGoal, lastUpdatedAt: z.iso.datetime() }).strict(),
  z.object({ ...observed, kind: z.literal('run_launch_stalled'), repositoryDirectory: z.string() }).strict(),
  z.object({ ...observed, kind: z.literal('watch_failed'), reason: z.string() }).strict(),
]);
const event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human_command'), command: ConversationCommandSchema.refine((command) => command.kind !== 'abort_turn' && command.kind !== 'answer_question'),
    speaker: ConversationActorSchema, agentOverrides: ConversationAgentOverridesSchema.optional() }).strict(),
  z.object({ kind: z.literal('inquiry_answer'), command: ConversationCommandSchema.refine((command) => command.kind === 'answer_question') }).strict(),
  z.object({ kind: z.enum(['task_completed', 'task_failed']), task, result: GoalTaskResultSchema }).strict(),
  z.object({ kind: z.literal('director_message'), directorConversationId: id, text: z.string() }).strict(),
  z.object({ kind: z.enum(['goal_registered', 'goal_resumed']), repositoryDirectory: z.string(), goalId: id }).strict(),
  z.object({ kind: z.literal('watch_observation'), observation }).strict(),
]);
export const AcceptedEventSchema = z.object({
  eventId: id, requestId: id, conversationId: id, source: z.enum(['tui', 'slack', 'run', 'director', 'watcher', 'daemon']),
  occurredAt: z.iso.datetime(), event, operationId: id, acceptedSequence: sequence, lane: z.enum(['human', 'other']),
}).strict().refine((value) => (value.lane === 'human') === ['human_command', 'inquiry_answer'].includes(value.event.kind)) as z.ZodType<AcceptedEvent>;
export const StoredTurnSchema = z.object({ conversationId: id, operationId: id, generation: sequence }).strict() satisfies z.ZodType<TurnIdentity>;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(MAX_PROCESS_MESSAGE_BYTES);
export const ConversationChangeSchema = z.object({
  operationId: id, expectedVersion: version,
  session: z.object({ provider: id, model: text.nullable(), sessionId: text.nullable() }).strict().optional(),
  proposal: z.object({ revision: version, pending: PendingSummarySchema.nullable() }).strict().optional(),
  approval: ApprovalSchema.nullable().optional(),
}).strict().refine((value) => value.session !== undefined || value.proposal !== undefined || value.approval !== undefined) satisfies z.ZodType<ConversationChange>;
const operationResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message: text }).strict(),
  z.object({ kind: z.literal('goal_registered'), goal: GoalSchema }).strict(),
  z.object({ kind: z.literal('answer_saved'), answerSaved: z.boolean(), message: text }).strict(),
  z.object({ kind: z.literal('error'), code: id, message: text, answerSaved: z.boolean().optional(), permissionAppended: z.boolean().optional() }).strict(),
]);
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed'), result: operationResult, change: ConversationChangeSchema.optional() }).strict(),
  z.object({ kind: z.literal('failed'), message: text, change: ConversationChangeSchema.optional() }).strict(),
  z.object({ kind: z.literal('interrupted'), change: ConversationChangeSchema.optional() }).strict(),
]);
export const StoredResultSchema: z.ZodType<TurnResult> = z.object({ ...StoredTurnSchema.shape, event: AcceptedEventSchema, outcome }).strict();
export const EventRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('queued'), event: AcceptedEventSchema }).strict(),
  z.object({ state: z.literal('running'), event: AcceptedEventSchema, turn: StoredTurnSchema }).strict(),
  z.object({ state: z.enum(['settling', 'settled']), event: AcceptedEventSchema, result: StoredResultSchema }).strict(),
]);
export type EventRecord = z.infer<typeof EventRecordSchema>;
