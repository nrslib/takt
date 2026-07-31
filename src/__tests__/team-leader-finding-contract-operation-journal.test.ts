import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createOperationJournalStore } from '../infra/workflow/operation-journal-store.js';
import {
  FindingContractOperationJournal,
} from '../core/workflow/engine/team-leader-finding-contract-operation-journal.js';
import {
  ExplicitPartFailureError,
  ManualRestartRequiredError,
  OperationJournalConflictError,
  OperationRecoveryBlockedError,
} from '../core/workflow/operations/operation-recovery-error.js';
import type {
  OperationJournalJsonValue,
  OperationJournalStore,
} from '../core/workflow/operations/operation-journal-types.js';
import type {
  FindingContractRecoveryAttemptEvent,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';
import {
  requestValidFindingContractControlOutput,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createContext(claimToken: string, sourceClaimToken?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-team-leader-operation-'));
  temporaryDirectories.push(cwd);
  const paths = buildRunPaths(cwd, 'run-a');
  return {
    context: {
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken,
      ...(sourceClaimToken === undefined ? {} : { sourceClaimTokens: new Set([sourceClaimToken]) }),
    },
    paths,
  };
}

function open(
  context: ReturnType<typeof createContext>['context'],
  stepIteration = 1,
): FindingContractOperationJournal {
  return FindingContractOperationJournal.open({
    context,
    workflowName: 'workflow',
    stepName: 'fix',
    stepIteration,
    executionScope: {
      runPathNamespace: [],
      workflowStack: [],
    },
  });
}

function workerRequest(
  instruction = 'repair finding',
  partId = 'p1',
) {
  return {
    partId,
    title: 'Repair finding',
    instruction,
    findingAssignment: {
      findingIds: ['F-0001'],
      role: 'repair' as const,
      readPaths: ['src/fix.ts'],
    },
  };
}

function orphanWorkerError(boundaryId = 'part:p1:completion'): ManualRestartRequiredError {
  return new ManualRestartRequiredError(
    `Worker boundary "${boundaryId}" stopped after dispatch and before its result was journaled`,
    { boundaryId },
  );
}

function explicitPartFailureError(
  boundaryId = 'part:p1:completion',
): ExplicitPartFailureError {
  return new ExplicitPartFailureError('part failed', { boundaryId });
}

function appliedPartResult(
  status: 'done' | 'error',
  partId = 'p1',
  errorMessage = 'preflight failed',
) {
  const request = workerRequest('repair finding', partId);
  return {
    part: {
      id: request.partId,
      title: request.title,
      instruction: request.instruction,
      findingContract: request.findingAssignment,
    },
    response: {
      persona: `fix.${partId}`,
      status,
      content: status === 'done' ? 'done' : '',
      ...(status === 'error' ? { error: errorMessage } : {}),
      timestamp: new Date('2026-08-01T00:00:00.000Z'),
    },
  };
}

function createSuccessorRaceStore(
  store: OperationJournalStore,
  winnerClaimToken: string,
  options?: {
    readonly mutateChildren?: (
      children: Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'],
    ) => Parameters<OperationJournalStore['createParentSuccessor']>[0]['children'];
    readonly afterCreate?: (
      store: OperationJournalStore,
      successor: ReturnType<OperationJournalStore['createParentSuccessor']>,
    ) => void;
  },
): OperationJournalStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'createParentSuccessor') {
        return (input: Parameters<OperationJournalStore['createParentSuccessor']>[0]) => {
          const successor = target.createParentSuccessor({
            ...input,
            successorClaimToken: winnerClaimToken,
            children: options?.mutateChildren?.(input.children) ?? input.children,
          });
          options?.afterCreate?.(target, successor);
          throw new OperationJournalConflictError('simulated successor publication race');
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function seedLegacyWorkerArtifact(): {
  readonly paths: ReturnType<typeof createContext>['paths'];
  readonly operation: FindingContractOperationJournal;
} {
  const { context, paths } = createContext('claim-a');
  const operation = open(context);
  let parent = operation.getParent();
  context.store.createChild({
    parentId: operation.parentId,
    owner: parent.owner,
    expectedParentRevision: parent.revision,
    expectedParentStage: parent.stage,
    id: 'decomposition',
    kind: 'finding_contract_decomposition',
    stage: 'completed',
    payload: {
      result: { parts: [] },
      completedAt: '2026-07-31T12:00:00.000Z',
    },
  });
  parent = operation.getParent();
  context.store.createChild({
    parentId: operation.parentId,
    owner: parent.owner,
    expectedParentRevision: parent.revision,
    expectedParentStage: parent.stage,
    id: 'part:p2:completion',
    kind: 'finding_contract_part_completion',
    stage: 'running',
    payload: {
      providerFallbackPending: true,
      rateLimitedResult: { response: { status: 'rate_limited' } },
      providerFallbackPendingAt: '2026-07-31T12:00:45.000Z',
    },
  });
  parent = operation.getParent();
  context.store.createChild({
    parentId: operation.parentId,
    owner: parent.owner,
    expectedParentRevision: parent.revision,
    expectedParentStage: parent.stage,
    id: 'part:p0:completion',
    kind: 'finding_contract_part_completion',
    stage: 'completed',
    payload: {
      result: { response: 'legacy completed result' },
      completedAt: '2026-07-31T12:00:30.000Z',
    },
  });
  parent = operation.getParent();
  context.store.createChild({
    parentId: operation.parentId,
    owner: parent.owner,
    expectedParentRevision: parent.revision,
    expectedParentStage: parent.stage,
    id: 'part:p1:completion',
    kind: 'finding_contract_part_completion',
    stage: 'worker_started',
    payload: {
      providerFallbackPending: false,
      workerStartedAt: '2026-07-31T12:01:00.000Z',
    },
  });
  const legacyError = new Error(
    'Worker boundary "part:p1:completion" stopped after dispatch and before its result was journaled',
  );
  legacyError.name = 'ManualRestartRequiredError';
  operation.terminate(legacyError);
  return { paths, operation };
}

function seedLegacyExplicitFailureAttempt2(options?: {
  readonly responseError?: string;
  readonly parentError?: string;
  readonly removeParentRecoveryMigration?: boolean;
  readonly addLegacyRecoveryLookalikeMarker?: boolean;
}): {
  readonly paths: ReturnType<typeof createContext>['paths'];
  readonly operationA: FindingContractOperationJournal;
  readonly operationB: FindingContractOperationJournal;
} {
  const { paths, operation: operationA } = seedLegacyWorkerArtifact();
  const store = createOperationJournalStore(paths.operationJournalAbs);
  const operationB = open({
    store,
    journalRunSlug: paths.slug,
    claimToken: 'claim-a466',
    sourceClaimTokens: new Set(['claim-a']),
  });
  const boundary = operationB.boundary(
    'part:p1:completion',
    'finding_contract_part_completion',
    workerRequest(),
  );
  const child = operationB.getChild(boundary.id);
  const childPayload = {
    ...(child.payload as Record<string, OperationJournalJsonValue>),
  };
  delete childPayload.dispatchState;
  const orphanRecovery = {
    ...(childPayload.orphanRecovery as Record<string, OperationJournalJsonValue>),
  };
  delete orphanRecovery.recoveryCode;
  if (options?.addLegacyRecoveryLookalikeMarker === true) {
    orphanRecovery.unexpectedMarker = true;
  }
  childPayload.orphanRecovery = orphanRecovery;
  operationB.updateChild(boundary.id, 'reserved', childPayload, child);
  boundary.markApplied(appliedPartResult(
    'error',
    'p1',
    options?.responseError ?? 'preflight failed',
  ));
  if (options?.removeParentRecoveryMigration === true) {
    const parent = operationB.getParent();
    const parentPayload = {
      ...(parent.payload as Record<string, OperationJournalJsonValue>),
    };
    const recoveryCause = {
      ...(parentPayload.recoveryCause as Record<string, OperationJournalJsonValue>),
    };
    delete recoveryCause.migration;
    parentPayload.recoveryCause = recoveryCause;
    store.compareAndSetParent({
      parentId: parent.id,
      owner: parent.owner,
      expectedRevision: parent.revision,
      expectedStage: parent.stage,
      nextStage: parent.stage,
      payload: parentPayload,
    });
  }
  operationB.terminate(new Error(options?.parentError ?? 'preflight failed'));
  return { paths, operationA, operationB };
}

function attemptEvent(
  type: 'started' | 'rejected' | 'accepted' | 'late',
  options?: {
    readonly attempt?: number;
    readonly sessionId?: string;
    readonly acceptedValue?: unknown;
  },
): FindingContractRecoveryAttemptEvent {
  const attempt = options?.attempt ?? 1;
  const rejectedOutput = {
    attempt,
    mode: 'normal' as const,
    issues: [{
      boundaryKind: 'part_completion' as const,
      code: 'shape.summary',
      category: 'shape' as const,
      path: 'summary',
      message: 'summary required',
      retryability: 'corrective_retry' as const,
    }],
    issueFingerprint: 'fingerprint',
    outputDigest: { hash: 'digest' },
    repeatCount: 1,
  };
  return {
    boundaryKind: 'part_completion',
    type,
    attempt,
    attemptToken: `part_completion:${attempt}`,
    mode: 'normal',
    elapsedMs: 100,
    remainingMs: 60_000,
    ...(type === 'rejected' ? { rejectedOutput } : {}),
    ...(type === 'rejected' || type === 'accepted' || type === 'late'
      ? {
          envelope: {
            raw: { corrected: true },
            attemptToken: `part_completion:${attempt}`,
            ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          },
        }
      : {}),
    ...(type === 'accepted'
      ? { acceptedValue: options?.acceptedValue ?? { corrected: true } }
      : {}),
    ...(type === 'late' ? { terminationReason: 'late_after_abort' as const } : {}),
  };
}

describe('Finding Contract Team Leader operation journal adapter', () => {
  it('restores an applied boundary and transfers ownership A to B to C', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    const boundaryA = operationA.boundary('part:p1:completion', 'finding_contract_part_completion');
    boundaryA.markWorkerStarted('edit');
    boundaryA.markApplied({ response: 'worker claim' });
    boundaryA.recordAttempt(attemptEvent('started'));
    boundaryA.recordAttempt(attemptEvent('rejected'));

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    const boundaryB = operationB.boundary('part:p1:completion', 'finding_contract_part_completion');
    expect(boundaryB.readApplied()).toEqual({ response: 'worker claim' });
    expect(boundaryB.recoveryResumeState()).toMatchObject({
      completedCalls: 1,
      mode: 'normal',
      rejectedOutputs: [expect.objectContaining({ issueFingerprint: 'fingerprint' })],
    });
    boundaryB.recordAttempt(attemptEvent('accepted'));
    expect(boundaryB.readAccepted()).toEqual({ corrected: true });
    boundaryB.complete({ response: 'accepted claim' });

    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-b']),
    });
    expect(
      operationC
        .boundary('part:p1:completion', 'finding_contract_part_completion')
        .readCompleted(),
    ).toEqual({ response: 'accepted claim' });
    expect(operationC.getParent().owner).toEqual({
      generation: 2,
      claimToken: 'claim-c',
    });
  });

  it('requires manual restart when worker dispatch has no durable result', () => {
    const { context } = createContext('claim-a');
    const boundary = open(context)
      .boundary('part:p1:completion', 'finding_contract_part_completion');
    boundary.markWorkerStarted('edit');

    expect(() => boundary.assertWorkerCanStart()).toThrow(ManualRestartRequiredError);
  });

  it('atomically materializes one immutable successor for a terminated orphan worker', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    const completedA = operationA.boundary('completed', 'finding_contract_part_completion');
    completedA.complete({ response: 'completed' });
    const appliedA = operationA.boundary('applied', 'finding_contract_part_completion');
    appliedA.markWorkerStarted('edit');
    appliedA.markApplied({ response: 'applied' });
    operationA.boundary('reserved', 'finding_contract_part_completion');
    const orphanA = operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    orphanA.markWorkerStarted('edit');
    expect(operationA.getChild('part:p1:completion').payload).toMatchObject({
      workerPermissionMode: 'edit',
    });
    operationA.terminate(new ManualRestartRequiredError(
      'localized typed recovery cause',
      { boundaryId: 'part:p1:completion' },
    ));
    expect(operationA.getParent().payload).toMatchObject({
      error: {
        recoveryCode: 'orphan_worker_after_dispatch',
        boundaryId: 'part:p1:completion',
      },
    });

    const resumeContext = {
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    };
    const operationB = open(resumeContext);
    expect(open(resumeContext).parentId).toBe(operationB.parentId);
    expect(context.store.listParents()).toHaveLength(2);
    expect(operationA.getParent().stage).toBe('terminated');
    expect(operationB.parentId).toBe(`${operationA.parentId}:attempt:2`);
    expect(operationB.getParent()).toMatchObject({
      stage: 'running',
      owner: { generation: 1, claimToken: 'claim-b' },
      payload: {
        predecessorParentId: operationA.parentId,
        recoveryCause: {
          recoveryCode: 'orphan_worker_after_dispatch',
          boundaryId: 'part:p1:completion',
        },
      },
    });
    expect(operationB.boundary('completed', 'finding_contract_part_completion').readCompleted())
      .toEqual({ response: 'completed' });
    expect(operationB.boundary('applied', 'finding_contract_part_completion').readApplied())
      .toEqual({ response: 'applied' });
    expect(operationB.boundary('reserved', 'finding_contract_part_completion').stage).toBe('reserved');
    const orphanB = operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    expect(orphanB.stage).toBe('reserved');
    expect(orphanB.orphanRecoveryInstruction('en')).toContain('partial edits may remain');
    expect(() => orphanB.assertWorkerCanStart()).not.toThrow();
    expect(() => orphanA.markApplied({ response: 'late' })).toThrow(/sealed/);
  });

  it('recovers a predecessor with a fresh owner and rejects a sibling without it', () => {
    const { context, paths } = createContext('claim-same-run');
    const predecessor = open(context);
    predecessor
      .boundary(
        'part:p1:completion',
        'finding_contract_part_completion',
        workerRequest(),
      )
      .markWorkerStarted('edit');
    predecessor.terminate(new ManualRestartRequiredError(
      'same-run worker interruption',
      { boundaryId: 'part:p1:completion' },
    ));

    const successor = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-next-run',
      sourceClaimTokens: new Set(['claim-same-run']),
    });

    expect(successor.parentId).toBe(`${predecessor.parentId}:attempt:2`);
    expect(successor.getParent()).toMatchObject({
      owner: { generation: 1, claimToken: 'claim-next-run' },
      payload: {
        operationAttempt: 2,
        predecessorParentId: predecessor.parentId,
      },
      children: [{ id: 'part:p1:completion', stage: 'reserved' }],
    });
    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-sibling',
      sourceClaimTokens: new Set(['claim-same-run']),
    })).toThrow(/not owned by the current resume source|owner changed/);
  });

  it('accepts a concurrently published successor only for the same lineage and claim', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());
    const store = createOperationJournalStore(paths.operationJournalAbs);

    const operationB = open({
      store: createSuccessorRaceStore(store, 'claim-b'),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });

    expect(operationB.parentId).toBe(`${operationA.parentId}:attempt:2`);
    expect(operationB.getParent().owner.claimToken).toBe('claim-b');
    expect(store.listParents()).toHaveLength(2);
  });

  it('rejects a concurrently published successor with a different child recovery plan', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());
    const store = createOperationJournalStore(paths.operationJournalAbs);

    expect(() => open({
      store: createSuccessorRaceStore(store, 'claim-b', {
        mutateChildren: (children) => children.map((child) => ({
          ...child,
          payload: child.id === 'part:p1:completion'
            ? { unexpected: 'different-plan' }
            : child.payload,
        })),
      }),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationJournalConflictError);
  });

  it('rejects a concurrently published successor whose child already advanced', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());
    const store = createOperationJournalStore(paths.operationJournalAbs);

    expect(() => open({
      store: createSuccessorRaceStore(store, 'claim-b', {
        afterCreate: (target, successor) => {
          const child = successor.children[0];
          if (child === undefined) throw new Error('Missing successor child');
          target.compareAndSetChild({
            parentId: successor.id,
            owner: successor.owner,
            expectedParentRevision: successor.revision,
            expectedParentStage: successor.stage,
            childId: child.id,
            expectedRevision: child.revision,
            expectedStage: child.stage,
            nextStage: 'worker_started',
            payload: child.payload,
          });
        },
      }),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationJournalConflictError);
  });

  it('retries a typed pre-dispatch applied error and reuses successful siblings', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary('decomposition', 'finding_contract_decomposition')
      .complete({ parts: [] });
    operationA.boundary(
      'part:done:completion',
      'finding_contract_part_completion',
      workerRequest('repair finding', 'done'),
    ).complete(appliedPartResult('done', 'done'));
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markApplied(appliedPartResult('error'));
    operationA.terminate(explicitPartFailureError());

    const resumeContext = {
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-b-never-owned', 'claim-a']),
    };
    const operationB = open(resumeContext);
    expect(open(resumeContext).parentId).toBe(operationB.parentId);
    expect(context.store.listParents()).toHaveLength(2);
    expect(operationB.getChild('decomposition').stage).toBe('completed');
    expect(operationB.getChild('part:done:completion').stage).toBe('completed');
    const failed = operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    expect(failed.stage).toBe('reserved');
    expect(failed.readApplied()).toBeUndefined();
    expect(failed.orphanRecoveryInstruction('en')).toContain('fresh session');
    expect(operationB.getChild(failed.id).payload).toMatchObject({
      dispatchState: 'not_dispatched',
      orphanRecovery: {
        disposition: 'explicit_retry',
        recoveryCode: 'explicit_part_failure',
      },
    });
  });

  it('migrates exactly one legacy untyped applied error through an ancestor owner token', () => {
    const { paths, operationA } = seedLegacyExplicitFailureAttempt2();

    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-fc0-never-owned', 'claim-a466', 'claim-a']),
    });
    expect(operationC.parentId).toBe(`${operationA.parentId}:attempt:3`);
    expect(operationC.getParent().payload).toMatchObject({
      recoveryCause: { migration: 'legacy_untyped_part_failure_v1' },
    });
    expect(operationC.getChild('part:p1:completion')).toMatchObject({
      stage: 'reserved',
      payload: {
        orphanRecovery: { migration: 'legacy_untyped_part_failure_v1' },
      },
    });
  });

  it('does not migrate an untyped applied error on attempt 1', () => {
    const { context, paths } = createContext('claim-a');
    const operation = open(context);
    operation.boundary('decomposition', 'finding_contract_decomposition').complete({ parts: [] });
    const boundary = operation.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    const child = operation.getChild(boundary.id);
    const payload = { ...(child.payload as Record<string, OperationJournalJsonValue>) };
    delete payload.dispatchState;
    operation.updateChild(boundary.id, 'reserved', payload, child);
    boundary.markApplied(appliedPartResult('error'));
    operation.terminate(new Error('preflight failed'));

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationRecoveryBlockedError);
  });

  it.each([
    ['message mismatch', { parentError: 'different error' }],
    ['missing recovery migration', { removeParentRecoveryMigration: true }],
    ['an extra legacy recovery marker', { addLegacyRecoveryLookalikeMarker: true }],
  ] as const)('does not migrate attempt 2 with %s', (_label, options) => {
    const { paths } = seedLegacyExplicitFailureAttempt2(options);
    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-a466']),
    })).toThrow(OperationRecoveryBlockedError);
  });

  it('does not migrate an untyped applied error on attempt 3', () => {
    const { paths, operationA } = seedLegacyExplicitFailureAttempt2();
    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-a466']),
    });
    const boundary = operationC.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    const child = operationC.getChild(boundary.id);
    const payload = { ...(child.payload as Record<string, OperationJournalJsonValue>) };
    delete payload.dispatchState;
    operationC.updateChild(boundary.id, 'reserved', payload, child);
    boundary.markApplied(appliedPartResult('error'));
    operationC.terminate(new Error('preflight failed'));

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-d',
      sourceClaimTokens: new Set(['claim-c']),
    })).toThrow(OperationRecoveryBlockedError);
    expect(operationC.parentId).toBe(`${operationA.parentId}:attempt:3`);
  });

  it('requires the latest operation owner to belong to the direct resume ancestry', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary('decomposition', 'finding_contract_decomposition')
      .complete({ parts: [] });
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markApplied(appliedPartResult('error'));
    operationA.terminate(new Error('legacy untyped failure'));

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['sibling-claim']),
    })).toThrow(/not owned by the current resume source/);
  });

  it('reconciles post-dispatch edit failures and blocks inconsistent dispatch evidence', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    const boundaryA = operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    boundaryA.markWorkerStarted('edit');
    boundaryA.markApplied(appliedPartResult('error'));
    operationA.terminate(explicitPartFailureError());

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    expect(operationB.getChild('part:p1:completion').payload).toMatchObject({
      orphanRecovery: { disposition: 'workspace_reconciliation' },
    });

    const operationC = open(context, 2);
    const boundaryC = operationC.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    boundaryC.markApplied(appliedPartResult('error'));
    const child = operationC.getChild(boundaryC.id);
    operationC.updateChild(boundaryC.id, 'applied', {
      ...(child.payload as Record<string, never>),
      dispatchState: 'dispatched',
    }, child);
    operationC.terminate(explicitPartFailureError());
    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-d',
      sourceClaimTokens: new Set(['claim-a']),
    }, 2)).toThrow(/inconsistent dispatch evidence/);
  });

  it('retries a dispatched readonly error but blocks a dispatched full-permission error', () => {
    const readonlySeed = createContext('claim-readonly');
    const readonlyOperation = open(readonlySeed.context);
    const readonlyBoundary = readonlyOperation.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    readonlyBoundary.markWorkerStarted('readonly');
    readonlyBoundary.markApplied(appliedPartResult('error'));
    readonlyOperation.terminate(explicitPartFailureError());
    const readonlySuccessor = open({
      store: createOperationJournalStore(readonlySeed.paths.operationJournalAbs),
      journalRunSlug: readonlySeed.paths.slug,
      claimToken: 'claim-readonly-next',
      sourceClaimTokens: new Set(['claim-readonly']),
    });
    expect(readonlySuccessor.getChild(readonlyBoundary.id).payload).toMatchObject({
      orphanRecovery: { disposition: 'explicit_retry' },
    });

    const fullSeed = createContext('claim-full');
    const fullOperation = open(fullSeed.context);
    const fullBoundary = fullOperation.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    fullBoundary.markWorkerStarted('full');
    fullBoundary.markApplied(appliedPartResult('error'));
    fullOperation.terminate(explicitPartFailureError());
    expect(() => open({
      store: createOperationJournalStore(fullSeed.paths.operationJournalAbs),
      journalRunSlug: fullSeed.paths.slug,
      claimToken: 'claim-full-next',
      sourceClaimTokens: new Set(['claim-full']),
    })).toThrow(/full-permission dispatch/);
  });

  it('blocks a typed explicit failure while another dispatched worker is unsettled', () => {
    const { context, paths } = createContext('claim-a');
    const operation = open(context);
    const failed = operation.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    failed.markApplied(appliedPartResult('error'));
    operation.boundary(
      'part:p2:completion',
      'finding_contract_part_completion',
      workerRequest('repair finding', 'p2'),
    ).markWorkerStarted('edit');
    operation.terminate(explicitPartFailureError());

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(/another unsettled worker boundary/);
  });

  it('rejects a concurrently published successor owned by another claim', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());

    expect(() => open({
      store: createSuccessorRaceStore(
        createOperationJournalStore(paths.operationJournalAbs),
        'claim-c',
      ),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationJournalConflictError);
  });

  it('keeps a provider-fallback sibling unchanged while reserving the orphan sibling', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    const fallbackA = operationA.boundary(
      'part:p2:completion',
      'finding_contract_part_completion',
    );
    fallbackA.markWorkerStarted('edit');
    fallbackA.markProviderFallbackPending({ response: { status: 'rate_limited' } });
    const fallbackSnapshot = operationA.getChild('part:p2:completion');
    operationA.terminate(orphanWorkerError());

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });

    expect(operationB.getChild('part:p1:completion').stage).toBe('reserved');
    expect(operationB.getChild('part:p2:completion')).toMatchObject({
      stage: fallbackSnapshot.stage,
      payload: fallbackSnapshot.payload,
    });
  });

  it('binds and redispatches the real legacy artifact shape after an effective edit recheck', () => {
    const { paths, operation: operationA } = seedLegacyWorkerArtifact();
    expect(operationA.getChild('decomposition')).toMatchObject({ stage: 'completed' });
    expect(operationA.getChild('part:p1:completion').payload).toEqual({
      providerFallbackPending: false,
      workerStartedAt: '2026-07-31T12:01:00.000Z',
    });
    expect((operationA.getParent().payload as { error: unknown }).error).toEqual({
      name: 'ManualRestartRequiredError',
      message: 'Worker boundary "part:p1:completion" stopped after dispatch and before its result was journaled',
    });
    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    expect(operationB.getChild('decomposition')).toMatchObject({ stage: 'completed' });
    expect(operationB.getChild('part:p0:completion')).toMatchObject({
      stage: 'completed',
      payload: {
        result: { response: 'legacy completed result' },
        legacyRequestDigestBinding: 'pending',
      },
    });
    const completedBoundary = operationB.boundary(
      'part:p0:completion',
      'finding_contract_part_completion',
      workerRequest('completed legacy repair', 'p0'),
    );
    expect(completedBoundary.readCompleted()).toEqual({ response: 'legacy completed result' });
    expect(operationB.getChild('part:p0:completion').payload).toMatchObject({
      requestDigest: expect.any(String),
    });
    expect(operationB.getChild('part:p0:completion').payload)
      .not.toHaveProperty('legacyRequestDigestBinding');
    const fallbackBeforeBind = operationB.getChild('part:p2:completion');
    expect(fallbackBeforeBind).toMatchObject({
      stage: 'running',
      payload: {
        providerFallbackPending: true,
        rateLimitedResult: { response: { status: 'rate_limited' } },
        legacyRequestDigestBinding: 'pending',
      },
    });
    operationB.boundary(
      'part:p2:completion',
      'finding_contract_part_completion',
      workerRequest('fallback legacy repair', 'p2'),
    );
    expect(operationB.getChild('part:p2:completion')).toMatchObject({
      stage: fallbackBeforeBind.stage,
      payload: {
        providerFallbackPending: true,
        rateLimitedResult: { response: { status: 'rate_limited' } },
        requestDigest: expect.any(String),
      },
    });
    expect(operationB.getChild('part:p2:completion').payload)
      .not.toHaveProperty('legacyRequestDigestBinding');
    expect(operationB.getChild('part:p1:completion').payload).toMatchObject({
      legacyRequestDigestBinding: 'pending',
      orphanRecovery: {
        disposition: 'legacy_permission_recheck',
        priorPermissionEvidence: 'unavailable_legacy_artifact',
      },
    });
    expect(operationB.getChild('part:p1:completion').payload).not.toHaveProperty('requestDigest');
    expect(() => operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
    ).markWorkerStarted('edit')).toThrow(OperationRecoveryBlockedError);
    const migratedBoundary = operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    const boundChild = operationB.getChild('part:p1:completion');
    expect(boundChild.payload).toMatchObject({ requestDigest: expect.any(String) });
    expect(boundChild.payload).not.toHaveProperty('legacyRequestDigestBinding');
    operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    );
    expect(operationB.getChild('part:p1:completion').revision).toBe(boundChild.revision);
    expect(() => operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest('different legacy assignment'),
    )).toThrow(/request digest does not match/);
    expect(migratedBoundary.orphanRecoveryInstruction('en')).toContain('partial edits may remain');
    migratedBoundary.markWorkerStarted('edit');
    expect(operationB.getChild('part:p1:completion')).toMatchObject({
      stage: 'worker_started',
      payload: {
        workerPermissionMode: 'edit',
        orphanRecovery: { disposition: 'workspace_reconciliation' },
      },
    });
  });

  it.each(['readonly', 'full', undefined] as const)(
    'blocks the legacy artifact before dispatch when current permission is %s',
    (permissionMode) => {
      const { paths } = seedLegacyWorkerArtifact();
      const operationB = open({
        store: createOperationJournalStore(paths.operationJournalAbs),
        journalRunSlug: paths.slug,
        claimToken: 'claim-b',
        sourceClaimTokens: new Set(['claim-a']),
      });
      const migratedBoundary = operationB.boundary(
        'part:p1:completion',
        'finding_contract_part_completion',
        workerRequest(),
      );

      expect(() => migratedBoundary.markWorkerStarted(permissionMode))
        .toThrow(OperationRecoveryBlockedError);
      expect(operationB.getChild('part:p1:completion')).toMatchObject({
        stage: 'reserved',
        payload: {
          orphanRecovery: { disposition: 'legacy_permission_recheck' },
        },
      });
    },
  );

  it('recognizes the generic legacy error shape only on the initial attempt', () => {
    const { paths } = seedLegacyWorkerArtifact();
    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    const legacyError = new Error('another generic legacy failure');
    legacyError.name = 'ManualRestartRequiredError';
    operationB.terminate(legacyError);

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-b']),
    })).toThrow(OperationRecoveryBlockedError);
  });

  it('fails fast when a successor worker request digest changes', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());
    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });

    expect(() => operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest('repair a different finding'),
    )).toThrow(/request digest does not match/);
  });

  it('does not bind a missing request digest outside the legacy migration disposition', () => {
    const { context } = createContext('claim-a');
    const operation = open(context);
    operation.boundary('part:p1:completion', 'finding_contract_part_completion');

    expect(() => operation.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    )).toThrow(/request digest does not match/);
  });

  it('does not inherit a predecessor from another step iteration', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context, 1);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());

    const nextIteration = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    }, 2);

    expect(nextIteration.parentId).not.toContain(':attempt:');
    expect(nextIteration.getParent().children).toEqual([]);
  });

  it('creates the next unique successor after the redispatched worker crashes again', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError());
    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationB.terminate(orphanWorkerError());

    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-b']),
    });

    expect(operationC.parentId).toBe(`${operationA.parentId}:attempt:3`);
    expect(context.store.listParents().map((parent) => parent.id)).toEqual([
      operationA.parentId,
      `${operationA.parentId}:attempt:2`,
      `${operationA.parentId}:attempt:3`,
    ]);
  });

  it('does not create a typed successor when the prior worker lacked edit permission', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest('inspect only'),
    ).markWorkerStarted('readonly');
    operationA.terminate(orphanWorkerError());
    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationRecoveryBlockedError);
    expect(context.store.listParents()).toHaveLength(1);
  });

  it.each(['readonly', 'full', undefined] as const)(
    'blocks a typed successor when current permission is %s',
    (permissionMode) => {
      const { context, paths } = createContext('claim-a');
      const operationA = open(context);
      operationA.boundary(
        'part:p1:completion',
        'finding_contract_part_completion',
        workerRequest(),
      ).markWorkerStarted('edit');
      operationA.terminate(orphanWorkerError());
      const operationB = open({
        store: createOperationJournalStore(paths.operationJournalAbs),
        journalRunSlug: paths.slug,
        claimToken: 'claim-b',
        sourceClaimTokens: new Set(['claim-a']),
      });
      const boundary = operationB.boundary(
        'part:p1:completion',
        'finding_contract_part_completion',
        workerRequest(),
      );

      expect(() => boundary.markWorkerStarted(permissionMode))
        .toThrow(OperationRecoveryBlockedError);
      expect(boundary.stage).toBe('reserved');
    },
  );

  it('does not create a successor for an unrecognized terminal cause', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
      workerRequest(),
    ).markWorkerStarted('edit');
    operationA.terminate(orphanWorkerError('part:missing:completion'));

    expect(() => open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    })).toThrow(OperationRecoveryBlockedError);
    expect(context.store.listParents()).toHaveLength(1);
  });

  it('redispatches a rate-limited worker through the same durable boundary', () => {
    const { context } = createContext('claim-a');
    const boundary = open(context)
      .boundary('part:p1:completion', 'finding_contract_part_completion');
    boundary.markWorkerStarted('edit');
    boundary.markProviderFallbackPending({
      response: { status: 'rate_limited' },
      providerInfo: { provider: 'codex' },
    });

    expect(boundary.stage).toBe('running');
    expect(boundary.readCompleted()).toBeUndefined();
    expect(() => boundary.assertWorkerCanStart()).not.toThrow();

    boundary.markWorkerStarted('edit');
    expect(() => boundary.assertWorkerCanStart()).toThrow(ManualRestartRequiredError);

    boundary.markApplied({
      response: { status: 'done' },
      providerInfo: { provider: 'claude' },
    });
    boundary.complete({ response: { status: 'done' } });

    expect(boundary.readCompleted()).toEqual({ response: { status: 'done' } });
  });

  it('allows only raw/applied child settlement while the parent is terminating', () => {
    const { context } = createContext('claim-a');
    const operation = open(context);
    const lateWorker = operation.boundary(
      'part:late:completion',
      'finding_contract_part_completion',
    );
    const acceptedWorker = operation.boundary(
      'part:accepted:completion',
      'finding_contract_part_completion',
    );
    lateWorker.markWorkerStarted('edit');
    acceptedWorker.markWorkerStarted('edit');

    operation.beginTermination(new Error('terminal sibling'));
    lateWorker.markApplied({ response: 'late raw result' });

    expect(lateWorker.readApplied()).toEqual({ response: 'late raw result' });
    expect(() => acceptedWorker.recordAttempt(attemptEvent('accepted')))
      .toThrow(/only permits raw\/applied child publication while terminating/);
    expect(() => acceptedWorker.complete({ response: 'must not publish' }))
      .toThrow(/only permits raw\/applied child publication while terminating/);

    operation.terminate(new Error('terminal sibling'));
    expect(operation.getParent().stage).toBe('terminated');
  });

  it('resumes a rejected correction from its latest durable session before advancing to C', async () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    const boundaryA = operationA.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
    );
    boundaryA.recordAttempt(attemptEvent('started'));
    boundaryA.recordAttempt(attemptEvent('rejected', { sessionId: 'session-b' }));

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    const boundaryB = operationB.boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
    );
    const resumeState = boundaryB.recoveryResumeState();
    let correctionSession = resumeState?.latestSessionId;

    await requestValidFindingContractControlOutput({
      resumeState,
      adapter: {
        boundaryKind: 'part_completion',
        requestOnce: async ({ attemptToken }) => {
          expect(correctionSession).toBe('session-b');
          return {
            raw: { corrected: true },
            attemptToken,
            sessionId: 'session-c',
          };
        },
        validate: (envelope) => envelope.raw,
      },
      onAttempt: (event) => {
        if (event.envelope?.sessionId !== undefined) {
          correctionSession = event.envelope.sessionId;
        }
        boundaryB.recordAttempt(event);
      },
    });

    expect(correctionSession).toBe('session-c');
    expect(boundaryB.recoveryResumeState()).toMatchObject({
      latestSessionId: 'session-c',
      completedCalls: 2,
    });
  });

  it('clears a stale durable session when a new recovery response has no session ID', () => {
    const { context } = createContext('claim-a');
    const boundary = open(context).boundary(
      'part:p1:completion',
      'finding_contract_part_completion',
    );
    boundary.recordAttempt(attemptEvent('started'));
    boundary.recordAttempt(attemptEvent('rejected', { sessionId: 'session-b' }));
    boundary.recordAttempt(attemptEvent('started', { attempt: 2 }));
    boundary.recordAttempt(attemptEvent('rejected', { attempt: 2 }));

    expect(boundary.recoveryResumeState()).not.toHaveProperty('latestSessionId');
  });

  it('replays a result-ready parent until a transition receipt is durably authored', () => {
    const { context, paths } = createContext('claim-a');
    const operationA = open(context);
    operationA.markResultReady({ response: 'complete decision' });

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimTokens: new Set(['claim-a']),
    });
    expect(operationB.readResultReady()).toEqual({ response: 'complete decision' });
    operationB.completeTransition({ kind: 'next_step', nextStep: 'COMPLETE' });

    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimTokens: new Set(['claim-b']),
    });
    expect(operationC.readResultReady()).toEqual({ response: 'complete decision' });
    expect(() => operationC.completeTransition({
      kind: 'next_step',
      nextStep: 'COMPLETE',
    })).not.toThrow();
    expect(operationC.getParent().stage).toBe('completed');
  });

  it('keeps late publication fenced after the parent terminal latch', () => {
    const { context } = createContext('claim-a');
    const operation = open(context);
    const boundary = operation.boundary('feedback:1', 'finding_contract_decision');
    boundary.recordAttempt(attemptEvent('started'));
    operation.terminate(new Error('terminal'));

    expect(() => boundary.recordAttempt(attemptEvent('late'))).not.toThrow();
    expect(operation.getChild('feedback:1').attempts).toHaveLength(1);
  });

  it('separates identical steps in different workflow execution scopes', () => {
    const { context } = createContext('claim-a');
    open(context);
    FindingContractOperationJournal.open({
      context,
      workflowName: 'workflow',
      stepName: 'fix',
      stepIteration: 1,
      executionScope: {
        runPathNamespace: ['subworkflows', 'other-call'],
        workflowStack: [],
      },
    });

    const parents = context.store.listParents();
    expect(parents).toHaveLength(2);
    expect(new Set(parents.map((parent) => parent.id)).size).toBe(2);
  });
});
