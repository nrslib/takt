import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import type { WorkflowOperationJournalContext } from '../types.js';
import type {
  OperationJournalChild,
  OperationJournalJsonValue,
  OperationJournalParent,
  OperationJournalStore,
} from '../operations/operation-journal-types.js';
import {
  OperationJournalConflictError,
  OperationRecoveryBlockedError,
  OperationRecoveryError,
  ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
} from '../operations/operation-recovery-error.js';

const PART_COMPLETION_KIND = 'finding_contract_part_completion';

export interface FindingContractWorkerBoundaryRequest {
  readonly partId: string;
  readonly title: string;
  readonly instruction: string;
  readonly findingAssignment: {
    readonly findingIds: readonly string[];
    readonly role: 'diagnose' | 'repair' | 'verify';
    readonly readPaths: readonly string[];
  };
}

export function findLatestOperationAttempt(
  parents: readonly OperationJournalParent[],
  logicalParentId: string,
): OperationJournalParent | undefined {
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  let current = parentById.get(logicalParentId);
  if (current === undefined) return undefined;
  let attempt = 1;
  while (true) {
    const successorId = operationAttemptId(logicalParentId, attempt + 1);
    const successor = parentById.get(successorId);
    if (successor === undefined) return current;
    const payload = payloadRecord(successor.payload);
    if (
      payload.logicalOperationId !== logicalParentId
      || payload.operationAttempt !== attempt + 1
      || payload.predecessorParentId !== current.id
    ) {
      throw new OperationRecoveryError(
        `Operation successor "${successor.id}" has invalid lineage metadata`,
      );
    }
    current = successor;
    attempt += 1;
  }
}

export function createOrphanRecoverySuccessor(input: {
  readonly context: WorkflowOperationJournalContext;
  readonly logicalParentId: string;
  readonly predecessor: OperationJournalParent;
  readonly workflowName: string;
  readonly stepName: string;
  readonly stepIteration: number;
  readonly executionScope: unknown;
}): OperationJournalParent {
  assertResumeSourceOwner(input.context, input.predecessor);
  const predecessorPayload = payloadRecord(input.predecessor.payload);
  const predecessorAttempt = input.predecessor.id === input.logicalParentId
    ? 1
    : readPositiveSafeInteger(predecessorPayload.operationAttempt);
  if (predecessorAttempt === undefined) {
    throw new OperationRecoveryError(
      `Operation "${input.predecessor.id}" is missing its attempt identity`,
    );
  }
  const recoveryCause = readOrphanedWorkerTermination(
    input.predecessor,
    predecessorAttempt === 1,
  );
  const nextAttempt = predecessorAttempt + 1;
  if (!Number.isSafeInteger(nextAttempt)) {
    throw new OperationRecoveryError(
      `Operation "${input.logicalParentId}" attempt identity is exhausted`,
    );
  }
  const successorParentId = operationAttemptId(input.logicalParentId, nextAttempt);
  const successorPayload = toJournalJson({
    workflowName: input.workflowName,
    stepName: input.stepName,
    stepIteration: input.stepIteration,
    executionScope: input.executionScope,
    logicalOperationId: input.logicalParentId,
    operationAttempt: nextAttempt,
    predecessorParentId: input.predecessor.id,
    recoveryCause: {
      recoveryCode: ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
      boundaryId: recoveryCause.boundaryId,
      ...(recoveryCause.legacyMigration ? { migration: 'legacy_untyped_v1' } : {}),
    },
  });
  const successorInput = {
    predecessorParentId: input.predecessor.id,
    expectedPredecessorOwner: input.predecessor.owner,
    expectedPredecessorRevision: input.predecessor.revision,
    successorParentId,
    successorClaimToken: input.context.claimToken,
    successorPayload,
    children: input.predecessor.children.map((child) => ({
      id: child.id,
      expectedRevision: child.revision,
      expectedStage: child.stage,
      ...materializeSuccessorChild(
        child,
        input.predecessor.id,
        recoveryCause.legacyMigration,
      ),
    })),
  };
  try {
    return input.context.store.createParentSuccessor(successorInput);
  } catch (error) {
    if (!(error instanceof OperationJournalConflictError)) throw error;
    let current: OperationJournalParent;
    try {
      current = input.context.store.getParent(successorParentId);
    } catch {
      throw error;
    }
    if (!isAcceptedSuccessorReplay(current, {
      kind: input.predecessor.kind,
      ownerGeneration: input.predecessor.owner.generation + 1,
      claimToken: input.context.claimToken,
      logicalOperationId: input.logicalParentId,
      operationAttempt: nextAttempt,
      predecessorParentId: input.predecessor.id,
      successorPayload,
    })) {
      throw error;
    }
    return current;
  }
}

