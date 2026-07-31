import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  WorkflowOperationJournalContext,
} from '../types.js';
import type { PermissionMode } from '../../models/types.js';
import {
  OPERATION_JOURNAL_STAGE_ORDER,
  type OperationJournalChild,
  type OperationJournalJsonValue,
  type OperationJournalParent,
  type OperationJournalStage,
  type OperationOwner,
} from '../operations/operation-journal-types.js';
import {
  ManualRestartRequiredError,
  ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
  OperationJournalConflictError,
  OperationRecoveryBlockedError,
  OperationRecoveryError,
} from '../operations/operation-recovery-error.js';
import type {
  FindingContractRecoveryAttemptEvent,
  FindingContractRecoveryResumeState,
  FindingContractRejectedOutput,
} from './team-leader-finding-contract-recovery.js';
import type {
  FindingContractRejectedOutputDigest,
} from '../team-leader-finding-contract-control-validation.js';
import {
  assertOrphanRecoveryCanDispatch,
  bindLegacyBoundaryRequestDigest,
  createOrphanRecoverySuccessor,
  createWorkerBoundaryPayload,
  findLatestOperationAttempt,
  readOrphanRecoveryInstruction,
  type FindingContractWorkerBoundaryRequest,
} from './team-leader-finding-contract-orphan-recovery.js';
export type {
  FindingContractWorkerBoundaryRequest,
} from './team-leader-finding-contract-orphan-recovery.js';

const PARENT_KIND = 'team_leader_finding_contract';

export class FindingContractOperationJournal {
  private constructor(
    private readonly context: WorkflowOperationJournalContext,
    readonly parentId: string,
    private owner: OperationOwner,
  ) {}

  static open(input: {
    readonly context: WorkflowOperationJournalContext;
    readonly workflowName: string;
    readonly stepName: string;
    readonly stepIteration: number;
    readonly executionScope?: unknown;
  }): FindingContractOperationJournal {
    const scopeHash = createHash('sha256')
      .update(canonicalJson(input.executionScope ?? null))
      .digest('hex')
      .slice(0, 16);
    const parentId = [
      scopeHash,
      input.workflowName,
      input.stepName,
      String(input.stepIteration),
    ].map(encodeURIComponent).join(':');
    const existing = findLatestOperationAttempt(input.context.store.listParents(), parentId);
    if (existing === undefined) {
      const created = input.context.store.createParent({
        id: parentId,
        kind: PARENT_KIND,
        claimToken: input.context.claimToken,
        stage: 'running',
        payload: toJournalJson({
          workflowName: input.workflowName,
          stepName: input.stepName,
          stepIteration: input.stepIteration,
          executionScope: input.executionScope ?? null,
          logicalOperationId: parentId,
          operationAttempt: 1,
        }),
      });
      return new FindingContractOperationJournal(input.context, parentId, created.owner);
    }
    if (existing.kind !== PARENT_KIND) {
      throw new OperationRecoveryError(
        `Operation "${parentId}" has unexpected kind "${existing.kind}"`,
      );
    }
    if (existing.stage === 'terminated') {
      const successor = createOrphanRecoverySuccessor({
        context: input.context,
        logicalParentId: parentId,
        predecessor: existing,
        workflowName: input.workflowName,
        stepName: input.stepName,
        stepIteration: input.stepIteration,
        executionScope: input.executionScope ?? null,
      });
      return new FindingContractOperationJournal(
        input.context,
        successor.id,
        successor.owner,
      );
    }
    if (existing.stage === 'terminating') {
      throw new OperationRecoveryError(
        `Operation "${parentId}" stopped while terminal settlement was in progress`,
      );
    }
    if (existing.owner.claimToken === input.context.claimToken) {
      return new FindingContractOperationJournal(input.context, existing.id, existing.owner);
    }
    if (
      input.context.sourceClaimToken === undefined
      || existing.owner.claimToken !== input.context.sourceClaimToken
    ) {
      throw new OperationRecoveryError(
        `Operation "${parentId}" is not owned by the current resume source`,
      );
    }
    if (existing.stage === 'completed') {
      return new FindingContractOperationJournal(input.context, existing.id, existing.owner);
    }
    const claimed = input.context.store.claimParent({
      parentId: existing.id,
      expectedOwner: existing.owner,
      expectedRevision: existing.revision,
      expectedStage: existing.stage,
      nextClaimToken: input.context.claimToken,
    });
    return new FindingContractOperationJournal(input.context, existing.id, claimed.owner);
  }

