import { z } from 'zod/v4';

export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_HEARTBEAT_MS = 5_000;
export const WORKER_LEASE_MS = 60_000;
export const WORKER_ENDPOINT = '/worker';
export const WORKER_FRAME_MAX_BYTES = 256 * 1024;

const name = z.string().min(1).max(128);
const generation = z.string().uuid();
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkerIdentitySchema = z.object({ workerId: name, registrationGeneration: generation }).strict();
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
export const WorkerRegistrationSchema = z.object({
  name, registrationGeneration: generation,
  concurrency: sequence,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;

export const RemoteExecutionIdentitySchema = WorkerIdentitySchema.extend({
  projectId: z.string().min(1), taskName: z.string().min(1),
  executionId: z.string().uuid(), assignmentGeneration: sequence.min(1),
}).strict();
export type RemoteExecutionIdentity = z.infer<typeof RemoteExecutionIdentitySchema>;
export const RemoteAssignmentSchema = RemoteExecutionIdentitySchema.extend({
  workerName: name, requestId: z.string().min(1).max(128),
  originalSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  origin: z.string().min(1), branch: z.string().min(1),
  leaseExpiresAt: z.number().finite(),
  lastAcknowledgedLogSequence: sequence, controlSequence: sequence,
  workLocation: z.string().nullable(), retryReservation: z.boolean(),
}).strict();
export type RemoteAssignment = z.infer<typeof RemoteAssignmentSchema>;
export const RemoteTaskRecordSchema = z.object({
  assignment: RemoteAssignmentSchema,
  status: z.enum(['running', 'completed', 'failed']),
  failureReason: z.string().optional(),
}).strict();
export type RemoteTaskRecord = z.infer<typeof RemoteTaskRecordSchema>;

const envelope = { protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), requestId: z.string().min(1).max(128),
  ...WorkerIdentitySchema.shape };
export const WorkerRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('connect'), version: z.string(), canExecute: z.boolean(),
    active: z.array(RemoteExecutionIdentitySchema) }).strict(),
  z.object({ ...envelope, kind: z.literal('pull') }).strict(),
  z.object({ ...envelope, kind: z.literal('heartbeat'), active: z.array(RemoteExecutionIdentitySchema) }).strict(),
  z.object({ ...envelope, kind: z.literal('complete'), assignment: RemoteExecutionIdentitySchema,
    success: z.boolean(), reason: z.string().max(8192).optional() }).strict(),
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export const WorkerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('connected'), concurrency: sequence,
    running: z.array(RemoteAssignmentSchema), stop: z.array(RemoteExecutionIdentitySchema) }).strict(),
  z.object({ ...envelope, kind: z.literal('assignment'), assignment: RemoteAssignmentSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal('heartbeat'), stop: z.array(RemoteExecutionIdentitySchema) }).strict(),
  z.object({ ...envelope, kind: z.literal('completed'), accepted: z.boolean() }).strict(),
  z.object({ ...envelope, kind: z.literal('stop'), assignment: RemoteExecutionIdentitySchema, reason: z.string() }).strict(),
  z.object({ kind: z.literal('rejected'), reason: z.string() }).strict(),
]);
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

export interface WorkerConnectionSink {
  send(response: WorkerResponse): void;
  close(): void;
  fail(error: unknown): void;
}

export class WorkerRejectedError extends Error {}

export const RemoteProjectRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), taskName: z.string().min(1), ...WorkerIdentitySchema.shape,
    requestId: z.string().min(1), leaseExpiresAt: z.number().finite() }).strict(),
  z.object({ kind: z.literal('renew'), assignment: RemoteExecutionIdentitySchema,
    now: z.number().finite(), leaseExpiresAt: z.number().finite() }).strict(),
  z.object({ kind: z.literal('finish'), assignment: RemoteExecutionIdentitySchema,
    now: z.number().finite(), success: z.boolean(), reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal('fail'), assignment: RemoteExecutionIdentitySchema, reason: z.string() }).strict(),
]);
export type RemoteProjectRequest = z.infer<typeof RemoteProjectRequestSchema>;
export const RemoteProjectReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), assignment: RemoteAssignmentSchema.nullable() }).strict(),
  z.object({ kind: z.literal('updated'), record: RemoteTaskRecordSchema.nullable() }).strict(),
]);
export type RemoteProjectReply = z.infer<typeof RemoteProjectReplySchema>;

export function executionIdentity(assignment: RemoteExecutionIdentity): RemoteExecutionIdentity {
  return { projectId: assignment.projectId, taskName: assignment.taskName, workerId: assignment.workerId,
    registrationGeneration: assignment.registrationGeneration, executionId: assignment.executionId,
    assignmentGeneration: assignment.assignmentGeneration };
}

export function sameExecution(a: RemoteExecutionIdentity, b: RemoteExecutionIdentity): boolean {
  return a.projectId === b.projectId && a.taskName === b.taskName && a.workerId === b.workerId
    && a.registrationGeneration === b.registrationGeneration && a.executionId === b.executionId
    && a.assignmentGeneration === b.assignmentGeneration;
}

export function validateWorkerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid daemon URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search) throw new Error('Daemon URL must not contain credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('HTTPS is required for a daemon URL outside localhost');
  }
  return url;
}
