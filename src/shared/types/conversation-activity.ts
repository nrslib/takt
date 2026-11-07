import { z } from 'zod/v4';

export const ConversationActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }).strict(),
  z.object({ kind: z.literal('thinking') }).strict(),
  z.object({ kind: z.literal('responding') }).strict(),
  z.object({ kind: z.literal('tool'), tool: z.string().min(1).max(128).regex(/^[\w.:/-]+$/) }).strict(),
]);

export type ConversationActivity = z.infer<typeof ConversationActivitySchema>;
export type ConversationProgress = string | ConversationActivity;
