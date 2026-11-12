import { z } from 'zod/v4';

export const DaemonConfigSchema = z.object({
  builtin_worker: z.object({ concurrency: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional(),
}).strict();
