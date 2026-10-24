import { z } from 'zod/v4';
import { ConversationCommandSchema } from '../manager/conversationCommands.js';
import { ConversationActorSchema, ConversationAssignmentSchema, ConversationIdSchema, PortBindingSchema } from '../../infra/conversations/schema.js';

const id = z.uuid();
const common = { protocolVersion: z.literal(1), type: z.literal('request'), requestId: z.string().min(1).max(128) };
export const ConversationRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...common, method: z.literal('hello'), params: z.object({ capability: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
  z.object({ ...common, method: z.literal('open'), params: z.object({ conversationId: ConversationIdSchema,
    assignment: ConversationAssignmentSchema, binding: PortBindingSchema, speaker: ConversationActorSchema }).strict() }).strict(),
  z.object({ ...common, method: z.literal('submit'), params: z.object({ attachmentId: id,
    speaker: ConversationActorSchema, command: ConversationCommandSchema }).strict() }).strict(),
  ...(['snapshot', 'detach'] as const).map((method) => z.object({ ...common, method: z.literal(method),
    params: z.object({ attachmentId: id }).strict() }).strict()),
]);
