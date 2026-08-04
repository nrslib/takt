import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type { WorkflowOperationJournalContext } from '../types.js';
import type {
  OperationJournalChild,
  OperationJournalJsonValue,
  OperationJournalParent,
  OperationJournalStore,
} from '../operations/operation-journal-types.js';
import {
  EXPLICIT_PART_FAILURE_RECOVERY_CODE,
  OperationJournalConflictError,
  OperationRecoveryBlockedError,
  OperationRecoveryError,
  ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
} from '../operations/operation-recovery-error.js';

const PART_COMPLETION_KIND = 'finding_contract_part_completion';
const DECOMPOSITION_KIND = 'finding_contract_decomposition';

interface WorkerRecoveryCause {
  readonly boundaryId: string;
  readonly legacyMigration: boolean;
  readonly recoveryCode: typeof ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE
    | typeof EXPLICIT_PART_FAILURE_RECOVERY_CODE;
  readonly disposition: 'explicit_retry' | 'workspace_reconciliation';
}

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

export function createTerminatedRecoverySuccessor(input: {
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
  const recoveryCause = readRecoverableWorkerTermination(input.predecessor, predecessorAttempt);
  const nextAttempt = predecessorAttempt + 1;
  if (!Number.isSafeInteger(nextAttempt)) {
    throw new OperationRecoveryError(
      `Operation "${input.logicalParentId}" attempt identity is exhausted`,
    );
  }
  const successorParentId = operationAttemptId(input.logicalParentId, nextAttempt);
  const childMaterializations = input.predecessor.children.map((child) => ({
    id: child.id,
    expectedRevision: child.revision,
    expectedStage: child.stage,
    ...materializeSuccessorChild(
      child,
      input.predecessor.id,
      recoveryCause,
    ),
  }));
  const recoveryPlanDigest = createRecoveryPlanDigest(childMaterializations);
  const successorPayload = toJournalJson({
    workflowName: input.workflowName,
    stepName: input.stepName,
    stepIteration: input.stepIteration,
    executionScope: input.executionScope,
    logicalOperationId: input.logicalParentId,
    operationAttempt: nextAttempt,
    predecessorParentId: input.predecessor.id,
    recoveryPlanDigest,
    recoveryCause: {
      recoveryCode: recoveryCause.recoveryCode,
      boundaryId: recoveryCause.boundaryId,
      ...(recoveryCause.legacyMigration
        ? {
            migration: recoveryCause.recoveryCode === EXPLICIT_PART_FAILURE_RECOVERY_CODE
              ? 'legacy_untyped_part_failure_v1'
              : 'legacy_untyped_v1',
          }
        : {}),
    },
  });
  const successorInput = {
    predecessorParentId: input.predecessor.id,
    expectedPredecessorOwner: input.predecessor.owner,
    expectedPredecessorRevision: input.predecessor.revision,
    successorParentId,
    successorClaimToken: input.context.claimToken,
    successorPayload,
    children: childMaterializations,
  };
  const expectedSuccessorChildren = materializeExpectedSuccessorChildren(
    input.predecessor.children,
    childMaterializations,
  );
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
      expectedChildren: expectedSuccessorChildren,
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
    dispatchState: 'not_dispatched',
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
    && recovery.disposition !== 'explicit_retry'
  ) return undefined;
  if (recovery.disposition === 'explicit_retry') {
    return language === 'ja'
      ? [
          '## 明示失敗 worker の再試行',
          '前回の worker は明示的なエラーで終了しました。新しいセッションで割り当てを最初から再試行してください。',
        ].join('\n')
      : [
          '## Explicit Worker Failure Retry',
          'The previous worker ended with an explicit error. Retry the assignment in a fresh session.',
        ].join('\n');
  }
  if (recovery.recoveryCode === EXPLICIT_PART_FAILURE_RECOVERY_CODE) {
    return language === 'ja'
      ? [
          '## 明示失敗 worker のworktree再調整',
          '前回の worker が失敗するまでの部分編集がworktreeに残っている可能性があります。',
          '現在のworktreeを確認し、完了済みの変更を繰り返さず、割り当ての残作業だけを実施してください。',
        ].join('\n')
      : [
          '## Explicit Worker Failure Reconciliation',
          'Partial edits made before the previous worker failed may remain in the worktree.',
          'Inspect the current worktree, avoid repeating completed changes, and perform only the remaining assignment work.',
        ].join('\n');
  }
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
    context.sourceClaimTokens === undefined
    || !context.sourceClaimTokens.has(predecessor.owner.claimToken)
  ) {
    throw new OperationRecoveryError(
      `Operation "${predecessor.id}" is not owned by the current resume source`,
    );
  }
}

