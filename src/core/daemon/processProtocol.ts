import { WaitCommandCompletedSchema, WaitCommandInputSchema } from './waitCommand.js';
import { EpicEventSchema, PatrolEventSchema } from './epicEvent.js';
import { z } from 'zod/v4';
import { ConversationActivitySchema, ConversationToolEventSchema, MAX_CONVERSATION_TEXT_BYTES as MAX_PROCESS_PROGRESS_BYTES } from '../../shared/types/conversation-activity.js';
import { ConversationCommandSchema } from '../../features/manager/conversationCommands.js';
import { ApprovalSchema, DirectorMessageOriginSchema, ConversationActorSchema, ConversationAgentOverridesSchema, ConversationAssignmentSchema, PendingSummarySchema } from '../../infra/conversations/schema.js';
import { GoalAnswerSchema, GoalExecutionOriginSchema, GoalSchema, GoalTaskResultSchema } from '../../infra/goals/schema.js';
import type { AcceptedEvent, WatchObservation, HumanCommand, TurnEvent } from './events.js';
import type { ConversationChange, ConversationTurnState, TurnIdentity, TurnOutcome, TurnStart } from './messages.js';

export const TURN_PROTOCOL_VERSION = 1;
export { MAX_PROCESS_PROGRESS_BYTES };

const id = z.string().min(1).max(128);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string();
const TurnIdentitySchema = z.object({ conversationId: id, operationId: id, generation: version.refine((v) => v > 0) }).strict() satisfies z.ZodType<TurnIdentity>;
const session = z.object({ provider: id, model: text.nullable(), sessionId: text.nullable(), contextKey: id.optional(), agentOverrides: ConversationAgentOverridesSchema.optional() }).strict();
const state = z.object({ version, assignment: ConversationAssignmentSchema, session,
  revision: version, pending: PendingSummarySchema.nullable(), approval: ApprovalSchema.nullable(),
  interruptedMessage: text.nullable().optional(),
}).strict() satisfies z.ZodType<ConversationTurnState>;
const change = z.object({ operationId: id, expectedVersion: version, session: session.optional(),
  proposal: z.object({ revision: version, pending: PendingSummarySchema.nullable() }).strict().optional(),
  approval: ApprovalSchema.nullable().optional(),
  interruptedMessage: text.nullable().optional(),
}).strict().refine((value) => value.session !== undefined || value.proposal !== undefined || value.approval !== undefined
  || value.interruptedMessage !== undefined) satisfies z.ZodType<ConversationChange>;
