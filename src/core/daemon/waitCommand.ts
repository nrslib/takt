import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';

export const DEFAULT_WAIT_COMMAND_TIMEOUT_SECONDS = 60 * 60;
export const MAX_WAIT_COMMAND_TIMEOUT_SECONDS = 24 * 60 * 60;
export const MAX_WAIT_COMMAND_OUTPUT_BYTES = 16 * 1024;

export const WaitCommandInputSchema = z.object({
  command: z.string().max(16 * 1024).refine((value) => value.trim().length > 0 && !/[\r\n\0]/u.test(value)),
  description: z.string().trim().min(1).max(4096),
  cwd: z.string().min(1).refine(isAbsolute, 'cwd must be an absolute path'),
  goalId: z.uuid().optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_COMMAND_TIMEOUT_SECONDS).default(DEFAULT_WAIT_COMMAND_TIMEOUT_SECONDS),
}).strict();
export type WaitCommandInput = z.output<typeof WaitCommandInputSchema>;

export const WaitCommandCompletedSchema = z.object({
  kind: z.literal('wait_command_completed'),
  id: z.uuid(),
  repositoryDirectory: z.string().min(1),
  goalId: z.uuid().optional(),
  description: WaitCommandInputSchema.shape.description,
  status: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outputTail: z.string().refine((value) => Buffer.byteLength(value) <= MAX_WAIT_COMMAND_OUTPUT_BYTES),
  durationMs: z.number().nonnegative(),
}).strict();
export type WaitCommandCompleted = z.infer<typeof WaitCommandCompletedSchema>;