function readRecoverableWorkerTermination(
  parent: OperationJournalParent,
  predecessorAttempt: number,
): WorkerRecoveryCause {
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
    return {
      boundaryId: boundary.id,
      legacyMigration: false,
      recoveryCode: ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
      disposition: 'workspace_reconciliation',
    };
  }
  if (
    error.recoveryCode === EXPLICIT_PART_FAILURE_RECOVERY_CODE
    && boundary !== undefined
  ) {
    if (hasUnsafeWorkerSibling(parent, boundary.id)) {
      throw new OperationRecoveryBlockedError(
        `Operation "${parent.id}" has another unsettled worker boundary`,
      );
    }
    return classifyExplicitFailure(boundary, false);
  }
  const legacyCandidates = predecessorAttempt === 1 && isLegacyManualRestartError(error)
    ? parent.children.filter((child) => (
        child.kind === PART_COMPLETION_KIND && workerResultIsOrphaned(child)
      ))
    : [];
  const legacyBoundary = legacyCandidates[0];
  if (legacyCandidates.length === 1 && legacyBoundary !== undefined) {
    return {
      boundaryId: legacyBoundary.id,
      legacyMigration: true,
      recoveryCode: ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
      disposition: 'workspace_reconciliation',
    };
  }
  const legacyExplicitFailure = readLegacyExplicitFailure(
    parent,
    error,
    predecessorAttempt,
  );
  if (legacyExplicitFailure !== undefined) {
    return classifyExplicitFailure(legacyExplicitFailure, true);
  }
  throw new OperationRecoveryBlockedError(
    `Operation "${parent.id}" terminated without a recoverable orphan worker cause`,
  );
}

function readLegacyExplicitFailure(
  parent: OperationJournalParent,
  error: Record<string, OperationJournalJsonValue>,
  predecessorAttempt: number,
): OperationJournalChild | undefined {
  if (
    predecessorAttempt !== 2
    || !hasExactKeys(error, ['message', 'name'])
    || error.name !== 'Error'
    || typeof error.message !== 'string'
  ) return undefined;
  const parentPayload = payloadRecord(parent.payload);
  const recoveryCause = payloadRecord(parentPayload.recoveryCause ?? {});
  if (
    parentPayload.operationAttempt !== 2
    || typeof parentPayload.logicalOperationId !== 'string'
    || parentPayload.predecessorParentId !== parentPayload.logicalOperationId
    || recoveryCause.recoveryCode !== ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE
    || recoveryCause.migration !== 'legacy_untyped_v1'
  ) return undefined;
  if (!parent.children.some((child) => (
    child.kind === DECOMPOSITION_KIND && child.stage === 'completed'
  ))) return undefined;
  const candidates = parent.children.filter(isAppliedErrorPartCompletion);
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (candidate === undefined) return undefined;
  const candidatePayload = payloadRecord(candidate.payload);
  const priorRecovery = payloadRecord(candidatePayload.orphanRecovery ?? {});
  const applied = payloadRecord(candidatePayload.applied ?? {});
  const response = payloadRecord(applied.response ?? {});
  const appliedError = typeof response.error === 'string'
    ? response.error
    : typeof response.content === 'string'
      ? response.content
      : undefined;
  if (
    recoveryCause.boundaryId !== candidate.id
    || !hasExactKeys(priorRecovery, [
      'disposition',
      'migration',
      'predecessorParentId',
      'predecessorStage',
      'priorPermissionEvidence',
    ])
    || priorRecovery.disposition !== 'legacy_permission_recheck'
    || priorRecovery.migration !== 'legacy_untyped_v1'
    || priorRecovery.predecessorParentId !== parentPayload.predecessorParentId
    || (
      priorRecovery.predecessorStage !== 'worker_started'
      && priorRecovery.predecessorStage !== 'running'
    )
    || priorRecovery.priorPermissionEvidence !== 'unavailable_legacy_artifact'
    || appliedError !== error.message
  ) return undefined;
  if (candidatePayload.dispatchState !== undefined) return undefined;
  return hasUnsafeWorkerSibling(parent, candidate.id) ? undefined : candidate;
}