  boundary(
    id: string,
    kind: string,
    request?: FindingContractWorkerBoundaryRequest,
  ): FindingContractOperationBoundary {
    const existing = this.context.store.listChildren(this.parentId)
      .find((child) => child.id === id);
    if (existing !== undefined) {
      if (existing.kind !== kind) {
        throw new OperationRecoveryError(
          `Operation boundary "${id}" has unexpected kind "${existing.kind}"`,
        );
      }
      const boundPayload = bindLegacyBoundaryRequestDigest(id, existing.payload, request);
      if (boundPayload !== undefined) {
        this.updateChild(id, existing.stage, boundPayload, existing);
      }
      return new FindingContractOperationBoundary(this, id);
    }
    const parent = this.getParent();
    this.context.store.createChild({
      parentId: this.parentId,
      owner: this.owner,
      expectedParentRevision: parent.revision,
      expectedParentStage: parent.stage,
      id,
      kind,
      stage: 'reserved',
      payload: request === undefined ? {} : createWorkerBoundaryPayload(request),
    });
    return new FindingContractOperationBoundary(this, id);
  }

  markResultReady(value: unknown): void {
    const parent = this.getParent();
    if (parent.stage === 'applied' || parent.stage === 'completed') return;
    this.transitionParent('applied', {
      result: toJournalJson(value),
      resultReadyAt: new Date().toISOString(),
    });
  }

  readResultReady<T>(): T | undefined {
    const parent = this.getParent();
    if (parent.stage !== 'applied' && parent.stage !== 'completed') return undefined;
    return readPayloadValue<T>(parent.payload, 'result');
  }

  completeTransition(receipt: unknown): void {
    const parent = this.getParent();
    if (parent.stage === 'completed') {
      const existingReceipt = readPayloadValue<unknown>(parent.payload, 'transitionReceipt');
      if (canonicalJson(existingReceipt) !== canonicalJson(receipt)) {
        throw new OperationRecoveryError(
          `Operation "${this.parentId}" transition receipt changed after completion`,
        );
      }
      return;
    }
    if (parent.stage !== 'applied') {
      throw new OperationRecoveryError(
        `Operation "${this.parentId}" cannot author a transition from stage "${parent.stage}"`,
      );
    }
    this.transitionParent('completed', {
      transitionReceipt: toJournalJson(receipt),
      completedAt: new Date().toISOString(),
    });
  }

  beginTermination(error: unknown): void {
    const parent = this.getParent();
    if (
      parent.stage === 'terminating'
      || parent.stage === 'completed'
      || parent.stage === 'terminated'
    ) {
      return;
    }
    this.transitionParent('terminating', {
      terminatingAt: new Date().toISOString(),
      error: describeError(error),
    });
  }

  terminate(error: unknown): void {
    const parent = this.getParent();
    if (parent.stage === 'completed' || parent.stage === 'terminated') return;
    this.transitionParent('terminated', {
      terminatedAt: new Date().toISOString(),
      error: describeError(error),
    });
  }

  getParent(): OperationJournalParent {
    const parent = this.context.store.getParent(this.parentId);
    if (
      parent.owner.generation !== this.owner.generation
      || parent.owner.claimToken !== this.owner.claimToken
    ) {
      throw new OperationRecoveryError(`Operation "${this.parentId}" ownership changed`);
    }
    return parent;
  }

  getChild(childId: string): OperationJournalChild {
    return this.context.store.getChild(this.parentId, childId);
  }

  updateChild(
    childId: string,
    nextStage: OperationJournalStage,
    payload: OperationJournalJsonValue,
    expectedChild?: OperationJournalChild,
  ): OperationJournalChild {
    const parent = this.getParent();
    const child = expectedChild ?? this.getChild(childId);
    return this.context.store.compareAndSetChild({
      parentId: this.parentId,
      owner: this.owner,
      expectedParentRevision: parent.revision,
      expectedParentStage: parent.stage,
      childId,
      expectedRevision: child.revision,
      expectedStage: child.stage,
      nextStage,
      payload,
    });
  }

