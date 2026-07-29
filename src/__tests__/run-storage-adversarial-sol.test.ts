import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRawRecoveryAttempt,
  createRawRecoveryResult,
} from '../core/models/finding-raw-recovery.js';
import { computeRawFindingIntegrityDigest } from '../core/models/finding-raw-integrity.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import {
  createRunStorage,
  openRunStorage,
} from '../infra/run-storage/root.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
  createTestBootstrapSeed,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function lease(root: ReturnType<typeof createRealRunStorage>['root']) {
  return root.claimLease({ ownerKey: 'worker', leaseDurationMs: 9_000 });
}

function forceFail(
  root: ReturnType<typeof createRealRunStorage>['root'],
  reason: string,
): void {
  root.forceFailRun({
    expectedRunId: 'run-1',
    ownerKey: 'force-fail-worker',
    leaseDurationMs: 9_000,
    reason,
    iteration: 2,
    publicationPayload: '{}',
  });
}

describe('run storage adversarial SOL contracts', () => {
  it('has no absolute-importable raw context registry or reflective executor', async () => {
    const moduleUrl = pathToFileURL(
      `${process.cwd()}/src/infra/run-storage/internal-access.js`,
    ).href;
    await expect(import(moduleUrl)).rejects.toThrow();

    const { root } = createRealRunStorage();
    const runtime = root.runtime({ lease: lease(root) });
    expect(Reflect.ownKeys(root).filter((key) => typeof key === 'symbol')).toEqual([]);
    expect(Reflect.ownKeys(runtime).filter((key) => typeof key === 'symbol')).toEqual([]);
    expect(Reflect.get(root, 'executor')).toBeUndefined();
    expect(Reflect.get(runtime, 'executor')).toBeUndefined();
    for (const commands of [
      runtime.scopes,
      runtime.execution,
      runtime.runtimeValues,
      runtime.sequences,
      runtime.reports,
      runtime.sessions,
      runtime.operations,
    ]) {
      expect(Reflect.get(commands, 'executor')).toBeUndefined();
      expect(Reflect.ownKeys(commands).filter(
        (key) => typeof key === 'symbol',
      )).toEqual([]);
    }
  });

  it('generates authority IDs and rejects unknown raw authority inputs and forged handles', () => {
    expect(() => createRunStorage({
      databasePath: '/tmp/never-created.sqlite',
      bootstrapSeed: createTestBootstrapSeed(),
      run: {
        runId: 'forged',
        workflowName: 'default',
        findingContractEnabled: false,
        slug: 'forged',
      },
    } as never)).toThrow(/unknown run field/i);

    const { root } = createRealRunStorage();
    expect(() => root.claimLease({
      ownerKey: 'worker',
      leaseDurationMs: 9_000,
      claimToken: 'forged',
    } as never)).toThrow(/unknown/i);
    expect(() => root.runtime({ lease: Object.freeze({}) as never }))
      .toThrow(/forged/i);

    const runtime = root.runtime({ lease: lease(root) });
    expect(() => runtime.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
      executionId: 'forged',
    } as never)).toThrow(/unknown/i);
  });

  it('atomically terminalizes active descendants and seals their authorities', () => {
    const { root } = createRealRunStorage();
    const owner = lease(root);
    const parent = root.runtime({ lease: owner });
    const childHandle = parent.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: owner, scope: childHandle });
    const running = child.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    expect(() => child.execution.startStep({
      stepKey: 'second',
      expectedScopeRevision: 1,
    })).toThrow(/unique|running/i);
    expect(() => child.scopes.terminalize({
      expectedRevision: 1,
      expectedStatus: 'running',
      status: 'completed',
    })).toThrow(/active authority/i);
    child.reports.publish({
      publicationKey: 'child-terminal-report',
      streamName: 'child.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: running.handle,
    });
    root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    });
    expect(() => child.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'after-terminal',
    })).toThrow(/stale|terminal|sealed/i);
    expect(() => child.reports.publish({
      publicationKey: 'child-terminal-report',
      streamName: 'child.json',
      expectedRevision: 1,
      codecName: 'json-v1',
      content: '{}',
      producer: running.handle,
    })).toThrow(/stale|terminal|sealed/i);
  });

  it('force-failをterminal再読込・lease claim・終端化の単一CAS操作にする', () => {
    const { databasePath, root: first } = createRealRunStorage();
    const second = openRunStorage({ databasePath });
    expect(first.readResumeSnapshot().run.status).toBe('running');
    expect(second.readResumeSnapshot().run.status).toBe('running');

    forceFail(first, 'same force-fail reason');
    expect(() => forceFail(second, 'same force-fail reason')).not.toThrow();
    expect(second.readResumeSnapshot().run.status).toBe('failed');
    expect(second.readTerminalPublication()).toMatchObject({
      status: 'failed',
      reason: 'same force-fail reason',
    });
    expect(() => forceFail(second, 'different force-fail reason'))
      .toThrow(/conflict/i);
    second.close();
    first.close();

    const owned = createRealRunStorage();
    const competing = openRunStorage({ databasePath: owned.databasePath });
    lease(owned.root);
    expect(() => forceFail(competing, 'lease conflict'))
      .toThrow(/active lease/i);
    expect(competing.readResumeSnapshot().run.status).toBe('running');
    competing.close();
    owned.root.close();
  });

  it('rejects every authority command after terminalization at both API and DDL boundaries', () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = lease(root);
    const runtime = root.runtime({ lease: owner });
    const session = runtime.sessions.start({ sessionKey: 'terminal-session' });
    const persona = runtime.runtimeValues.startPersonaSession({
      sessionKey: 'terminal-persona',
      personaName: 'reviewer',
    });
    const execution = runtime.execution.startStep({
      stepKey: 'terminal-source',
      expectedScopeRevision: 0,
      session,
      personaSession: persona,
    });
    runtime.reports.publish({
      publicationKey: 'before-terminal',
      streamName: 'terminal.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{}',
      producer: execution.handle,
    });
    const findingStore = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const recovery = runtime.runtimeValues.createRecoveryItem({
      recoveryKey: 'terminal-recovery',
      itemType: 'test',
      codecName: 'json-v1',
      content: '{}',
    });
    runtime.runtimeValues.resolveRecoveryItem({
      recovery,
      status: 'applied',
    });
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'terminal-operation',
      kind: 'provider',
      request: { codecName: 'json-v1', content: '{}' },
    });
    runtime.operations.cancelPrepared(operation.handle);
    runtime.runtimeValues.endPersonaSession(persona);
    runtime.sessions.end(session);
    runtime.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    });
    root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    });

    const rejectedCommands = [
      () => runtime.sequences.appendEvent({
        expectedSequence: 0,
        eventType: 'after-terminal',
      }),
      () => runtime.sequences.recordResponseSnapshot({
        expectedSequence: 0,
        codecName: 'text-v1',
        response: 'after-terminal',
      }),
      () => runtime.execution.recordStepOutput({
        execution: execution.handle,
        outputName: 'after-terminal',
        codecName: 'text-v1',
        content: 'sealed',
      }),
      () => runtime.sessions.start({ sessionKey: 'after-terminal' }),
      () => runtime.runtimeValues.createRecoveryItem({
        recoveryKey: 'after-terminal',
        itemType: 'test',
        codecName: 'json-v1',
        content: '{}',
      }),
      () => runtime.reports.publish({
        publicationKey: 'after-terminal',
        streamName: 'terminal.json',
        expectedRevision: 1,
        codecName: 'json-v1',
        content: '{}',
        producer: execution.handle,
      }),
      () => findingStore.updateLedger((current) => ({
        ledger: current,
        result: undefined,
      })),
    ];
    for (const command of rejectedCommands) {
      expect(command).toThrow(/stale|terminal|sealed/i);
    }
    root.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    const runId = (database.prepare('SELECT run_id AS runId FROM runs').get() as {
      readonly runId: string;
    }).runId;
    expect(() => database.prepare(`
      INSERT INTO run_events (
        run_id, scope_id, event_seq, event_type, occurred_at
      ) VALUES (?, 'root', 1, 'ddl-after-terminal', 3000)
    `).run(runId)).toThrow(/terminal scope authority is sealed/i);
    const sealedTables = database.prepare(`
      SELECT count(DISTINCT tbl_name) AS count
      FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE '%_terminal_seal'
    `).get() as { readonly count: number };
    expect(sealedTables.count).toBeGreaterThanOrEqual(30);
    database.close();
  });

  it('rejects terminalization when a raw recovery result borrows an unrelated lifecycle event', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = lease(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'raw-recovery-terminal-seal',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const observation = {
      runId: 'run-1',
      stepName: 'raw-recovery-terminal-seal',
      timestamp: '2026-07-29T00:00:00.000Z',
    };
    const sourceRaw = canonicalRawFindingFixture({
      rawFindingId: 'raw-provisional-source',
      stepName: observation.stepName,
      reviewer: 'reviewer',
      familyTag: 'correctness',
      severity: 'high' as const,
      title: 'Provisional target',
      description: 'The target requires bounded recovery.',
      suggestion: null,
      relation: 'new' as const,
      targetFindingId: null,
      evidence: [{
        kind: 'file_quote' as const,
        path: 'src/provisional.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'provisional target',
        snapshotId: '1'.repeat(64),
      }],
    });
    const authorized = authorizeFindingLedgerFixture({
      workflowName: 'default',
      nextId: 3,
      updatedAt: observation.timestamp,
      findings: [
        {
          id: 'F-0001',
          status: 'open',
          lifecycle: 'new',
          severity: 'high',
          title: 'Provisional target',
          description: 'The target requires bounded recovery.',
          evidenceIds: [],
          rawFindingIds: [sourceRaw.rawFindingId],
          reviewers: ['reviewer'],
          firstSeen: observation,
          lastSeen: observation,
          revision: 1,
          disputes: [],
          waivers: [],
          provisional: {
            kind: 'raw-adjudication-unresolved',
            stableKey: 'stable-provisional',
            lineageKey: 'lineage-provisional',
            sourceRawFindingIds: [sourceRaw.rawFindingId],
            reason: 'Recovery remains pending.',
            firstObservedAt: observation,
            lastObservedAt: observation,
            interpretationEpochs: 0,
            gateEffect: 'block',
            firstObservedRound: 1,
            recoveryReviewerStableKey: 'reviewer',
          },
        },
        {
          id: 'F-0002',
          status: 'open',
          lifecycle: 'new',
          severity: 'medium',
          title: 'Unrelated finding',
          description: 'This event must not close recovery for F-0001.',
          evidenceIds: [],
          rawFindingIds: [],
          reviewers: ['reviewer'],
          firstSeen: observation,
          lastSeen: observation,
          revision: 1,
          disputes: [],
          waivers: [],
        },
      ],
      evidenceRecords: [],
      rawFindings: [sourceRaw],
      conflicts: [],
      interpretations: [],
    });
    const expectedHead = captureFindingLifecycleHead(
      authorized,
      'finding',
      'F-0001',
    )!;
    const attempt = createRawRecoveryAttempt({
      provisionalFindingId: 'F-0001',
      expectedHead,
      sourceRawFindingId: sourceRaw.rawFindingId,
      sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(sourceRaw),
      promptSnapshotDigest: '2'.repeat(64),
      attempt: 1,
      startedAt: observation,
    });
    await store.updateLedger(() => ({
      ledger: {
        ...authorized,
        rawRecoveryAttempts: [attempt],
      },
      result: undefined,
    }));
    const current = store.loadLedger();
    const unrelatedEvent = current.lifecycleEvents.find((event) => (
      event.transitions.some((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === 'F-0002'
      ))
    ))!;
    const unrelatedBinding = current.evidenceBindings.find(
      (binding) => unrelatedEvent.evidenceBindingIds.includes(binding.bindingId),
    )!;
    const forgedResult = createRawRecoveryResult({
      attemptId: attempt.attemptId,
      replayRawFindingId: unrelatedBinding.sourceRawFindingId,
      mutationIds: [unrelatedEvent.mutationId],
      outcome: 'applied',
      completedAt: observation,
    });

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    const head = database.prepare(`
      SELECT current_revision AS revision
      FROM finding_ledger_heads
      WHERE run_id = 'run-1' AND scope_id = 'root'
    `).get() as { readonly revision: number };
    database.prepare(`
      INSERT INTO finding_raw_recovery_results (
        run_id, scope_id, revision, ordinal, result_id, record, digest
      ) VALUES ('run-1', 'root', ?, 0, ?, ?, ?)
    `).run(
      head.revision,
      forgedResult.resultId,
      JSON.stringify(forgedResult),
      createHash('sha256').update(JSON.stringify(forgedResult)).digest('hex'),
    );

    expect(() => root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    })).toThrow(/active authority/i);
    database.close();
    root.close();
  });

  it('enforces current Finding revision completeness, identity, append-only, and digest contracts', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const owner = lease(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'finding-contract-boundaries',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    await store.updateLedger((current) => ({
      ledger: { ...current, nextId: 2 },
      result: undefined,
    }));
    expect(root.readResumeSnapshot().findingRevisions).toEqual([
      expect.objectContaining({ revision: 2 }),
    ]);
    root.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    const findingRecord = '{"id":"finding-a"}';
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`
      INSERT INTO finding_entries (
        run_id, scope_id, revision, ordinal, finding_id, record, digest
      ) VALUES ('run-1', 'root', 3, 0, 'finding-a', ?, ?)
    `).run(
      findingRecord,
      createHash('sha256').update(findingRecord).digest('hex'),
    );
    expect(() => database.prepare(`
      INSERT INTO finding_ledger_revisions (
        run_id, scope_id, revision, next_id,
        finding_count, evidence_record_count, evidence_binding_count,
        lifecycle_reservation_count, lifecycle_event_count,
        raw_recovery_attempt_count, raw_recovery_result_count,
        raw_finding_count, conflict_count, interpretation_count,
        reviewer_anomaly_count, control_count,
        projection_digest, updated_at
      ) VALUES (
        'run-1', 'root', 3, 2,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, 2000
      )
    `).run('0'.repeat(64))).toThrow(/incomplete/i);
    database.exec('ROLLBACK');

    expect(() => database.prepare(`
      INSERT INTO finding_entries (
        run_id, scope_id, revision, ordinal, finding_id, record, digest
      ) VALUES (
        'run-1', 'root', 3, 0, 'finding-a',
        '{"id":"finding-b"}', ?
      )
    `).run('0'.repeat(64))).toThrow(/constraint/i);

    expect(() => database.prepare(`
      UPDATE finding_ledger_revisions
      SET projection_digest = ?
      WHERE run_id = 'run-1' AND scope_id = 'root' AND revision = 2
    `).run('f'.repeat(64))).toThrow(/append-only/i);

    const updateGuard = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'finding_ledger_revisions_update_guard'
    `).get() as { readonly sql: string };
    database.exec('DROP TRIGGER finding_ledger_revisions_update_guard');
    database.prepare(`
      UPDATE finding_ledger_revisions
      SET projection_digest = ?
      WHERE run_id = 'run-1' AND scope_id = 'root' AND revision = 2
    `).run('f'.repeat(64));
    database.exec(updateGuard.sql);
    database.close();

    expect(() => openRunStorage({ databasePath }))
      .toThrow(/Finding|digest mismatch/i);
  });

  it('returns the current Finding projection in one snapshot', async () => {
    const { root } = createRealRunStorage({ findingContractEnabled: true });
    const owner = lease(root);
    const runtime = root.runtime({ lease: owner });
    const execution = runtime.execution.startStep({
      stepKey: 'finding-manager',
      expectedScopeRevision: 0,
    });
    const store = runtime.findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    await store.updateLedger((current) => ({
      ledger: { ...current, nextId: 2 },
      result: undefined,
    }));

    const snapshot = root.readResumeSnapshot();
    expect(snapshot.findingRevisions).toHaveLength(1);
    expect(snapshot.findingRevisions[0]).toMatchObject({ revision: 2 });
    expect(snapshot.findingHeads).toHaveLength(1);
    expect(snapshot.findingEntries).toEqual([]);
    expect(snapshot.scopes[0]?.personaSessionHistory).toEqual([]);
  });

  it('derives report provenance and publication identity from an execution handle', () => {
    const { root } = createRealRunStorage();
    const owner = lease(root);
    const runtime = root.runtime({ lease: owner });
    const session = runtime.sessions.start({ sessionKey: 'provider-session' });
    const personaSession = runtime.runtimeValues.startPersonaSession({
      sessionKey: 'reviewer-session',
      personaName: 'architecture-reviewer',
    });
    const execution = runtime.execution.startStep({
      stepKey: 'reviewer',
      expectedScopeRevision: 0,
      session,
      personaSession,
    });
    const input = {
      streamName: 'review.json',
      expectedRevision: 0,
      codecName: 'json-v1',
      content: '{"result":"ok"}',
      producer: execution.handle,
    } as const;
    const first = runtime.reports.publish({
      ...input,
      publicationKey: 'round-1',
    });
    const replay = runtime.reports.publish({
      ...input,
      publicationKey: 'round-1',
    });

    expect(replay.revision).toBe(first.revision);
    expect(first.producerStepId).toBe('reviewer');
    expect(first.producerRunSessionId).not.toBeNull();
    expect(first.producerPersonaSessionId).not.toBeNull();
    expect(first.producerPersonaName).toBe('architecture-reviewer');
    expect(() => runtime.reports.publish({
      ...input,
      publicationKey: 'round-1',
      content: '{"result":"changed"}',
    })).toThrow(/revision|collision/i);
    expect(() => runtime.reports.publish({
      ...input,
      streamName: 'forged-cross-stream.json',
      publicationKey: 'round-1',
    })).toThrow(/collision/i);
    expect(() => runtime.reports.publish({
      ...input,
      publicationKey: 'raw-producer',
      producerName: 'forged',
    } as never)).toThrow(/unknown/i);
  });
});