function hasExactKeys(
  value: Readonly<Record<string, OperationJournalJsonValue>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareBinaryStrings);
  const sortedExpected = [...expected].sort(compareBinaryStrings);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function hasUnsafeWorkerSibling(parent: OperationJournalParent, boundaryId: string): boolean {
  return parent.children.some((child) => (
    child.id !== boundaryId
    && child.kind === PART_COMPLETION_KIND
    && (child.stage === 'worker_started' || child.stage === 'running')
    && payloadRecord(child.payload).providerFallbackPending !== true
  ));
}

function classifyExplicitFailure(
  child: OperationJournalChild,
  legacyMigration: boolean,
): WorkerRecoveryCause {
  if (!isAppliedErrorPartCompletion(child)) {
    throw new OperationRecoveryBlockedError(
      `Worker boundary "${child.id}" does not contain a valid applied error result`,
    );
  }
  const payload = payloadRecord(child.payload);
  const dispatchState = payload.dispatchState;
  const workerStartedAt = payload.workerStartedAt;
  const permissionMode = payload.workerPermissionMode;
  const noDispatchEvidence = workerStartedAt === undefined && permissionMode === undefined;
  if ((dispatchState === 'not_dispatched' || (legacyMigration && dispatchState === undefined))) {
    if (!noDispatchEvidence) throwInconsistentDispatchEvidence(child.id);
    return {
      boundaryId: child.id,
      legacyMigration,
      recoveryCode: EXPLICIT_PART_FAILURE_RECOVERY_CODE,
      disposition: 'explicit_retry',
    };
  }
  if (dispatchState !== 'dispatched') throwInconsistentDispatchEvidence(child.id);
  if (typeof workerStartedAt !== 'string' || typeof permissionMode !== 'string') {
    throwInconsistentDispatchEvidence(child.id);
  }
  if (permissionMode === 'full') {
    throw new OperationRecoveryBlockedError(
      `Worker boundary "${child.id}" cannot retry after a full-permission dispatch`,
    );
  }
  if (permissionMode !== 'readonly' && permissionMode !== 'edit') {
    throwInconsistentDispatchEvidence(child.id);
  }
  return {
    boundaryId: child.id,
    legacyMigration,
    recoveryCode: EXPLICIT_PART_FAILURE_RECOVERY_CODE,
    disposition: permissionMode === 'edit' ? 'workspace_reconciliation' : 'explicit_retry',
  };
}

function throwInconsistentDispatchEvidence(boundaryId: string): never {
  throw new OperationRecoveryBlockedError(
    `Worker boundary "${boundaryId}" has inconsistent dispatch evidence`,
  );
}

