import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { GoalSummarySchema } from '../goals/schema.js';
import { conversationId } from './identity.js';

const nonempty = z.string().min(1);
const repository = nonempty.refine(isAbsolute);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ConversationIdSchema = z.string().regex(/^manager-[a-f0-9]{64}$/);
export const ConversationAssignmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository'), repositoryDirectory: repository }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: z.uuid() }).strict(),
]);
export const ConversationActorSchema = z.object({ namespace: nonempty, id: nonempty }).strict();
export const PortBindingSchema = z.object({
  port: nonempty, key: nonempty, counterpart: ConversationActorSchema,
}).strict();
export const PendingSummarySchema = z.object({
  revision: revision.refine((value) => value > 0),
  repositoryDirectory: repository, summary: GoalSummarySchema,
}).strict();
export const ApprovalSchema = z.object({
  revision: revision.refine((value) => value > 0), goalId: z.uuid(),
  repositoryDirectory: repository, state: z.enum(['reserved', 'registered']),
}).strict();
export const RunningOperationSchema = z.object({
  operationId: z.uuid(),
  kind: z.enum(['message', 'approve_summary', 'dismiss_summary', 'answer_question', 'pause_goal', 'resume_goal', 'abort_goal']),
  owner: z.object({
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    identity: z.object({ startTime: nonempty }).strict(),
  }).strict(),
}).strict();
export const ConversationRecordSchema = z.object({
  schemaVersion: z.literal(1), id: ConversationIdSchema, agent: nonempty,
  assignment: ConversationAssignmentSchema,
  counterpart: ConversationActorSchema, lastSpeaker: ConversationActorSchema.nullable(),
  provider: nonempty, model: z.string().nullable(), sessionId: nonempty.nullable(),
  bindings: z.array(PortBindingSchema), revision,
  pending: PendingSummarySchema.nullable(), approval: ApprovalSchema.nullable(),
  running: RunningOperationSchema.nullable(),
}).strict().superRefine((record, ctx) => {
  const issue = (path: string, message: string): void => { ctx.addIssue({ code: 'custom', path: [path], message }); };
  if (record.id !== conversationId(record.assignment)) issue('id', 'Conversation identity does not match assignment');
  if (record.pending !== null && record.pending.revision !== record.revision) issue('pending', 'Pending revision does not match conversation');
  if (record.assignment.kind === 'repository') {
    for (const field of ['pending', 'approval'] as const) {
      const value = record[field];
      if (value !== null && value.repositoryDirectory !== record.assignment.repositoryDirectory) issue(field, 'Repository does not match assignment');
    }
  }
  if (record.approval !== null) {
    if (record.approval.state === 'reserved') {
      if (record.pending === null || record.approval.revision !== record.pending.revision
        || record.approval.repositoryDirectory !== record.pending.repositoryDirectory) issue('approval', 'Reservation requires its original pending proposal');
    } else if (record.approval.revision >= record.revision) issue('approval', 'Registered receipt must precede current revision');
  }
});

export type ConversationAssignment = z.infer<typeof ConversationAssignmentSchema>;
export type ConversationActor = z.infer<typeof ConversationActorSchema>;
export type PortBinding = z.infer<typeof PortBindingSchema>;
export type PendingSummary = z.infer<typeof PendingSummarySchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