  appendAttempt<TDigest extends FindingContractRejectedOutputDigest>(
    childId: string,
    event: FindingContractRecoveryAttemptEvent<TDigest>,
    nextStage: OperationJournalStage,
    payload: OperationJournalJsonValue,
    expectedChild?: OperationJournalChild,
  ): OperationJournalChild {
    const parent = this.getParent();
    const child = expectedChild ?? this.getChild(childId);
    return this.context.store.appendAttempt({
      parentId: this.parentId,
      owner: this.owner,
      expectedParentRevision: parent.revision,
      expectedParentStage: parent.stage,
      childId,
      expectedRevision: child.revision,
      expectedStage: child.stage,
      nextStage,
      payload,
      attempt: {
        id: `${event.attemptToken}:${event.type}`,
        attemptToken: event.attemptToken,
        status: event.type,
        payload: toJournalJson({
          event: {
            ...event,
            acceptedValue: undefined,
          },
        }),
      },
    });
  }

  private transitionParent(
    nextStage: OperationJournalStage,
    payload: OperationJournalJsonValue,
  ): void {
    const parent = this.getParent();
    this.context.store.compareAndSetParent({
      parentId: this.parentId,
      owner: this.owner,
      expectedRevision: parent.revision,
      expectedStage: parent.stage,
      nextStage,
      payload: {
        ...payloadRecord(parent.payload),
        ...payloadRecord(payload),
      },
    });
  }
}

export class FindingContractOperationBoundary {
  constructor(
    private readonly journal: FindingContractOperationJournal,
    readonly id: string,
  ) {}

  get stage(): OperationJournalStage {
    return this.journal.getChild(this.id).stage;
  }

  readCompleted<T>(): T | undefined {
    const child = this.journal.getChild(this.id);
    if (child.stage !== 'completed') return undefined;
    return readPayloadValue<T>(child.payload, 'result');
  }

  readAccepted<T>(): T | undefined {
    const child = this.journal.getChild(this.id);
    if (OPERATION_JOURNAL_STAGE_ORDER[child.stage] < OPERATION_JOURNAL_STAGE_ORDER.accepted) {
      return undefined;
    }
    return readPayloadValue<T>(child.payload, 'accepted');
  }

  readApplied<T>(): T | undefined {
    const child = this.journal.getChild(this.id);
    if (child.stage !== 'applied') return undefined;
    return readPayloadValue<T>(child.payload, 'applied');
  }

  orphanRecoveryInstruction(language: 'en' | 'ja' | undefined): string | undefined {
    return readOrphanRecoveryInstruction(this.journal.getChild(this.id), language);
  }

  assertWorkerCanStart(): void {
    assertWorkerCanStartFromChild(this.journal.getChild(this.id));
  }

  markWorkerStarted(permissionMode: PermissionMode | undefined): void {
    const child = this.journal.getChild(this.id);
    const providerFallbackPending = assertWorkerCanStartFromChild(child);
    const dispatchPayload = prepareOrphanRecoveryDispatch(child, permissionMode);
    if (permissionMode === undefined) {
      throw new OperationRecoveryError(
        `Worker boundary "${this.id}" dispatch is missing its effective permission mode`,
      );
    }
    const nextStage = child.stage === 'running' && providerFallbackPending
      ? 'running'
      : 'worker_started';
    this.journal.updateChild(
      this.id,
      nextStage,
      toJournalJson({
        ...dispatchPayload,
        providerFallbackPending: false,
        workerPermissionMode: permissionMode,
        workerStartedAt: new Date().toISOString(),
      }),
      child,
    );
  }

  markProviderFallbackPending(value: unknown): void {
    const child = this.journal.getChild(this.id);
    const providerFallbackPending = payloadRecord(child.payload).providerFallbackPending === true;
    if (
      (child.stage !== 'worker_started' && child.stage !== 'running')
      || providerFallbackPending
    ) {
      throw new OperationRecoveryError(
        `Worker boundary "${this.id}" cannot await provider fallback from stage "${child.stage}"`,
      );
    }
    this.mergePayload('running', {
      providerFallbackPending: true,
      rateLimitedResult: toJournalJson(value),
      providerFallbackPendingAt: new Date().toISOString(),
    });
  }