function isAppliedErrorPartCompletion(child: OperationJournalChild): boolean {
  if (child.kind !== PART_COMPLETION_KIND || child.stage !== 'applied') return false;
  const payload = payloadRecord(child.payload);
  if (typeof payload.requestDigest !== 'string') return false;
  const applied = payloadRecord(payload.applied ?? {});
  const response = payloadRecord(applied.response ?? {});
  const part = payloadRecord(applied.part ?? {});
  const findingAssignment = payloadRecord(part.findingContract ?? {});
  if (
    response.status !== 'error'
    || typeof part.id !== 'string'
    || child.id !== `part:${part.id}:completion`
    || typeof part.title !== 'string'
    || typeof part.instruction !== 'string'
    || !Array.isArray(findingAssignment.findingIds)
    || !Array.isArray(findingAssignment.readPaths)
    || !findingAssignment.findingIds.every((value) => typeof value === 'string')
    || !findingAssignment.readPaths.every((value) => typeof value === 'string')
    || (
      findingAssignment.role !== 'diagnose'
      && findingAssignment.role !== 'repair'
      && findingAssignment.role !== 'verify'
    )
  ) return false;
  return payload.requestDigest === workerRequestDigest({
    partId: part.id,
    title: part.title,
    instruction: part.instruction,
    findingAssignment: {
      findingIds: findingAssignment.findingIds as string[],
      role: findingAssignment.role,
      readPaths: findingAssignment.readPaths as string[],
    },
  });
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
    readonly expectedChildren: readonly OperationJournalChild[];
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
    && canonicalJson(parent.children) === canonicalJson(expected.expectedChildren)
  );
}

function createRecoveryPlanDigest(
  children: Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'],
): string {
  const canonicalPlan = [...children]
    .sort((left, right) => compareBinaryStrings(left.id, right.id))
    .map((child) => ({
      id: child.id,
      expectedRevision: child.expectedRevision,
      expectedStage: child.expectedStage,
      nextStage: child.nextStage,
      payload: child.payload,
      ...(child.resetReason === undefined ? {} : { resetReason: child.resetReason }),
    }));
  return createHash('sha256').update(canonicalJson(canonicalPlan)).digest('hex');
}

function materializeExpectedSuccessorChildren(
  predecessorChildren: readonly OperationJournalChild[],
  materializations: Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'],
): readonly OperationJournalChild[] {
  const materializationById = new Map(materializations.map((child) => [child.id, child]));
  return predecessorChildren.map((child) => {
    const materialization = materializationById.get(child.id);
    if (materialization === undefined) {
      throw new OperationRecoveryError(
        `Operation child "${child.id}" is missing from its recovery plan`,
      );
    }
    return {
      ...child,
      stage: materialization.nextStage,
      payload: materialization.payload,
    };
  });
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
  recoveryCause: WorkerRecoveryCause,
): Pick<
  Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'][number],
  'nextStage' | 'payload' | 'resetReason'
> {
  const sourcePayload = payloadRecord(child.payload);
  const needsLegacyRequestBinding = (
    recoveryCause.legacyMigration
    && recoveryCause.recoveryCode === ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE
    && child.kind === PART_COMPLETION_KIND
    && sourcePayload.requestDigest === undefined
  );
  const materializedPayload = needsLegacyRequestBinding
    ? { ...sourcePayload, legacyRequestDigestBinding: 'pending' }
    : sourcePayload;
  if (child.kind !== PART_COMPLETION_KIND || child.id !== recoveryCause.boundaryId) {
    return {
      nextStage: child.stage,
      payload: needsLegacyRequestBinding ? toJournalJson(materializedPayload) : child.payload,
    };
  }
  const payload = { ...materializedPayload };
  delete payload.applied;
  delete payload.appliedAt;
  delete payload.providerFallbackPending;
  delete payload.providerFallbackPendingAt;
  delete payload.rateLimitedResult;
  delete payload.workerStartedAt;
  delete payload.workerPermissionMode;
  delete payload.workspaceReconciliation;
  return {
    nextStage: 'reserved',
    resetReason: recoveryCause.recoveryCode,
    payload: toJournalJson({
      ...payload,
      dispatchState: 'not_dispatched',
      orphanRecovery: {
        disposition: recoveryCause.legacyMigration
          && recoveryCause.recoveryCode === ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE
          ? 'legacy_permission_recheck'
          : recoveryCause.disposition,
        predecessorParentId,
        predecessorStage: child.stage,
        recoveryCode: recoveryCause.recoveryCode,
        ...(recoveryCause.legacyMigration
          ? {
              migration: recoveryCause.recoveryCode === EXPLICIT_PART_FAILURE_RECOVERY_CODE
                ? 'legacy_untyped_part_failure_v1'
                : 'legacy_untyped_v1',
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
