import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  resumeRealRunStorage,
} from './helpers/run-storage.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';

afterEach(cleanupRealRunStorages);

describe('Finding authority boundary', () => {
  it('projects normalized raw entries from an append-only ledger revision', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
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

    await store.updateLedger((ledger) => ({
      ledger: {
        ...ledger,
        rawFindings: [canonicalRawFindingFixture({
          rawFindingId: 'raw-1',
          stepName: 'review',
          reviewer: 'reviewer',
          familyTag: 'architecture',
          severity: 'high',
          title: 'Authority',
          description: 'SQLite is authoritative.',
          suggestion: null,
          relation: 'new',
          targetFindingId: null,
          evidence: [],
        })],
      },
      result: undefined,
    }));

    expect(store.loadLedger().rawFindings).toEqual([
      expect.objectContaining({ rawFindingId: 'raw-1' }),
    ]);
    expect(root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ scope_id: 'root', current_revision: 2 }),
    ]);
  });

  it('keeps Finding authority empty when Finding Contract is disabled', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: false });

    expect(root.readResumeSnapshot().findingHeads).toEqual([]);
    expect(root.readResumeSnapshot().findingRevisions).toEqual([]);
    expect(root.readResumeSnapshot().scopes).toEqual([
      expect.objectContaining({ scopeId: 'root' }),
    ]);
  });

  it('creates child Finding authority on its first mutation', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'owner',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const childScope = rootRuntime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: owner, scope: childScope });
    const execution = child.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    const childStore = child.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    expect(childStore.loadLedger()).toMatchObject({
      workflowName: 'default',
      nextId: 1,
    });
    await childStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));
    const snapshot = root.readResumeSnapshot();
    expect(snapshot.findingHeads).toEqual([
      expect.objectContaining({ current_revision: 2 }),
    ]);
    expect(snapshot.findingHeads[0]?.scope_id).not.toBe('root');
    expect(snapshot.findingRevisions).toHaveLength(1);
  });

  it('validates root and parallel histories beyond their bootstrap revisions', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'revision-history-owner',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const parallelScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'revision-history-parallel',
    });
    const parallelRuntime = root.runtime({
      lease: owner,
      scope: parallelScope,
    });
    const rootExecution = rootRuntime.execution.startStep({
      stepKey: 'root-manager',
      expectedScopeRevision: 0,
    });
    const parallelExecution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-manager',
      expectedScopeRevision: 0,
    });
    const rootStore = rootRuntime.findingManager({
      workflowName: 'default',
      producer: rootExecution.handle,
    });
    const parallelStore = parallelRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    });

    await rootStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));
    await parallelStore.updateLedger((ledger) => ({
      ledger: { ...ledger, nextId: 2 },
      result: undefined,
    }));

    expect(root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ current_revision: 2 }),
      expect.objectContaining({ current_revision: 2 }),
    ]);
    const resumed = resumeRealRunStorage(root, {
      slug: 'revision-history-resume',
      findingContractEnabled: true,
    });
    expect(resumed.root.readResumeSnapshot().findingHeads).toEqual([
      expect.objectContaining({ current_revision: 1 }),
      expect.objectContaining({ current_revision: 1 }),
    ]);
  });

  it('rejects root, parallel, and workflow_call sibling producer handles', () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = root.claimLease({
      ownerKey: 'scope-bound-producers',
      leaseDurationMs: 9_000,
    });
    const rootRuntime = root.runtime({ lease: owner });
    const rootExecution = rootRuntime.execution.startStep({
      stepKey: 'root-review',
      expectedScopeRevision: 0,
    });
    const parallelScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'parallel-review',
    });
    const workflowScope = rootRuntime.scopes.createWorkflowCallChild({
      scopeKey: 'workflow-review',
    });
    const parallelRuntime = root.runtime({ lease: owner, scope: parallelScope });
    const workflowRuntime = root.runtime({ lease: owner, scope: workflowScope });
    const parallelExecution = parallelRuntime.execution.startStep({
      stepKey: 'parallel-review',
      expectedScopeRevision: 0,
    });
    const workflowExecution = workflowRuntime.execution.startStep({
      stepKey: 'workflow-review',
      expectedScopeRevision: 0,
    });

    expect(() => rootRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => parallelRuntime.findingManager({
      workflowName: 'default',
      producer: rootExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => workflowRuntime.findingManager({
      workflowName: 'default',
      producer: parallelExecution.handle,
    })).toThrow(/cross-scope/i);
    expect(() => parallelRuntime.findingManager({
      workflowName: 'default',
      producer: workflowExecution.handle,
    })).toThrow(/cross-scope/i);
  });
});