export function createWorkerBoundaryPayload(
  request: FindingContractWorkerBoundaryRequest,
): OperationJournalJsonValue {
  return toJournalJson({
    requestDigest: workerRequestDigest(request),
  });
}

export function bindLegacyBoundaryRequestDigest(
  boundaryId: string,
  payload: OperationJournalJsonValue,
  request: FindingContractWorkerBoundaryRequest | undefined,
): OperationJournalJsonValue | undefined {
  if (request === undefined) return undefined;
  const record = payloadRecord(payload);
  const digest = workerRequestDigest(request);
  if (record.requestDigest === digest) return undefined;
  if (
    record.requestDigest === undefined
    && record.legacyRequestDigestBinding === 'pending'
  ) {
    const bound: Record<string, OperationJournalJsonValue> = {
      ...record,
      requestDigest: digest,
    };
    delete bound.legacyRequestDigestBinding;
    return toJournalJson(bound);
  }
  throw new OperationRecoveryError(
    `Worker boundary "${boundaryId}" request digest does not match its journaled request`,
  );
}

export function readOrphanRecoveryInstruction(
  child: OperationJournalChild,
  language: 'en' | 'ja' | undefined,
): string | undefined {
  const recovery = payloadRecord(payloadRecord(child.payload).orphanRecovery ?? {});
  if (
    recovery.disposition !== 'workspace_reconciliation'
    && recovery.disposition !== 'legacy_permission_recheck'
  ) return undefined;
  return language === 'ja'
    ? [
        '## 中断 worker の回復',
        '前回の worker は結果を journal に確定する前に停止したため、worktree に部分編集が残っている可能性があります。',
        '現在の worktree を確認し、すでに完了している変更を繰り返さず、割り当てられた finding の残作業だけを実施してください。',
      ].join('\n')
    : [
        '## Interrupted Worker Recovery',
        'The previous worker stopped before its result was committed to the journal, so partial edits may remain in the worktree.',
        'Inspect the current worktree, do not repeat changes that are already complete, and perform only the remaining work for the assigned findings.',
      ].join('\n');
}

export function assertOrphanRecoveryCanDispatch(child: OperationJournalChild): void {
  const recovery = payloadRecord(payloadRecord(child.payload).orphanRecovery ?? {});
  if (recovery.disposition === 'blocked') {
    throw new OperationRecoveryBlockedError(
      `Worker boundary "${child.id}" cannot be redispatched because workspace reconciliation is not guaranteed`,
    );
  }
}

function assertResumeSourceOwner(
  context: WorkflowOperationJournalContext,
  predecessor: OperationJournalParent,
): void {
  if (
    context.sourceClaimToken === undefined
    || predecessor.owner.claimToken !== context.sourceClaimToken
  ) {
    throw new OperationRecoveryError(
      `Operation "${predecessor.id}" is not owned by the current resume source`,
    );
  }
}

function readOrphanedWorkerTermination(
  parent: OperationJournalParent,
  allowLegacyMigration: boolean,
): { readonly boundaryId: string; readonly legacyMigration: boolean } {
  const error = payloadRecord(payloadRecord(parent.payload).error ?? {});
  const boundaryId = typeof error.boundaryId === 'string' ? error.boundaryId : undefined;
  const boundary = boundaryId === undefined
    ? undefined
    : parent.children.find((child) => child.id === boundaryId);
  if (
    error.recoveryCode === ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE
    && boundary !== undefined
    && boundary.kind === PART_COMPLETION_KIND
    && workerResultIsOrphaned(boundary)
    && payloadRecord(boundary.payload).workerPermissionMode === 'edit'
  ) {
    return { boundaryId: boundary.id, legacyMigration: false };
  }
  const legacyCandidates = allowLegacyMigration && isLegacyManualRestartError(error)
    ? parent.children.filter((child) => (
        child.kind === PART_COMPLETION_KIND && workerResultIsOrphaned(child)
      ))
    : [];
  const legacyBoundary = legacyCandidates[0];
  if (legacyCandidates.length === 1 && legacyBoundary !== undefined) {
    return { boundaryId: legacyBoundary.id, legacyMigration: true };
  }
  throw new OperationRecoveryBlockedError(
    `Operation "${parent.id}" terminated without a recoverable orphan worker cause`,
  );
}

