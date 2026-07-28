import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { resumePendingManagerCommit } from '../core/workflow/findings/manager-commit.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingManagerReportPublication } from '../core/workflow/findings/types.js';
import { resumeRunStorage } from '../infra/run-storage/root.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  createTestBootstrapSeed,
  resumeRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

interface PendingRun {
  readonly store: FindingLedgerStore;
  readonly publication: FindingManagerReportPublication;
  readonly roundMarker: string;
}

function stagePendingPublication(
  root: ReturnType<typeof createRealRunStorage>['root'],
): Promise<PendingRun> {
  const owner = root.claimLease({
    ownerKey: 'parent-owner',
    leaseDurationMs: 10_000,
  });
  const runtime = root.runtime({ lease: owner });
  const execution = runtime.execution.startStep({
    stepKey: 'findings-manager',
    expectedScopeRevision: 0,
  });
  const store = runtime.findingManager({
    workflowName: 'default',
    producer: execution.handle,
  });
  const roundMarker = 'round-resume-chain';
  const publication = store.planManagerValidationPublication(roundMarker, {
    version: 1,
    runId: store.runId,
    stepName: 'reviewers',
    retryCount: 0,
    ledgerUpdated: true,
    finalErrors: [],
    attempts: [],
  });
  return store.commitManagerLedger((current) => ({
    ledger: {
      ...current,
      stopBudget: {
        roundMarkers: [roundMarker],
        firstRoundAt: current.updatedAt,
        exhausted: false,
      },
    },
    publication: {
      roundMarker,
      report: publication.report,
    },
    result: undefined,
  })).then(() => ({ store, publication, roundMarker }));
}

function findingStore(
  root: ReturnType<typeof createRealRunStorage>['root'],
  ownerKey: string,
): FindingLedgerStore {
  const owner = root.claimLease({
    ownerKey,
    leaseDurationMs: 10_000,
  });
  const runtime = root.runtime({ lease: owner });
  const execution = runtime.execution.startStep({
    stepKey: 'findings-manager',
    expectedScopeRevision: 0,
  });
  return runtime.findingManager({
    workflowName: 'default',
    producer: execution.handle,
  });
}

