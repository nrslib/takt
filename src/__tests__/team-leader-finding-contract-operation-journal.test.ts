import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createOperationJournalStore } from '../infra/workflow/operation-journal-store.js';
import {
  FindingContractOperationJournal,
} from '../core/workflow/engine/team-leader-finding-contract-operation-journal.js';
import { ManualRestartRequiredError } from '../core/workflow/operations/operation-recovery-error.js';
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
      ...(sourceClaimToken === undefined ? {} : { sourceClaimToken }),
    },
    paths,
  };
}

function open(
  context: ReturnType<typeof createContext>['context'],
): FindingContractOperationJournal {
  return FindingContractOperationJournal.open({
    context,
    workflowName: 'workflow',
    stepName: 'fix',
    stepIteration: 1,
    executionScope: {
      runPathNamespace: [],
      workflowStack: [],
    },
  });
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
    boundaryA.markWorkerStarted();
    boundaryA.markApplied({ response: 'worker claim' });
    boundaryA.recordAttempt(attemptEvent('started'));
    boundaryA.recordAttempt(attemptEvent('rejected'));

    const operationB = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-b',
      sourceClaimToken: 'claim-a',
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
      sourceClaimToken: 'claim-b',
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
    boundary.markWorkerStarted();

    expect(() => boundary.assertWorkerCanStart()).toThrow(ManualRestartRequiredError);
  });

  it('redispatches a rate-limited worker through the same durable boundary', () => {
    const { context } = createContext('claim-a');
    const boundary = open(context)
      .boundary('part:p1:completion', 'finding_contract_part_completion');
    boundary.markWorkerStarted();
    boundary.markProviderFallbackPending({
      response: { status: 'rate_limited' },
      providerInfo: { provider: 'codex' },
    });

    expect(boundary.stage).toBe('running');
    expect(boundary.readCompleted()).toBeUndefined();
    expect(() => boundary.assertWorkerCanStart()).not.toThrow();

    boundary.markWorkerStarted();
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
    lateWorker.markWorkerStarted();
    acceptedWorker.markWorkerStarted();

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
      sourceClaimToken: 'claim-a',
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
      sourceClaimToken: 'claim-a',
    });
    expect(operationB.readResultReady()).toEqual({ response: 'complete decision' });
    operationB.completeTransition({ kind: 'next_step', nextStep: 'COMPLETE' });

    const operationC = open({
      store: createOperationJournalStore(paths.operationJournalAbs),
      journalRunSlug: paths.slug,
      claimToken: 'claim-c',
      sourceClaimToken: 'claim-b',
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
