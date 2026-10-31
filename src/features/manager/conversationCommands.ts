import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { ManagerConversationAssignmentSchema } from '../../infra/conversations/schema.js';

const id = z.uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const permission = z.object({
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project'), projectDirectory: z.string().refine(isAbsolute) }).strict(),
    z.object({ kind: z.literal('workspace'), workspaceId: id }).strict(),
    z.object({ kind: z.literal('global') }).strict(),
  ]), sentence: z.string().min(1),
}).strict();
export const ConversationCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string().min(1), display: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('approve_summary'), revision, requirePending: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('dismiss_summary'), revision }).strict(),
  z.object({ kind: z.literal('answer_question'), questionId: id,
    target: z.union([
      z.object({ goalId: id, repositoryDirectory: z.string().refine(isAbsolute) }).strict(),
      z.object({ goalId: z.null(), owner: ManagerConversationAssignmentSchema }).strict(),
    ]),
    answer: z.object({ text: z.string().max(128 * 1024).optional(), decision: z.enum(['allow', 'deny']).optional(),
      report: z.enum(['completed', 'unable']).optional(), scope: z.enum(['once', 'goal', 'project', 'workspace', 'global']).optional() }).strict(),
    permission: permission.optional(),
    source: z.enum(['tui', 'slack']).optional(),
  }).strict(),
  ...(['pause_goal', 'resume_goal', 'abort_goal'] as const).map((kind) => z.object({ kind: z.literal(kind), goalId: id }).strict()),
  z.object({ kind: z.literal('abort_turn'), operationId: id }).strict(),
]);
