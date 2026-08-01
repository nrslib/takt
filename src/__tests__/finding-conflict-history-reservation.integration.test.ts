import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import { commitFindingConflictAdjudication } from '../core/workflow/findings/adjudication-commit.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';
import {
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import type { FindingLedger, RawFinding } from '../core/workflow/findings/types.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';

const WORKFLOW_NAME = 'peer-review';
function makeLedger(cwd: string): FindingLedger {
  const observation = {
    runId: 'run-1',
    stepName: 'final-gate',
    timestamp: '2017-01-01T00:00:00.000Z',
  };
  const baseRawFinding: RawFinding = {
    rawFindingId: 'raw-base',
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Conflicting review conclusion',
    description: 'The review evidence conflicts.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence: [],
  };
  const baseLedger = authorizeFindingLedgerFixture({
    workflowName: WORKFLOW_NAME,
    nextId: 2,
    updatedAt: observation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: baseRawFinding.title,
      description: baseRawFinding.description,
      evidenceIds: [],
      reviewers: [baseRawFinding.reviewer],
      rawFindingIds: [baseRawFinding.rawFindingId],
      firstSeen: observation,
      lastSeen: observation,
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [baseRawFinding],
    interpretations: [],
    conflicts: [],
  });
  const evidence = verifiedFindingEvidenceFixture({
    cwd,
    path: 'src/example.ts',
    startLine: 1,
    title: 'Conflicting review conclusion',
    description: 'The review evidence conflicts.',
    familyTag: 'bug',
    targetFindingId: 'F-0001',
  });
  const rawFinding: RawFinding = {
    rawFindingId: 'raw-current',
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Conflicting review conclusion',
    description: 'The review evidence conflicts.',
    suggestion: null,
    relation: 'persists',
    targetFindingId: 'F-0001',
    targetPrecondition: captureFindingMutationPrecondition(baseLedger, 'F-0001')!,
    evidence: [evidence.evidence],
  };
  const conflictId = formatConflictId({
    findingIds: ['F-0001'],
    rawFindingIds: [rawFinding.rawFindingId],
  });

  return authorizeFindingLedgerFixture({
    workflowName: WORKFLOW_NAME,
    nextId: 2,
    updatedAt: observation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: rawFinding.title,
      description: rawFinding.description,
      evidenceIds: [],
      reviewers: [rawFinding.reviewer],
      rawFindingIds: [baseRawFinding.rawFindingId],
      firstSeen: observation,
      lastSeen: observation,
    }],
    evidenceRecords: [evidence.record],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [baseRawFinding, rawFinding],
    interpretations: [],
    conflicts: [{
      id: conflictId,
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [rawFinding.rawFindingId],
      description: 'Existing conflict.',
      firstSeen: observation,
      lastSeen: observation,
      revision: 1,
    }],
  });
}

