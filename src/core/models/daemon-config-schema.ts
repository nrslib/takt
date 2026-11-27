import { z } from 'zod/v4';

const reference = z.string().regex(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, 'Credentials require an environment variable reference');
export const RemoteCredentialsConfigSchema = z.object({
  git: reference.optional(), gh: reference.optional(),
  providers: z.object({ anthropic: reference.optional(), openai: reference.optional(), gemini: reference.optional(),
    google: reference.optional(), groq: reference.optional(), openrouter: reference.optional(),
    copilot: reference.optional(), kiro: reference.optional(), opencode: reference.optional(), cursor: reference.optional() }).strict().optional(),
}).strict();
export type RemoteCredentialsConfig = z.infer<typeof RemoteCredentialsConfigSchema>;

export const DaemonConfigSchema = z.object({
  builtin_worker: z.object({ concurrency: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional(),
  remote_worker: z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65535),
    credentials: RemoteCredentialsConfigSchema.optional() }).strict().optional(),
}).strict();