function isLegacyManualRestartError(
  error: Record<string, OperationJournalJsonValue>,
): boolean {
  const keys = Object.keys(error);
  return (
    keys.length === 2
    && keys.includes('name')
    && keys.includes('message')
    && error.name === 'ManualRestartRequiredError'
    && typeof error.message === 'string'
  );
}

function isAcceptedSuccessorReplay(
  parent: OperationJournalParent,
  expected: {
    readonly kind: string;
    readonly ownerGeneration: number;
    readonly claimToken: string;
    readonly logicalOperationId: string;
    readonly operationAttempt: number;
    readonly predecessorParentId: string;
    readonly successorPayload: OperationJournalJsonValue;
  },
): boolean {
  const payload = payloadRecord(parent.payload);
  return (
    parent.kind === expected.kind
    && parent.owner.generation === expected.ownerGeneration
    && parent.owner.claimToken === expected.claimToken
    && payload.logicalOperationId === expected.logicalOperationId
    && payload.operationAttempt === expected.operationAttempt
    && payload.predecessorParentId === expected.predecessorParentId
    && canonicalJson(parent.payload) === canonicalJson(expected.successorPayload)
  );
}

function workerResultIsOrphaned(child: OperationJournalChild): boolean {
  if (child.stage !== 'worker_started' && child.stage !== 'running') return false;
  const payload = payloadRecord(child.payload);
  return (
    payload.providerFallbackPending !== true
    && payload.rateLimitedResult === undefined
    && payload.applied === undefined
    && payload.result === undefined
  );
}

function materializeSuccessorChild(
  child: OperationJournalChild,
  predecessorParentId: string,
  legacyMigration: boolean,
): Pick<
  Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'][number],
  'nextStage' | 'payload'
> {
  const sourcePayload = payloadRecord(child.payload);
  const needsLegacyRequestBinding = (
    legacyMigration
    && child.kind === PART_COMPLETION_KIND
    && sourcePayload.requestDigest === undefined
  );
  const materializedPayload = needsLegacyRequestBinding
    ? { ...sourcePayload, legacyRequestDigestBinding: 'pending' }
    : sourcePayload;
  if (child.kind !== PART_COMPLETION_KIND || !workerResultIsOrphaned(child)) {
    return {
      nextStage: child.stage,
      payload: needsLegacyRequestBinding ? toJournalJson(materializedPayload) : child.payload,
    };
  }
  const payload = { ...materializedPayload };
  const priorWorkerPermissionMode = payload.workerPermissionMode;
  delete payload.providerFallbackPending;
  delete payload.providerFallbackPendingAt;
  delete payload.rateLimitedResult;
  delete payload.workerStartedAt;
  delete payload.workerPermissionMode;
  delete payload.workspaceReconciliation;
  return {
    nextStage: 'reserved',
    payload: toJournalJson({
      ...payload,
      orphanRecovery: {
        disposition: legacyMigration
          ? 'legacy_permission_recheck'
          : priorWorkerPermissionMode === 'edit'
            ? 'workspace_reconciliation'
            : 'blocked',
        predecessorParentId,
        predecessorStage: child.stage,
        ...(legacyMigration
          ? {
              migration: 'legacy_untyped_v1',
              priorPermissionEvidence: 'unavailable_legacy_artifact',
            }
          : {}),
      },
    }),
  };
}

function workerRequestDigest(request: FindingContractWorkerBoundaryRequest): string {
  return createHash('sha256')
    .update(canonicalJson({
      partId: request.partId,
      title: request.title,
      instruction: request.instruction,
      findingAssignment: request.findingAssignment,
    }))
    .digest('hex');
}

function operationAttemptId(logicalParentId: string, attempt: number): string {
  return `${logicalParentId}:attempt:${attempt}`;
}

function readPositiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined;
}

function payloadRecord(value: unknown): Record<string, OperationJournalJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, OperationJournalJsonValue>
    : {};
}

function toJournalJson(value: unknown): OperationJournalJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as OperationJournalJsonValue;
}
