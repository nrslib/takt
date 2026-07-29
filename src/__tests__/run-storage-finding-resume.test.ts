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
  workflowName = 'default',
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
    workflowName,
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
    expect(childPublication.destinationRunId).toBe(childRunId);

    const grandchild = resumeRealRunStorage(child.root, {
      slug: 'run-grandchild',
      findingContractEnabled: true,
    });
    const grandchildStore = findingStore(grandchild.root, 'grandchild-owner');
    const grandchildRunSlug = grandchild.root.readResumeSnapshot().run.runId;
    const importedPublication = grandchildStore.loadLedger()
      .pendingManagerCommit!.publication;
    expect(importedPublication.destinationRunId).toBe(grandchildRunSlug);

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
    expect(grandchildSnapshot.run.runId).toBe(grandchildRunSlug);
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

  it('keeps the parent immutable when the target input disables Finding Contract', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    await stagePendingPublication(parent.root);
    const parentState = parent.root.readResumeSnapshot();
    const parentBytes = readFileSync(parent.databasePath);
    const childDatabasePath = `${parent.databasePath}.disabled-input-child`;

    const child = resumeRunStorage({
      databasePath: childDatabasePath,
      source: parent.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'disabled-input-child-session',
      }),
      run: {
        runId: 'run-disabled-input-child',
        workflowName: 'default',
        findingContractEnabled: false,
      },
    });
    expect(child.readResumeSnapshot().run.findingContractEnabled).toBe(1);
    child.close();
    expect(existsSync(childDatabasePath)).toBe(true);
    expect(parent.root.readResumeSnapshot()).toEqual(parentState);
    expect(readFileSync(parent.databasePath)).toEqual(parentBytes);
  });

  it('enables the resumed root when the target requests Finding Contract', () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.enabled-input-child`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'enabled-input-child-session',
      }),
      run: {
        runId: 'run-enabled-input-child',
        workflowName: 'target-workflow',
        findingContractEnabled: true,
      },
    });
    expect(child.readResumeSnapshot()).toMatchObject({
      run: { findingContractEnabled: 1 },
      scopes: [
        {
          scopeId: 'root',
          findingContractEnabled: 1,
        },
      ],
      findingHeads: [],
    });

    const owner = child.claimLease({
      ownerKey: 'enabled-input-child-owner',
      leaseDurationMs: 10_000,
    });
    const runtime = child.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });
    expect(runtime.findingManager({
      workflowName: 'target-workflow',
      producer: execution.handle,
    }).loadLedger()).toMatchObject({
      workflowName: 'target-workflow',
      nextId: 1,
    });
    expect(child.readResumeSnapshot().findingHeads).toHaveLength(1);
    child.close();
  });

  it('rebinds a pending publication on every direct resume', async () => {
    const parent = createRealRunStorage({ findingContractEnabled: true });
    await stagePendingPublication(parent.root);
    const child = resumeRealRunStorage(parent.root, {
      slug: 'run-unbound-child',
      findingContractEnabled: true,
    });
    const grandchild = resumeRunStorage({
      databasePath: `${child.databasePath}.grandchild`,
      source: child.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'skipped-grandchild-session',
      }),
      run: {
        runId: 'run-grandchild',
        workflowName: 'renamed-workflow',
        findingContractEnabled: true,
      },
    });
    const store = findingStore(
      grandchild,
      'renamed-workflow-owner',
      'renamed-workflow',
    );
    expect(store.loadLedger()).toMatchObject({
      workflowName: 'renamed-workflow',
      pendingManagerCommit: {
        publication: { destinationRunId: 'run-grandchild' },
      },
    });
    grandchild.close();
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

  it('promotes an imported workflow_call scope when the target enables Finding Contract', () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const sourceLease = source.root.claimLease({
      ownerKey: 'workflow-promote-source',
      leaseDurationMs: 10_000,
    });
    source.root.runtime({ lease: sourceLease }).scopes.createWorkflowCallChild({
      scopeKey: 'workflow-promote',
      findingContractEnabled: false,
    });
    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.workflow-promote`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'workflow-promote-session',
      }),
      run: {
        runId: 'workflow-promote-target',
        workflowName: 'target-workflow',
        findingContractEnabled: false,
      },
    });
    const childLease = child.claimLease({
      ownerKey: 'workflow-promote-target',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.runtime({ lease: childLease });
    const childScope = rootRuntime.scopes.resolveWorkflowCallChild({
      scopeKey: 'workflow-promote',
      findingContractEnabled: true,
    });
    expect(child.readResumeSnapshot()).toMatchObject({
      run: { findingContractEnabled: 1 },
      findingHeads: [],
    });
    expect(rootRuntime.scopes.get().findingContractEnabled).toBe(false);
    expect(child.runtime({
      lease: childLease,
      scope: childScope,
    }).scopes.get().findingContractEnabled).toBe(true);
    child.close();
  });

  it('retains an imported workflow_call Finding Contract when the target disables it', () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const sourceLease = source.root.claimLease({
      ownerKey: 'workflow-retain-source',
      leaseDurationMs: 10_000,
    });
    source.root.runtime({ lease: sourceLease }).scopes.createWorkflowCallChild({
      scopeKey: 'workflow-retain',
      findingContractEnabled: true,
    });
    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.workflow-retain`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'workflow-retain-session',
      }),
      run: {
        runId: 'workflow-retain-target',
        workflowName: 'target-workflow',
        findingContractEnabled: false,
      },
    });
    const childLease = child.claimLease({
      ownerKey: 'workflow-retain-target',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.runtime({ lease: childLease });
    const childScope = rootRuntime.scopes.resolveWorkflowCallChild({
      scopeKey: 'workflow-retain',
      findingContractEnabled: false,
    });
    expect(child.readResumeSnapshot().run.findingContractEnabled).toBe(1);
    expect(child.runtime({
      lease: childLease,
      scope: childScope,
    }).scopes.get().findingContractEnabled).toBe(true);
    child.close();
  });

  it('promotes an imported parallel scope when the resumed parent enables Finding Contract', () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const sourceLease = source.root.claimLease({
      ownerKey: 'parallel-promote-source',
      leaseDurationMs: 10_000,
    });
    source.root.runtime({ lease: sourceLease }).scopes.createParallelChild({
      scopeKey: 'parallel-promote',
    });
    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.parallel-promote`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'parallel-promote-session',
      }),
      run: {
        runId: 'parallel-promote-target',
        workflowName: 'target-workflow',
        findingContractEnabled: true,
      },
    });
    const childLease = child.claimLease({
      ownerKey: 'parallel-promote-target',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.runtime({ lease: childLease });
    const childScope = rootRuntime.scopes.resolveParallelChild({
      scopeKey: 'parallel-promote',
    });
    expect(rootRuntime.scopes.get().findingContractEnabled).toBe(true);
    expect(child.runtime({
      lease: childLease,
      scope: childScope,
    }).scopes.get().findingContractEnabled).toBe(true);
    child.close();
  });

  it('retains an imported parallel Finding Contract when the target disables it', () => {
    const source = createRealRunStorage({ findingContractEnabled: true });
    const sourceLease = source.root.claimLease({
      ownerKey: 'parallel-retain-source',
      leaseDurationMs: 10_000,
    });
    source.root.runtime({ lease: sourceLease }).scopes.createParallelChild({
      scopeKey: 'parallel-retain',
    });
    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.parallel-retain`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: 'parallel-retain-session',
      }),
      run: {
        runId: 'parallel-retain-target',
        workflowName: 'target-workflow',
        findingContractEnabled: false,
      },
    });
    const childLease = child.claimLease({
      ownerKey: 'parallel-retain-target',
      leaseDurationMs: 10_000,
    });
    const rootRuntime = child.runtime({ lease: childLease });
    const childScope = rootRuntime.scopes.resolveParallelChild({
      scopeKey: 'parallel-retain',
    });
    expect(rootRuntime.scopes.get().findingContractEnabled).toBe(true);
    expect(child.runtime({
      lease: childLease,
      scope: childScope,
    }).scopes.get().findingContractEnabled).toBe(true);
    child.close();
  });

  it('resumes nested-only Finding Contract state with a disabled root', async () => {
    const source = createRealRunStorage({ findingContractEnabled: false });
    const sourceLease = source.root.claimLease({
      ownerKey: 'nested-only-source',
      leaseDurationMs: 10_000,
    });
    const sourceRoot = source.root.runtime({ lease: sourceLease });
    const sourceChildScope = sourceRoot.scopes.createWorkflowCallChild({
      scopeKey: 'nested-finding',
      findingContractEnabled: true,
    });
    const sourceChild = source.root.runtime({
      lease: sourceLease,
      scope: sourceChildScope,
    });
    const sourceExecution = sourceChild.execution.startStep({
      stepKey: 'nested-review',
      expectedScopeRevision: 0,
    });
    const sourceStore = sourceChild.findingManager({
      workflowName: 'nested-source',
      producer: sourceExecution.handle,
    });
    await sourceStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 7 },
      result: undefined,
    }));

    const child = resumeRunStorage({
      databasePath: `${source.databasePath}.nested-child`,
      source: source.root,
      bootstrapSeed: createTestBootstrapSeed({
        workflowName: 'nested-target',
        sessionId: 'nested-target-session',
      }),
      run: {
        runId: 'nested-target-run',
        workflowName: 'nested-target',
        findingContractEnabled: false,
      },
    });
    const snapshot = child.readResumeSnapshot();
    expect(snapshot.run.findingContractEnabled).toBe(1);
    expect(snapshot.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeId: 'root',
        findingContractEnabled: 0,
      }),
      expect.objectContaining({
        kind: 'workflow_call',
        findingContractEnabled: 1,
      }),
    ]));

    const childLease = child.claimLease({
      ownerKey: 'nested-only-target',
      leaseDurationMs: 10_000,
    });
    const childRoot = child.runtime({ lease: childLease });
    const targetChildScope = childRoot.scopes.resolveWorkflowCallChild({
      scopeKey: 'nested-finding',
      findingContractEnabled: true,
    });
    const targetChild = child.runtime({
      lease: childLease,
      scope: targetChildScope,
    });
    const targetExecution = targetChild.execution.startStep({
      stepKey: 'nested-review',
      expectedScopeRevision: 0,
    });
    expect(targetChild.findingManager({
      workflowName: 'nested-target',
      producer: targetExecution.handle,
    }).loadLedger()).toMatchObject({
      workflowName: 'nested-target',
      nextId: 7,
    });
    child.close();
  });
});