describe('conflict lifecycle reservation persistence', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-conflict-history-reservation-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(join(cwd, '.takt', 'runs', 'run-2', 'reports'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'example.ts'), 'export const example = true;\n');
    writeFileSync(join(cwd, '.gitignore'), '.takt/\n');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd });
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  function createStore(runId = 'run-2', sourceRunId?: string) {
    return createTestFindingLedgerStore({
      projectCwd: cwd,
      runId,
      reportDir: join(cwd, '.takt', 'runs', runId, 'reports'),
      workflowName: WORKFLOW_NAME,
      ...(sourceRunId === undefined ? {} : { sourceRunId }),
    });
  }

  it('reuses the persisted pending mutation with its original origin after reopening the store', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;

    const first = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2017-01-01T01:00:00.000+01:00',
      },
      cwd,
    });
    expect(first.result).toMatchObject({ started: true, originStep: 'final-gate' });
    expect(first.ledger.lifecycleReservations).toHaveLength(
      initial.lifecycleReservations.length + 1,
    );
    expect(first.ledger.lifecycleEvents).toEqual(initial.lifecycleEvents);
    expect(first.ledger.lifecycleReservations.at(-1)?.reservedAt.timestamp)
      .toBe('2017-01-01T00:00:00.000Z');

    const reopenedStore = createStore();
    const resumed = await reserveFindingConflictAdjudication({
      ledgerStore: reopenedStore,
      conflictId,
      requestedOriginStep: undefined,
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });

    expect(resumed.result).toEqual(first.result);
    expect(resumed.ledger.lifecycleReservations).toEqual(first.ledger.lifecycleReservations);
    expect(resumed.ledger.lifecycleEvents).toEqual(first.ledger.lifecycleEvents);
  });

  it('reuses a source run pending mutation in the resumed run and commits only to the target database', async () => {
    mkdirSync(join(cwd, '.takt', 'runs', 'run-1', 'reports'), { recursive: true });
    const sourceStore = createStore('run-1');
    const initial = makeLedger(cwd);
    await sourceStore.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const sourceReservation = await reserveFindingConflictAdjudication({
      ledgerStore: sourceStore,
      conflictId,
      requestedOriginStep: 'final-gate',
      runId: 'run-1',
      observation: {
        runId: 'run-1',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:00:00.000Z',
      },
      cwd,
    });
    if (!sourceReservation.result.started) {
      throw new Error('Expected source adjudication reservation');
    }
    const sourceBeforeResume = sourceStore.loadLedger();

    const targetStore = createStore('run-2', 'run-1');
    const resumed = await reserveFindingConflictAdjudication({
      ledgerStore: targetStore,
      conflictId,
      requestedOriginStep: 'reviewers',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });
    expect(resumed.result).toMatchObject({
      started: true,
      originStep: 'final-gate',
      reservationToken: sourceReservation.result.reservationToken,
    });
    const resumedReservations = resumed.ledger.lifecycleReservations.filter(
      (reservation) => reservation.context.kind === 'conflict_adjudication',
    );
    expect(resumedReservations).toHaveLength(1);
    expect(resumedReservations[0]?.reservedAt.runId).toBe('run-1');

    if (!resumed.result.started) {
      throw new Error('Expected resumed adjudication reservation');
    }
    const committed = await commitFindingConflictAdjudication({
      ledgerStore: targetStore,
      conflictId,
      promptedEvidenceHash: resumed.result.evidenceHash,
      reservationMutationId: resumed.result.reservationToken,
      output: {
        conflictId,
        outcome: 'finding_stale',
        rationale: 'The current source no longer exhibits the disputed finding.',
      },
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T00:02:00.000Z',
      originStep: resumed.result.originStep,
    });

    expect(committed.result).toMatchObject({ applied: true });
    expect(committed.ledger.lifecycleEvents.filter(
      (event) => event.outcome.kind === 'conflict_adjudication',
    )).toEqual([
      expect.objectContaining({
        mutationId: sourceReservation.result.reservationToken,
        occurredAt: expect.objectContaining({ runId: 'run-2' }),
      }),
    ]);
    expect(sourceStore.loadLedger()).toEqual(sourceBeforeResume);
  });

  it('keeps a persisted null origin when the resumed run supplies a new origin candidate', async () => {
    const sourceRunId = 'run-null-origin-source';
    const targetRunId = 'run-null-origin-target';
    mkdirSync(join(cwd, '.takt', 'runs', sourceRunId, 'reports'), { recursive: true });
    mkdirSync(join(cwd, '.takt', 'runs', targetRunId, 'reports'), { recursive: true });
    const sourceStore = createStore(sourceRunId);
    const initial = makeLedger(cwd);
    await sourceStore.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const sourceReservation = await reserveFindingConflictAdjudication({
      ledgerStore: sourceStore,
      conflictId,
      requestedOriginStep: undefined,
      runId: sourceRunId,
      observation: {
        runId: sourceRunId,
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T01:00:00.000Z',
      },
      cwd,
    });
    if (!sourceReservation.result.started) {
      throw new Error('Expected source adjudication reservation');
    }
    const sourceBeforeResume = sourceStore.loadLedger();
    const sourcePending = sourceBeforeResume.lifecycleReservations.find(
      (reservation) => reservation.mutationId === sourceReservation.result.reservationToken,
    )!;
    expect(sourcePending.context).toMatchObject({
      kind: 'conflict_adjudication',
      originStep: null,
    });

    const targetStore = createStore(targetRunId, sourceRunId);
    const resumed = await reserveFindingConflictAdjudication({
      ledgerStore: targetStore,
      conflictId,
      requestedOriginStep: 'reviewers',
      runId: targetRunId,
      observation: {
        runId: targetRunId,
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T01:01:00.000Z',
      },
      cwd,
    });
    expect(resumed.result).toMatchObject({
      started: true,
      reservationToken: sourceReservation.result.reservationToken,
    });
    expect(resumed.result.originStep).toBeUndefined();
    expect(resumed.ledger.lifecycleReservations.find(
      (reservation) => reservation.mutationId === sourceReservation.result.reservationToken,
    )).toEqual(sourcePending);

    if (!resumed.result.started) {
      throw new Error('Expected resumed adjudication reservation');
    }
    const committed = await commitFindingConflictAdjudication({
      ledgerStore: targetStore,
      conflictId,
      promptedEvidenceHash: resumed.result.evidenceHash,
      reservationMutationId: resumed.result.reservationToken,
      output: {
        conflictId,
        outcome: 'finding_stale',
        rationale: 'The current source no longer exhibits the disputed finding.',
      },
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: targetRunId,
      timestamp: '2026-06-14T01:02:00.000Z',
    });

    expect(committed.result).toMatchObject({ applied: true });
    expect(committed.ledger.lifecycleEvents).toContainEqual(expect.objectContaining({
      mutationId: sourceReservation.result.reservationToken,
      occurredAt: expect.objectContaining({ runId: targetRunId }),
    }));
    expect(sourceStore.loadLedger()).toEqual(sourceBeforeResume);
  });

  it('rejects a same-revision reservation when another full-head field is stale', () => {
    const ledger = makeLedger(cwd);
    const conflict = ledger.conflicts[0]!;
    const currentHead = captureFindingLifecycleHead(ledger, 'conflict', conflict.id)!;
    const reservation = createFindingLifecycleReservation({
      operation: 'resolve_conflict',
      targets: [{
        entityKind: 'conflict',
        entityId: conflict.id,
        expectedHead: {
          ...currentHead,
          projectionDigest: 'f'.repeat(64),
        },
      }],
      evidenceBindingIds: [],
      authority: {
        kind: 'engine_policy',
        decisionKind: 'resolve_conflict',
        decisionDigest: 'a'.repeat(64),
      },
      context: { kind: 'transaction' },
      reservedAt: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
    });

    expect(() => reserveVerifiedLifecycleMutation(ledger, {
      reservation,
      evidenceBindings: [],
    })).toThrow(/stale full head/);
  });

  it('rejects replacement of an existing reservation prefix and keeps the persisted pending entry', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const first = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: initial.conflicts[0]!.id,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });
    const reordered = {
      ...first.ledger,
      lifecycleReservations: [...first.ledger.lifecycleReservations].reverse(),
    };

    await expect(store.updateLedger(() => ({
      ledger: reordered,
      result: undefined,
    }))).rejects.toThrow(/registry prefix changed/);
    expect(store.loadLedger().lifecycleReservations).toEqual(first.ledger.lifecycleReservations);
  });

  it('rejects an invalid reservation timestamp without losing the reusable pending mutation', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const first = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: initial.conflicts[0]!.id,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });
    const invalid = structuredClone(first.ledger);
    invalid.lifecycleReservations.at(-1)!.reservedAt.timestamp = '2026-06-12T22:15:00.0001Z';

    await expect(store.updateLedger(() => ({
      ledger: invalid,
      result: undefined,
    }))).rejects.toThrow('Expected an RFC 3339 timestamp');
    expect(store.loadLedger().lifecycleReservations).toEqual(first.ledger.lifecycleReservations);
  });
});