const task = z.object({ repositoryDirectory: text, goalId: id, taskName: text, runSlug: id.optional(), executionId: id.optional() }).strict();
const observed = { targetId: id, generation: id, observedAt: z.iso.datetime() };
const repositoryGoal = { repositoryDirectory: text, goalId: id };
const observation = z.discriminatedUnion('kind', [
  z.object({ ...observed, kind: z.literal('run_process_lost'), task, pid: z.number().int().positive(), startTime: id.nullable() }).strict(),
  z.object({ ...observed, kind: z.literal('pr_changed'), ...repositoryGoal, url: text, state: z.enum(['MERGED', 'CLOSED']) }).strict(),
  z.object({ ...observed, kind: z.literal('pr_conflicting'), ...repositoryGoal, url: text }).strict(),
  z.object({ ...observed, kind: z.literal('pr_mismatch'), ...repositoryGoal, url: text, reason: text }).strict(),
  z.object({ ...observed, kind: z.literal('run_launch_stalled'), repositoryDirectory: text }).strict(),
  z.object({ ...observed, kind: z.literal('watch_failed'), reason: text }).strict(),
  z.object({ ...observed, kind: z.literal('director_state_changed'), managerConversationId: id, repositoryDirectory: text, goalId: id.nullable(), state: text }).strict(),
]) satisfies z.ZodType<WatchObservation>;
const humanCommand = z.custom<HumanCommand>((value) => {
  const parsed = ConversationCommandSchema.safeParse(value);
  return parsed.success && parsed.data.kind !== 'abort_turn' && parsed.data.kind !== 'answer_question';
});
const answerCommand = z.custom<Extract<TurnEvent, { kind: 'inquiry_answer' }>['command']>((value) => {
  const parsed = ConversationCommandSchema.safeParse(value);
  return parsed.success && parsed.data.kind === 'answer_question';
});
const event = z.discriminatedUnion('kind', [
  EpicEventSchema,
  WaitCommandCompletedSchema,
  z.object({ kind: z.literal('inquiry_answered'), ...repositoryGoal, goalId: id, questionId: id, answer: GoalAnswerSchema }).strict(),
  z.object({ kind: z.literal('human_command'), command: humanCommand, speaker: ConversationActorSchema,
    agentOverrides: ConversationAgentOverridesSchema.optional() }).strict(),
  z.object({ kind: z.literal('inquiry_answer'), command: answerCommand }).strict(),
  z.object({ kind: z.enum(['task_completed', 'task_failed']), task, result: GoalTaskResultSchema }).strict(),
  z.object({ kind: z.literal('director_message'), directorConversationId: id, text, origin: DirectorMessageOriginSchema.optional(), inquiryAnswer: z.object({ questionId: id, question: text.optional(), answer: GoalAnswerSchema }).strict().optional() }).strict(),
  z.object({ kind: z.literal('goal_pr_failed'), ...repositoryGoal, expectedSha: z.string(), reason: z.string() }).strict(),
  z.object({ kind: z.literal('goal_registered'), ...repositoryGoal }).strict(),
  z.object({ kind: z.literal('goal_resumed'), ...repositoryGoal, origin: GoalExecutionOriginSchema.optional() }).strict(),
  z.object({ kind: z.literal('watch_observation'), observation }).strict(),
  PatrolEventSchema,
]);
const acceptedEvent = z.object({ eventId: id, requestId: id, conversationId: id,
  source: z.enum(['tui', 'slack', 'run', 'director', 'watcher', 'daemon']), occurredAt: z.iso.datetime(), event,
  operationId: id, acceptedSequence: version.refine((v) => v > 0), lane: z.enum(['human', 'other']),
}).strict().refine((value) => (value.lane === 'human') === ['human_command', 'inquiry_answer'].includes(value.event.kind)) satisfies z.ZodType<AcceptedEvent>;
const operationResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), message: text }).strict(),
  z.object({ kind: z.literal('notice'), message: text }).strict(),
  z.object({ kind: z.literal('goal_registered'), goal: GoalSchema }).strict(),
  z.object({ kind: z.literal('answer_saved'), answerSaved: z.boolean(), message: text }).strict(),
  z.object({ kind: z.literal('error'), code: id, message: text, answerSaved: z.boolean().optional() }).strict(),
]);
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deferred') }).strict(),
  z.object({ kind: z.literal('completed'), result: operationResult, change: change.optional() }).strict(),
  z.object({ kind: z.literal('failed'), message: text, change: change.optional() }).strict(),
  z.object({ kind: z.literal('interrupted'), message: text.optional(), change: change.optional() }).strict(),
]) satisfies z.ZodType<TurnOutcome>;
const start = z.object({ event: acceptedEvent, turn: TurnIdentitySchema, state }).strict().refine((value) =>
  value.event.conversationId === value.turn.conversationId && value.event.operationId === value.turn.operationId) satisfies z.ZodType<TurnStart>;

const stateRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_director_manager'), repositoryDirectory: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('fire_director_manager'), managerId: z.string().regex(/^manager-[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('publish_epic_events'), workspaceId: z.uuid(), epicId: z.uuid(), reason: z.string().trim().min(1) }).strict(),
  WaitCommandInputSchema.extend({ kind: z.literal('wait_command') }).strict(),
  z.object({ kind: z.literal('publish_workspace_inquiry_answer'), questionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('save_conversation'), change }).strict(),
  z.object({ kind: z.literal('accept_director_message'), eventId: id, requestId: id, conversationId: id, occurredAt: z.iso.datetime(), text, origin: DirectorMessageOriginSchema }).strict(),
  z.object({ kind: z.literal('notify_director'), notificationId: id, message: text,
    subject: z.object({ key: id, state: text }).strict().optional() }).strict(),
  z.object({ kind: z.literal('get_delivery'), conversationId: id }).strict(),
]);
const admission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), eventId: id, operationId: id, acceptedSequence: version.refine((v) => v > 0), queuedMessageCount: version.refine((v) => v > 0).optional() }).strict(),
  z.object({ kind: z.literal('rejected'), reason: z.enum(['capacity', 'storage', 'stopping']) }).strict(),
]);
const stateReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['director_manager_added', 'director_manager_fired']), managerId: z.string().regex(/^manager-[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('epic_events_published') }).strict(),
  z.object({ kind: z.literal('wait_command_registered'), id: z.uuid() }).strict(),
  z.object({ kind: z.literal('state_saved'), version, duplicate: z.boolean() }).strict(),
  z.object({ kind: z.literal('event_accepted'), admission }).strict(),
  z.object({ kind: z.literal('notification_saved'), notificationId: id }).strict(),
  z.object({ kind: z.literal('delivery'), conversationId: id, assignment: ConversationAssignmentSchema,
    connectedPorts: z.array(id) }).strict(),
  z.object({ kind: z.literal('error'), code: z.enum(['stale_turn', 'version_conflict', 'forbidden', 'capacity', 'storage', 'stopping']), message: text }).strict(),
]);
export type DaemonStateRequest = z.infer<typeof stateRequest>;
export type DaemonStateReply = z.infer<typeof stateReply>;
const common = { protocolVersion: z.literal(TURN_PROTOCOL_VERSION), launchId: id };
const daemonMessage = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('initialize'), conversationId: id, assignment: ConversationAssignmentSchema, configDirectory: text }).strict(),
  z.object({ ...common, kind: z.literal('start_turn'), input: start }).strict(),
  z.object({ ...common, kind: z.literal('result_committed'), turn: TurnIdentitySchema }).strict(),
  z.object({ ...common, kind: z.literal('interrupt'), turn: TurnIdentitySchema }).strict(),
  z.object({ ...common, kind: z.literal('shutdown') }).strict(),
  z.object({ ...common, kind: z.literal('daemon_reply'), turn: TurnIdentitySchema, requestId: id, reply: stateReply }).strict(),
]);
const childMessage = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('ready') }).strict(),
  z.object({ ...common, kind: z.literal('turn_progress'), turn: TurnIdentitySchema,
    message: z.union([z.string(), ConversationActivitySchema, z.object({ kind: z.literal('turn_text'), message: z.string() }).strict(),
      ConversationToolEventSchema]) }).strict(),
  z.object({ ...common, kind: z.literal('turn_finished'), turn: TurnIdentitySchema, outcome }).strict(),
  z.object({ ...common, kind: z.literal('shutdown_complete') }).strict(),
  z.object({ ...common, kind: z.literal('daemon_request'), turn: TurnIdentitySchema, requestId: id, request: stateRequest }).strict(),
  z.object({ ...common, kind: z.literal('cancel_daemon_request'), turn: TurnIdentitySchema, requestId: id }).strict(),
]);
export type DaemonProcessMessage = z.infer<typeof daemonMessage>;
export type TurnProcessMessage = z.infer<typeof childMessage>;

/** Node IPC の送受信双方で使う。JSON で失われる関数・signal などの値と、走査が終わらない循環参照を拒否する。 */
function assertJsonData(value: unknown): void {
  const ancestors = new Set<object>();
  const work: Array<{ value: unknown; exit: boolean }> = [{ value, exit: false }];
  while (work.length > 0) {
    const item = work.pop()!;
    const current = item.value;
    if (item.exit) { ancestors.delete(current as object); continue; }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number' && Number.isFinite(current)) continue;
    if (typeof current !== 'object' || !Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype) {
      throw new Error('Process message must contain JSON data');
    }
    if (ancestors.has(current)) throw new Error('Process message must not contain cycles');
    ancestors.add(current);
    work.push({ value: current, exit: true });
    for (const child of Object.values(current)) work.push({ value: child, exit: false });
  }
}

export function parseDaemonProcessMessage(value: unknown, launchId: string): DaemonProcessMessage {
  assertJsonData(value);
  const message = daemonMessage.parse(value);
  if (message.launchId !== launchId) throw new Error('Stale process launch');
  return message;
}

export function parseTurnProcessMessage(value: unknown, launchId: string): TurnProcessMessage {
  assertJsonData(value);
  const message = childMessage.parse(value);
  if (message.launchId !== launchId) throw new Error('Stale process launch');
  return message;
}
