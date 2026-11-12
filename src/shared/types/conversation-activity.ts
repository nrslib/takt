import { z } from 'zod/v4';

export const MAX_TOOL_DESCRIPTION_LENGTH = 256;
export const MAX_CONVERSATION_TEXT_BYTES = 16 * 1024;
const description = z.string().min(1).max(MAX_TOOL_DESCRIPTION_LENGTH)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\u2028\u2029]/u.test(value));

export const ConversationActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }).strict(),
  z.object({ kind: z.literal('thinking') }).strict(),
  z.object({ kind: z.literal('responding') }).strict(),
  z.object({ kind: z.literal('tool'), tool: z.string().min(1).max(128).regex(/^[\w.:/-]+$/), description: description.optional() })
    .strict().refine((value) => value.description === undefined || value.tool === 'Bash'),
]);

export const ConversationTextSchema = z.object({ kind: z.literal('turn_text'),
  message: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CONVERSATION_TEXT_BYTES),
}).strict();
export type ConversationText = z.infer<typeof ConversationTextSchema>;
export type ConversationActivity = z.infer<typeof ConversationActivitySchema>;
export type ConversationProgress = string | ConversationActivity | ConversationText;