  markApplied(value: unknown): void {
    this.mergePayload('applied', {
      applied: toJournalJson(value),
      appliedAt: new Date().toISOString(),
    });
  }

  complete(value: unknown): void {
    const child = this.journal.getChild(this.id);
    const payload = { ...payloadRecord(child.payload) };
    delete payload.accepted;
    delete payload.applied;
    this.journal.updateChild(
      this.id,
      'completed',
      toJournalJson({
        ...payload,
        result: toJournalJson(value),
        completedAt: new Date().toISOString(),
      }),
      child,
    );
  }

  recordAttempt<TDigest extends FindingContractRejectedOutputDigest>(
    event: FindingContractRecoveryAttemptEvent<TDigest>,
  ): void {
    if (
      event.envelope !== undefined
      && event.envelope.attemptToken !== event.attemptToken
    ) {
      throw new OperationRecoveryError(
        `Operation attempt "${event.attemptToken}" does not match envelope token `
        + `"${event.envelope.attemptToken}"`,
      );
    }
    if (event.type === 'late' && parentIsTerminal(this.journal.getParent())) {
      return;
    }
    const child = this.journal.getChild(this.id);
    const payload = payloadRecord(child.payload);
    const now = Date.now();
    const episode = payloadRecord(payload.episode ?? {});
    const startedAt = readFiniteNumber(episode.startedAt) ?? now - event.elapsedMs;
    const deadlineAt = readFiniteNumber(episode.deadlineAt) ?? now + event.remainingMs;
    const completedCalls = Math.max(
      readFiniteNumber(episode.completedCalls) ?? 0,
      event.attempt,
    );
    const nextPayload = toJournalJson({
      ...payload,
      episode: {
        startedAt,
        deadlineAt,
        completedCalls,
        mode: event.mode,
        ...(event.strictReason === undefined ? {} : { strictReason: event.strictReason }),
        ...(event.envelope === undefined
          ? episode.latestSessionId === undefined
            ? {}
            : { latestSessionId: episode.latestSessionId }
          : event.envelope.sessionId === undefined
            ? {}
            : { latestSessionId: event.envelope.sessionId }),
      },
      ...(event.type === 'accepted' && event.acceptedValue !== undefined
        ? { accepted: event.acceptedValue }
        : {}),
    });
    try {
      this.journal.appendAttempt(
        this.id,
        event,
        nextAttemptStage(child.stage, event.type),
        nextPayload,
        child,
      );
    } catch (error) {
      if (
        event.type === 'late'
        && error instanceof OperationJournalConflictError
        && parentIsTerminal(this.journal.getParent())
      ) {
        return;
      }
      throw error;
    }
  }

  recoveryResumeState<
    TDigest extends FindingContractRejectedOutputDigest,
  >(): FindingContractRecoveryResumeState<TDigest> | undefined {
    const child = this.journal.getChild(this.id);
    const payload = payloadRecord(child.payload);
    const episode = payloadRecord(payload.episode ?? {});
    const startedAt = readFiniteNumber(episode.startedAt);
    const deadlineAt = readFiniteNumber(episode.deadlineAt);
    const completedCalls = readFiniteNumber(episode.completedCalls);
    const mode = episode.mode;
    if (
      startedAt === undefined
      || deadlineAt === undefined
      || completedCalls === undefined
      || (mode !== 'normal' && mode !== 'strict')
    ) {
      return undefined;
    }
    const rejectedOutputs = child.attempts.flatMap((attempt) => {
      if (attempt.status !== 'rejected') return [];
      const event = payloadRecord(payloadRecord(attempt.payload).event ?? {});
      const rejected = event.rejectedOutput;
      return isRejectedOutput<TDigest>(rejected) ? [rejected] : [];
    });
    const strictReason = episode.strictReason;
    const latestSessionId = episode.latestSessionId;
    return {
      startedAt,
      deadlineAt,
      completedCalls,
      mode,
      ...(isStrictReason(strictReason) ? { strictReason } : {}),
      ...(typeof latestSessionId === 'string' ? { latestSessionId } : {}),
      rejectedOutputs,
    };
  }

