import { z } from 'zod/v4';

const StartResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started') }).strict(),
  z.object({ kind: z.literal('declined') }).strict(),
  z.object({ kind: z.literal('claim_retry'), retryAt: z.number().finite() }).strict(),
  z.object({ kind: z.literal('preparation_failed'), message: z.string() }).strict(),
]);

export const ProjectRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inspect'), id: z.string() }).strict(),
  z.object({ kind: z.literal('waiting'), id: z.string(), reasons: z.array(z.object({
    taskName: z.string().min(1), reason: z.string().optional(),
  }).strict()) }).strict(),
  z.object({ kind: z.literal('start'), id: z.string(), taskName: z.string().min(1), workerName: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('shutdown'), id: z.string() }).strict(),
]);

export const ProjectReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), id: z.string(), work: z.object({
    concurrency: z.number().int().positive(), available: z.boolean(),
    tasks: z.array(z.object({ taskName: z.string(), mergeTask: z.boolean() }).strict()),
  }).strict() }).strict(),
  z.object({ kind: z.literal('started'), id: z.string(), result: StartResultSchema }).strict(),
  z.object({ kind: z.literal('updated'), id: z.string() }).strict(),
  z.object({ kind: z.literal('claim_retry'), id: z.string(), retryAt: z.number().finite() }).strict(),
  z.object({ kind: z.literal('error'), id: z.string(), message: z.string() }).strict(),
  z.object({ kind: z.literal('finished'), taskName: z.string() }).strict(),
]);

export type ProjectRequest = z.infer<typeof ProjectRequestSchema>;
export type ProjectReply = z.infer<typeof ProjectReplySchema>;
