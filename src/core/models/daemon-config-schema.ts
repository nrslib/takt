import { z } from 'zod/v4';

export const DaemonConfigSchema = z.object({
  builtin_worker: z.object({ concurrency: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional(),
  remote_worker: z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65535) }).strict().optional(),
}).strict();
