import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { stagePendingManagerCommit } from '../core/workflow/findings/manager-pending-commit.js';
import * as publicRunStorage from '../infra/run-storage/index.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function claim(root: ReturnType<typeof createRealRunStorage>['root']) {
  return root.claimLease({
      ownerKey: 'worker-1',
      leaseDurationMs: 10_000,
  });
}

function emptyLedger(): FindingLedger {
  return {
    workflowName: 'default',
    nextId: 1,
    updatedAt: '1970-01-01T00:00:01.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  };
}

describe('run storage authority redesign', () => {
  it('Finding authority is normalized and FindingLedger is only a projection', async () => {
    const { databasePath, root, clock } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });

    clock.set(2_000);
    await store.updateLedger(() => ({
      ledger: {
        ...emptyLedger(),
        nextId: 2,
        rawFindings: [{
          rawFindingId: 'raw-1',
          stepName: 'architecture-review',
          reviewer: 'architecture',
          familyTag: 'architecture',
          severity: 'high',
          title: 'Cross-scope authority',
          description: 'A cross-scope mutation was attempted.',
          relation: 'new',
        }],
      },
      result: undefined,
    }));
    expect(store.loadLedger()).toMatchObject({
      nextId: 2,
      updatedAt: '1970-01-01T00:00:02.000Z',
      rawFindings: [{ rawFindingId: 'raw-1' }],
    });

    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT count(*) AS count
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'finding_ledger_state'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT count(*) AS count FROM finding_ledger_revisions
    `).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT count(*) AS count FROM finding_raw_entries WHERE revision = 2
    `).get()).toEqual({ count: 1 });
    database.close();
  });

  it.each([
    ['stopBudget', ['round-a', 'round-a']],
    ['reviewIntegrity', ['round-b', 'round-a']],
  ] as const)('rejects noncanonical %s.roundMarkers at the SQLite write boundary', async (
    field,
    roundMarkers,
  ) => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager-round-marker-validation',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const current = store.loadLedger();

    await expect(Promise.resolve().then(() => store.updateLedger(() => ({
      ledger: {
        ...current,
        [field]: {
          roundMarkers: [...roundMarkers],
          firstRoundAt: current.updatedAt,
          exhausted: false,
        },
      },
      result: undefined,
    })))).rejects.toThrow(/binary-sorted unique set/);
  });

  it('isolates direct callback mutation from the SQLite comparison baseline', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'findings-manager-callback-isolation',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const previousLedger = store.loadLedger();
    const roundMarker = 'sqlite-callback-isolation-round';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId: root.readResumeSnapshot().run.runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const staged = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    const reject = (operation: () => unknown, pattern: RegExp) => (
      expect(Promise.resolve().then(operation)).rejects.toThrow(pattern)
    );

    await reject(() => store.updateLedger((current) => {
      current.pendingManagerCommit = staged.pendingManagerCommit;
      return { ledger: current, result: undefined };
    }), /cannot be staged through the general mutation API/i);

    await store.commitManagerLedger(() => ({ ledger: staged, result: undefined }));

    await reject(() => store.updateLedger((current) => {
      current.pendingManagerCommit!.publication.destinationRunId = 'forged-run';
      return { ledger: current, result: undefined };
    }), /pending.*dedicated finalization/i);

    await reject(() => store.updateLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    }), /pending.*dedicated finalization/i);

    await reject(() => store.updateLedger(
      (current) => ({ ledger: current, result: undefined }),
      (current, mutation) => {
        delete current.pendingManagerCommit;
        mutation.ledger = current;
        return { mutation, publish: true };
      },
    ), /pending.*dedicated finalization/i);

    await reject(() => store.commitManagerLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    }), /pending.*dedicated finalization/i);

    expect(store.loadLedger()).toEqual(staged);
  });

  it('does not expose raw SQL write contexts from the public root or package boundary', () => {
    const { root } = createRealRunStorage();

    expect(Reflect.get(root, 'write')).toBeUndefined();
    expect(Reflect.get(publicRunStorage, 'RunWriteContext')).toBeUndefined();
    expect(Reflect.get(publicRunStorage, 'RunReadContext')).toBeUndefined();
    expect(
      Reflect.ownKeys(Object.getPrototypeOf(root))
        .filter((key) => typeof key === 'symbol'),
    ).toEqual([]);
  });

  it('rejects a ghost scope at commit and creates scope with runtime atomically', () => {
    const { databasePath, root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    runtime.scopes.createParallelChild({ scopeKey: 'parallel-1' });
    expect(root.readResumeSnapshot().scopes).toContainEqual(
      expect.objectContaining({
        kind: 'parallel',
        runtime: expect.objectContaining({ status: 'ready' }),
      }),
    );

    root.close();
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`
      INSERT INTO scopes (
        run_id, scope_id, parent_scope_id, kind,
        workflow_definition_id, created_at
      )
      SELECT
        run_id, 'ghost', 'root', 'parallel',
        workflow_definition_id, created_at
      FROM runs
    `).run();
    expect(() => database.exec('COMMIT')).toThrow(/foreign key/i);
    database.exec('ROLLBACK');
    database.close();
  });

  it('binds execution commands and child foreign keys to one run and scope', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const rootRuntime = root.runtime({ lease: owner });
    const scopeA = rootRuntime.scopes.createParallelChild({ scopeKey: 'parallel-a' });
    const scopeB = rootRuntime.scopes.createParallelChild({ scopeKey: 'parallel-b' });
    const parallelA = root.runtime({ lease: owner, scope: scopeA });
    const parallelB = root.runtime({ lease: owner, scope: scopeB });
    const execution = parallelA.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    expect(() => parallelB.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    })).toThrow(/cross-scope/i);
    expect(() => parallelB.execution.recordStepOutput({
      execution: execution.handle,
      outputName: 'result',
      codecName: 'text-v1',
      content: 'forbidden',
    })).toThrow(/cross-scope/i);
  });

  it('takes every authority timestamp from the trusted UOW clock', () => {
    const { root, clock } = createRealRunStorage();
    expect(root.readResumeSnapshot().run.createdAt).toBe(1_000);
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    clock.set(4_000);
    const execution = runtime.execution.startStep({
      stepKey: 'implement',
      expectedScopeRevision: 0,
    });
    expect(execution.startedAt).toBe(4_000);
    expect(root.readResumeSnapshot().scopes[0]?.runtime.updatedAt).toBe(4_000);
  });

  it('requires report producer execution and preserves owner/producer attribution', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const rootRuntime = root.runtime({ lease: owner });
    const reviewerScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'reviewer',
    });
    const reviewer = root.runtime({ lease: owner, scope: reviewerScope });
    const execution = reviewer.execution.startStep({
      stepKey: 'architecture-review',
      expectedScopeRevision: 0,
    });

    const published = rootRuntime.reports.publish({
      publicationKey: 'publication-1',
      streamName: 'architecture.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"result":"revise"}',
      producer: execution.handle,
    });
    expect(published).toMatchObject({
      ownerScopeId: 'root',
      producerStepId: 'architecture-review',
    });
    expect(() => rootRuntime.reports.publish({
      publicationKey: 'publication-missing-execution',
      streamName: 'invalid.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: Object.freeze({}) as never,
    })).toThrow(/Execution handle is forged/i);
  });

  it('uses publicationId for idempotency without collapsing equal content', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'publisher',
      expectedScopeRevision: 0,
    });
    const input = {
      streamName: 'report.json',
      codecName: 'json-v1',
      content: '{"same":true}',
      producer: execution.handle,
    } as const;

    runtime.reports.publish({
      ...input,
      publicationKey: 'publication-1',
      expectedRevision: 0,
    });
    runtime.reports.publish({
      ...input,
      publicationKey: 'publication-2',
      expectedRevision: 1,
    });
    const replay = runtime.reports.publish({
      ...input,
      publicationKey: 'publication-2',
      expectedRevision: 1,
    });

    expect(replay.revision).toBe(2);
    const history = runtime.reports.history('report.json');
    expect(history).toHaveLength(2);
    expect(history[0]?.publicationId).not.toBe(history[1]?.publicationId);
  });

  it('returns a complete run snapshot from one read transaction and bootstraps FC atomically', () => {
    const enabled = createRealRunStorage({ findingContractEnabled: true });
    const owner = claim(enabled.root);
    const runtime = enabled.root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'resume-source',
      expectedScopeRevision: 0,
    });
    runtime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'step_started',
      codecName: 'json-v1',
      payload: '{}',
    });
    runtime.sequences.recordResponseSnapshot({
      expectedSequence: 0,
      codecName: 'text-v1',
      response: 'response',
    });
    runtime.sessions.start({ sessionKey: 'provider-session' });
    runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request: { codecName: 'json-v1', content: '{}' },
    });
    runtime.runtimeValues.createRecoveryItem({
      recoveryKey: 'recover-1',
      itemType: 'provider-response',
      codecName: 'json-v1',
      content: '{}',
    });

    const snapshot = enabled.root.readResumeSnapshot();
    expect(snapshot.scopes[0]).toMatchObject({
      scopeId: 'root',
      events: [{ sequence: 1 }],
      responses: [{ sequence: 1, response: 'response' }],
      stepExecutions: [expect.objectContaining({ stepId: 'resume-source' })],
      recoveryItems: [{ recoveryKey: 'recover-1' }],
    });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.operations).toHaveLength(1);
    expect(snapshot.findingLedger).toMatchObject({
      revision: 1,
      ledger: emptyLedger(),
    });

    const disabled = createRealRunStorage({ findingContractEnabled: false });
    const disabledOwner = claim(disabled.root);
    const disabledRuntime = disabled.root.runtime({ lease: disabledOwner });
    expect(disabledRuntime.execution.startStep({
      stepKey: 'normal-run',
      expectedScopeRevision: 0,
    }).iteration).toBe(1);
    expect(disabled.root.readResumeSnapshot().findingLedger).toBeNull();
    expect(() => disabledRuntime.findingManager({
      workflowName: 'default',
      producer: Object.freeze({}) as never,
    })).toThrow(/Finding Contract is disabled/);
  });
});
