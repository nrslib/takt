import { z } from 'zod/v4';
import { REPORT_INTERNAL_NAMESPACE } from '../models/reserved-report-names.js';

export const REMOTE_CHUNK_BYTES = 64 * 1024;
const REMOTE_INPUT_MAX_BYTES = 64 * 1024 * 1024;

export function isRemoteRunArtifactPath(path: string): boolean {
  if (path === 'interventions.jsonl') return false;
  const parts = path.split('/');
  const contextIndex = parts.indexOf('context');
  if (contextIndex >= 0 && parts.some((part, index) => index > contextIndex
    && part === 'task' && parts[index + 1] === 'attachments')) return true;
  return !parts.some((part, index) => part.endsWith('.lock') || part.startsWith('.workflow-bundle-')
    || part.startsWith('.task-restage-') || part.startsWith('.') && part.endsWith('.tmp')
    || /\.\d+\.[a-f0-9-]{36}\.tmp$/.test(part)
    || part === 'locks' && parts[index - 1] === REPORT_INTERNAL_NAMESPACE);
}
export const RemotePathSchema = z.string().min(1).max(4096).refine((path) =>
  !path.includes('\\') && !path.includes('\0')
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Invalid remote relative path');
export const RemoteRunSlugSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.string().max(4 * Math.ceil(REMOTE_CHUNK_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const RemoteFileSchema = z.object({ path: RemotePathSchema, size: sequence.max(REMOTE_INPUT_MAX_BYTES), sha256: hash }).strict();
export const RemoteInputManifestSchema = z.object({ version: z.literal(1), runSlug: RemoteRunSlugSchema,
  directories: z.array(RemotePathSchema).max(256), files: z.array(RemoteFileSchema).max(256) }).strict().superRefine((manifest, context) => {
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length
    || new Set(manifest.directories).size !== manifest.directories.length
    || manifest.files.some((file) => manifest.directories.includes(file.path))
    || Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 192 * 1024
    || manifest.files.reduce((size, file) => size + file.size, 0) > REMOTE_INPUT_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Duplicate paths or oversized remote input' });
  }
});
export type RemoteInputManifest = z.infer<typeof RemoteInputManifestSchema>;
export const RemoteControlSchema = z.object({ sequence: sequence.min(1),
  kind: z.enum(['tell', 'stop', 'pause', 'abort']), content: z.string().max(128 * 1024).optional(),
  contentChunk: z.object({ offset: sequence, size: sequence.max(512 * 1024), sha256: hash, data: bytes }).strict().optional(),
  instructionId: sequence.min(1).optional(), issuedAt: z.string() }).strict();
export type RemoteControl = z.infer<typeof RemoteControlSchema>;
export const RemoteRecordSchema = z.object({ sequence: sequence.min(1), runSlug: RemoteRunSlugSchema,
  path: RemotePathSchema, offset: sequence, mode: z.enum(['append', 'replace']), final: z.boolean(), data: bytes, sha256: hash }).strict();
export type RemoteRecord = z.infer<typeof RemoteRecordSchema>;
export const RemoteInterventionDeliverySchema = z.object({ instructionIds: z.array(sequence.min(1)).min(1),
  context: z.object({ mode: z.enum(['same_session', 'next_step', 'batch_boundary']), step: z.string().min(1),
    phase: z.union([z.literal(1), z.literal(2), z.literal(3)]), target: z.string().optional(),
    processedBatchCount: sequence.optional(), runningBatchIndexes: z.array(sequence).optional(), appliesToBatchIndexes: z.array(sequence).optional() }).strict(),
}).strict();
export const RemoteExecutionCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('credentials') }).strict(),
  z.object({ kind: z.literal('input-manifest') }).strict(),
  z.object({ kind: z.literal('input-chunk'), path: RemotePathSchema, offset: sequence }).strict(),
  z.object({ kind: z.literal('record'), record: RemoteRecordSchema }).strict(),
  z.object({ kind: z.literal('controls'), acknowledgedSequence: sequence,
    contentSequence: sequence.optional(), contentOffset: sequence.optional() }).strict(),
  RemoteInterventionDeliverySchema.extend({ kind: z.literal('intervention-delivery') }).strict(),
]);
export type RemoteExecutionCommand = z.infer<typeof RemoteExecutionCommandSchema>;
export const RemoteExecutionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('credentials'), environment: z.record(z.string(), z.string().max(8192)), error: z.string().optional() }).strict(),
  z.object({ kind: z.literal('input-manifest'), manifest: RemoteInputManifestSchema }).strict(),
  z.object({ kind: z.literal('input-chunk'), data: bytes }).strict(),
  z.object({ kind: z.literal('record'), acknowledgedSequence: sequence }).strict(),
  z.object({ kind: z.literal('controls'), controls: z.array(RemoteControlSchema).max(16) }).strict(),
  z.object({ kind: z.literal('intervention-delivery') }).strict(),
]);
export type RemoteExecutionResponse = z.infer<typeof RemoteExecutionResponseSchema>;
export const RemoteArtifactsSchema = z.object({ branch: z.string().min(1),
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), runSlug: RemoteRunSlugSchema,
  finalLogSequence: sequence }).strict();
export type RemoteArtifacts = z.infer<typeof RemoteArtifactsSchema>;
export const RemoteExecutionResultFields = {
  interrupted: z.boolean().optional(), retryable: z.boolean().optional(),
  workflowResult: z.enum(['completed', 'aborted', 'exceeded', 'error']).optional(),
  prUrl: z.string().optional(), prFailed: z.boolean().optional(), prError: z.string().optional(),
};