describe('SQLite Finding resume authority', () => {
  it('import済みparallel scopeをidentity検証付きで再利用する', () => {
    const source = createRealRunStorage({ findingContractEnabled: true });
    const sourceLease = source.root.claimLease({
      ownerKey: 'parallel-source',
      leaseDurationMs: 10_000,
    });
    source.root.runtime({ lease: sourceLease }).scopes.createParallelChild({
      scopeKey: 'reviewers',
    });
    source.root.finishRun(sourceLease, {
      status: 'failed',
      failureReason: 'resume source failed',
      publication: {
        status: 'failed',
        iteration: 1,
        reason: 'resume source failed',
        payload: '{}',
      },
    });

    const target = resumeRealRunStorage(source.root, {
      slug: 'parallel-target',
      findingContractEnabled: true,
    });
    const targetLease = target.root.claimLease({
      ownerKey: 'parallel-target',
      leaseDurationMs: 10_000,
    });
    const runtime = target.root.runtime({ lease: targetLease });
    const scopeCount = runtime.scopes.list().length;

    runtime.scopes.resolveParallelChild({ scopeKey: 'reviewers' });

    expect(runtime.scopes.list()).toHaveLength(scopeCount);
    target.root.finishRun(targetLease, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    });
    expect(target.root.readResumeSnapshot().scopes.every(
      (scope) => scope.runtime.status === 'completed',
    )).toBe(true);
    target.root.close();
    source.root.close();
  });

  it('uses each multi-hop direct parent and preserves publication intent through finalization', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    const pending = await stagePendingPublication(parent.root);
    const child = resumeRealRunStorage(parent.root, {
      slug: 'run-child',
      findingContractEnabled: true,
    });
    const childStore = findingStore(child.root, 'child-owner');
    const childRun = child.root.readResumeSnapshot().run;
    const childRunId = childRun.runId;
    const childPublication = childStore.bindManagerValidationPublication(
      pending.roundMarker,
      pending.publication,
    );
    await childStore.rebindPendingManagerValidationPublication(childPublication);

    const grandchild = resumeRealRunStorage(child.root, {
      slug: 'run-grandchild',
      findingContractEnabled: true,
    });
    const grandchildStore = findingStore(grandchild.root, 'grandchild-owner');
    const grandchildRunSlug = grandchild.root.readResumeSnapshot().run.runId;
    const importedPublication = grandchildStore.loadLedger()
      .pendingManagerCommit!.publication;
    expect(importedPublication.destinationRunId).toBe(childRunId);
    await expect(grandchildStore.rebindPendingManagerValidationPublication({
      ...importedPublication,
      destinationRunId: pending.publication.destinationRunId,
    })).rejects.toThrow(/not authorized for pending rebind/i);

    const grandchildPublication = grandchildStore.bindManagerValidationPublication(
      pending.roundMarker,
      importedPublication,
    );
    expect(grandchildPublication).toMatchObject({
      publicationId: pending.publication.publicationId,
      domainId: pending.publication.domainId,
      originRunId: pending.publication.originRunId,
      destinationRunId: grandchildRunSlug,
      contentSha256: pending.publication.contentSha256,
      report: pending.publication.report,
    });
    await grandchildStore.rebindPendingManagerValidationPublication(
      grandchildPublication,
    );
    const finalized = await resumePendingManagerCommit(
      { ledgerStore: grandchildStore } as never,
      grandchildStore.loadLedger(),
    );
    expect(finalized?.completedRoundMarker).toBe(pending.roundMarker);
    expect(grandchildStore.loadLedger().pendingManagerCommit).toBeUndefined();
    const grandchildSnapshot = grandchild.root.readResumeSnapshot();
    expect(grandchildSnapshot.reports).toContainEqual(expect.objectContaining({
      streamName: pending.publication.fileName,
      publicationKey: pending.publication.publicationId,
      digest: pending.publication.contentSha256,
    }));
    expect(grandchildSnapshot.ancestry).toEqual([
      expect.objectContaining({ ancestorRunId: childRunId, depth: 1 }),
      expect.objectContaining({
        ancestorRunId: parent.root.readResumeSnapshot().run.runId,
        depth: 2,
      }),
    ]);
  });

  it('lets a workflow_call sharing root authority finish a resumed pending publication', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    const pending = await stagePendingPublication(parent.root);
    const child = resumeRealRunStorage(parent.root, {
      slug: 'run-workflow-call-resume',
      findingContractEnabled: true,
    });
    const owner = child.root.claimLease({
      ownerKey: 'workflow-call-resume-owner',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.root.runtime({ lease: owner });
    const workflowScope = rootRuntime.scopes.createWorkflowCallChild({
      scopeKey: 'resume-publication',
      workflowDefinition: {
        name: 'child-workflow',
        codecName: 'json-v1',
        definition: '{"name":"child-workflow"}',
      },
    });
    const workflowRuntime = child.root.runtime({
      lease: owner,
      scope: workflowScope,
    });
    const execution = workflowRuntime.execution.startStep({
      stepKey: 'child-findings-manager',
      expectedScopeRevision: 0,
    });
    const store = workflowRuntime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });

    const finalized = await resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    );

    expect(finalized?.completedRoundMarker).toBe(pending.roundMarker);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
    expect(child.root.readResumeSnapshot().reports).toContainEqual(
      expect.objectContaining({
        publicationKey: pending.publication.publicationId,
      }),
    );
  });

  it('does not grant root resume authority to an independent parallel ledger', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    const pending = await stagePendingPublication(parent.root);
    const child = resumeRealRunStorage(parent.root, {
      slug: 'run-parallel-resume',
      findingContractEnabled: true,
    });
    const owner = child.root.claimLease({
      ownerKey: 'parallel-resume-owner',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.root.runtime({ lease: owner });
    const parallelScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'independent-review',
    });
    const parallelRuntime = child.root.runtime({
      lease: owner,
      scope: parallelScope,
    });
    const execution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-review',
      expectedScopeRevision: 0,
    });
    const store = parallelRuntime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });

    expect(() => store.bindManagerValidationPublication(
      pending.roundMarker,
      pending.publication,
    )).toThrow(/does not match|integrity validation/i);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
  });

  it('keeps the parent immutable and publishes no child database when import validation fails', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    await stagePendingPublication(parent.root);
    const parentState = parent.root.readResumeSnapshot();
    const parentBytes = readFileSync(parent.databasePath);
    const failedDatabasePath = `${parent.databasePath}.invalid-child`;

    expect(() => resumeRunStorage({
      databasePath: failedDatabasePath,
      source: parent.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'invalid-child-session',
      }),
      run: {
        runId: 'run-invalid-child',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    })).toThrow(/Finding Contract does not match/i);
    expect(existsSync(failedDatabasePath)).toBe(false);
    expect(parent.root.readResumeSnapshot()).toEqual(parentState);
    expect(readFileSync(parent.databasePath)).toEqual(parentBytes);
  });

  it('rejects an ancestor skip when the direct parent has not rebound the pending publication', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    await stagePendingPublication(parent.root);
    const child = resumeRealRunStorage(parent.root, {
      slug: 'run-unbound-child',
      findingContractEnabled: true,
    });
    const skippedDatabasePath = `${child.databasePath}.skipped`;
    const childState = child.root.readResumeSnapshot();

    expect(() => resumeRunStorage({
      databasePath: skippedDatabasePath,
      source: child.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'skipped-grandchild-session',
      }),
      run: {
        runId: 'run-skipped-grandchild',
        findingContractEnabled: true,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    })).toThrow(/failed resume provenance validation/i);
    expect(existsSync(skippedDatabasePath)).toBe(false);
    expect(child.root.readResumeSnapshot()).toEqual(childState);
  });

  it('rejects forged resume roots before creating a database', () => {
    const target = createRealRunStorage();
    target.root.close();

    expect(() => resumeRunStorage({
      databasePath: `${target.databasePath}.forged`,
      source: Object.freeze({}) as never,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'forged-child-session',
      }),
      run: {
        runId: 'forged-child',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    })).toThrow(/resume source is forged/i);
    expect(existsSync(`${target.databasePath}.forged`)).toBe(false);
  });

  it('does not trust an overridden public snapshot reader on a live source root', () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const sourceRunId = source.root.readResumeSnapshot().run.runId;
    Reflect.set(source.root, 'readResumeSnapshot', () => ({
      run: { runId: 'forged-source-run' },
    }));
    const childDatabasePath = `${source.databasePath}.trusted-child`;
    const child = resumeRunStorage({
      databasePath: childDatabasePath,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'trusted-child-session',
      }),
      run: {
        runId: 'trusted-child',
        findingContractEnabled: false,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: '{"name":"default"}',
      },
    });

    expect(child.readResumeSnapshot().ancestry).toEqual([
      expect.objectContaining({ ancestorRunId: sourceRunId, depth: 1 }),
    ]);
    child.close();
  });

  it('shares the parent Finding authority with workflow_call scopes', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'workflow-owner',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const childScope = rootRuntime.scopes.createWorkflowCallChild({
      scopeKey: 'child',
      workflowDefinition: {
        name: 'child',
        codecName: 'json-v1',
        definition: '{"name":"child"}',
      },
    });
    const childRuntime = root.runtime({ lease: owner, scope: childScope });
    const execution = childRuntime.execution.startStep({
      stepKey: 'child-review',
      expectedScopeRevision: 0,
    });
    const childStore = childRuntime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    expect(() => childRuntime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
      trustedResumeSource: Object.freeze({}),
    } as never)).toThrow(/unknown run storage command field/i);

    await childStore.updateLedger((current) => ({
      ledger: { ...current, nextId: 2 },
      result: undefined,
    }));
    expect(root.readResumeSnapshot().findingHeads).toHaveLength(1);
    const rootExecution = rootRuntime.execution.startStep({
      stepKey: 'root-review',
      expectedScopeRevision: 0,
    });
    expect(rootRuntime.findingManager({
      workflowName: 'default',
      producer: rootExecution.handle,
    }).loadLedger().nextId).toBe(2);
  });
});