  private mergePayload(
    nextStage: OperationJournalStage,
    additions: Record<string, unknown>,
  ): void {
    const child = this.journal.getChild(this.id);
    this.journal.updateChild(
      this.id,
      nextStage,
      toJournalJson({ ...payloadRecord(child.payload), ...additions }),
      child,
    );
  }
}

function assertWorkerCanStartFromChild(child: OperationJournalChild): boolean {
  assertOrphanRecoveryCanDispatch(child);
  const providerFallbackPending = payloadRecord(child.payload).providerFallbackPending === true;
  if (child.stage === 'reserved' || (child.stage === 'running' && providerFallbackPending)) {
    return providerFallbackPending;
  }
  if (child.stage === 'worker_started' || child.stage === 'running') {
    throw new ManualRestartRequiredError(
      `Worker boundary "${child.id}" stopped after dispatch and before its result was journaled`,
      { boundaryId: child.id },
    );
  }
  throw new OperationRecoveryError(
    `Worker boundary "${child.id}" cannot start from stage "${child.stage}"`,
  );
}

function prepareOrphanRecoveryDispatch(
  child: OperationJournalChild,
  permissionMode: PermissionMode | undefined,
): Record<string, OperationJournalJsonValue> {
  const payload = payloadRecord(child.payload);
  const recovery = payloadRecord(payload.orphanRecovery ?? {});
  if (
    recovery.disposition !== 'workspace_reconciliation'
    && recovery.disposition !== 'legacy_permission_recheck'
  ) {
    return payload;
  }
  if (permissionMode !== 'edit') {
    throw new OperationRecoveryBlockedError(
      `Worker boundary "${child.id}" cannot be redispatched without effective edit permission`,
    );
  }
  if (recovery.disposition === 'workspace_reconciliation') return payload;
  if (typeof payload.requestDigest !== 'string') {
    throw new OperationRecoveryBlockedError(
      `Worker boundary "${child.id}" cannot dispatch before its legacy request is bound`,
    );
  }
  return {
    ...payload,
    orphanRecovery: {
      ...recovery,
      disposition: 'workspace_reconciliation',
    },
  };
}

function parentIsTerminal(parent: OperationJournalParent): boolean {
  return (
    parent.stage === 'terminating'
    || parent.stage === 'completed'
    || parent.stage === 'terminated'
  );
}

function nextAttemptStage(
  current: OperationJournalStage,
  type: FindingContractRecoveryAttemptEvent['type'],
): OperationJournalStage {
  if (type === 'terminated') return 'terminated';
  if (OPERATION_JOURNAL_STAGE_ORDER[current] >= OPERATION_JOURNAL_STAGE_ORDER.applied) {
    return current;
  }
  if (type === 'accepted') return 'accepted';
  return 'running';
}

function payloadRecord(value: unknown): Record<string, OperationJournalJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, OperationJournalJsonValue>
    : {};
}

function readPayloadValue<T>(payload: OperationJournalJsonValue, key: string): T | undefined {
  const value = payloadRecord(payload)[key];
  return value === undefined ? undefined : structuredClone(value) as T;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRejectedOutput<TDigest extends FindingContractRejectedOutputDigest>(
  value: unknown,
): value is FindingContractRejectedOutput<TDigest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  const digest = output.outputDigest;
  return (
    typeof output.attempt === 'number'
    && (output.mode === 'normal' || output.mode === 'strict')
    && Array.isArray(output.issues)
    && typeof output.issueFingerprint === 'string'
    && typeof output.repeatCount === 'number'
    && typeof digest === 'object'
    && digest !== null
    && typeof (digest as Record<string, unknown>).hash === 'string'
  );
}

function isStrictReason(value: unknown): value is NonNullable<
  FindingContractRecoveryResumeState['strictReason']
> {
  return (
    value === 'normal_attempts_exhausted'
    || value === 'evidence_or_reference_issue'
    || value === 'repeated_output'
    || value === 'repeated_issue_set'
  );
}

function toJournalJson(value: unknown): OperationJournalJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as OperationJournalJsonValue;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort(compareBinaryStrings).map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function describeError(error: unknown): Record<string, string> {
  if (error instanceof ManualRestartRequiredError) {
    return {
      name: error.name,
      message: error.message,
      recoveryCode: ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE,
      boundaryId: error.boundaryId,
    };
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}
