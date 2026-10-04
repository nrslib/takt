import type {
  NdjsonParallelMetadata,
  NdjsonParallelRole,
  NdjsonWorkflowStackEntry,
} from './types.js';

/** Maximum size of a canonical identity written to a session record. */
export const MAX_NDJSON_PARALLEL_ID_LENGTH = 128;

export interface NdjsonParallelMetadataInput {
  readonly stack: readonly NdjsonWorkflowStackEntry[] | undefined;
  readonly stepName?: string;
  readonly stepKind?: NdjsonWorkflowStackEntry['kind'];
  /** True only when the event's step is the parallel parent itself. */
  readonly isParallelParent?: boolean;
}

/**
 * Derive the canonical parallel role from the runtime resume stack.
 *
 * Direct agent participants intentionally have no frame of their own in the
 * legacy stack (`[parallel]`).  Their event step is therefore part of the
 * identity, while direct workflow calls use the explicit call frame.  A
 * deeper child stack keeps the direct call identity, but is not itself a
 * participant.
 */
export function buildNdjsonParallelMetadata(
  input: NdjsonParallelMetadataInput,
): NdjsonParallelMetadata | undefined {
  const stack = input.stack;
  if (stack === undefined || stack.length === 0) return undefined;

  const parallelIndex = findLastParallelFrame(stack);
  if (parallelIndex < 0) return undefined;
  const parentFrame = stack[parallelIndex];
  if (parentFrame === undefined) return undefined;

  const parentParticipationId = `parallel:${stableIdentityHash(frameIdentity(parentFrame))}`;
  if (input.isParallelParent === true && stack.length === parallelIndex + 1) {
    return {
      role: 'parent',
      participationId: parentParticipationId,
    };
  }

  const directFrame = stack[parallelIndex + 1];
  if (directFrame?.kind === 'workflow_call') {
    return {
      role: 'workflow_call_participant',
      participationId: `call:${stableIdentityHash(frameIdentity(directFrame))}`,
      parentParticipationId,
    };
  }

  // A direct agent has no child frame.  Do not infer a participant from a
  // deeper stack: that would turn an unrelated nested execution into a
  // parallel branch.
  if (
    stack.length === parallelIndex + 1
    && input.isParallelParent !== true
    && input.stepName !== undefined
    && input.stepName.length > 0
  ) {
    const participantIdentity = [
      parentParticipationId,
      input.stepKind ?? 'agent',
      input.stepName,
    ].join('|');
    return {
      role: 'direct_participant',
      participationId: `participant:${stableIdentityHash(participantIdentity)}`,
      parentParticipationId,
    };
  }

  return undefined;
}

/** Parse optional metadata from an untrusted NDJSON/cache value. */
export function parseNdjsonParallelMetadata(
  value: unknown,
  path = 'NDJSON parallel',
): NdjsonParallelMetadata | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  if (!isNdjsonParallelRole(metadata.role)) {
    throw new Error(`${path}.role is invalid`);
  }
  const participationId = requireBoundedIdentity(
    metadata.participationId,
    `${path}.participationId`,
  );
  const parentParticipationId = metadata.parentParticipationId === undefined
    ? undefined
    : requireBoundedIdentity(
      metadata.parentParticipationId,
      `${path}.parentParticipationId`,
    );
  if (metadata.role === 'parent' && parentParticipationId !== undefined) {
    throw new Error(`${path}.parentParticipationId is not allowed for parent role`);
  }
  if (metadata.role !== 'parent' && parentParticipationId === undefined) {
    throw new Error(`${path}.parentParticipationId is required for participant role`);
  }
  return {
    role: metadata.role,
    participationId,
    ...(parentParticipationId === undefined ? {} : { parentParticipationId }),
  };
}

function findLastParallelFrame(
  stack: readonly NdjsonWorkflowStackEntry[],
): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.kind === 'parallel') return index;
  }
  return -1;
}

function frameIdentity(frame: NdjsonWorkflowStackEntry): string {
  return [
    frame.workflow,
    frame.workflow_ref,
    frame.step,
    frame.kind,
    frame.occurrence,
  ].join('|');
}

function stableIdentityHash(value: string): string {
  // FNV-1a is sufficient for a compact, deterministic display identity. The
  // original names never leave this function, so arbitrary workflow labels
  // cannot inflate a session record or accidentally carry prompt content.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isNdjsonParallelRole(value: unknown): value is NdjsonParallelRole {
  return value === 'parent'
    || value === 'direct_participant'
    || value === 'workflow_call_participant';
}

function requireBoundedIdentity(value: unknown, path: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_NDJSON_PARALLEL_ID_LENGTH
  ) {
    throw new Error(`${path} must be a non-empty bounded string`);
  }
  return value;
}
