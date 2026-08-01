import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import {
  findPendingFindingConflictAdjudication,
  reserveFindingConflictAdjudication,
} from '../core/workflow/findings/adjudication-reservation.js';
import { commitFindingConflictAdjudication } from '../core/workflow/findings/adjudication-commit.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';
import {
  captureFindingLifecycleHead,
  findingLifecycleReservationMatchesCurrentHeads,
  reserveVerifiedLifecycleMutation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { applyRejectedObservationAttachments } from '../core/workflow/findings/manager-provisional-settlement.js';
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

function advanceConflictLifecycleHead(input: {
  ledger: FindingLedger;
  conflictId: string;
  timestamp: string;
}): FindingLedger {
  const conflict = input.ledger.conflicts.find(
    (candidate) => candidate.id === input.conflictId,
  )!;
  const { revision: _revision, ...projection } = conflict;
  void _revision;
  return applyFindingLifecycleCommands({
    ledger: input.ledger,
    commands: [{
      operation: 'observe_conflict',
      changes: { findings: [], conflicts: [projection] },
      authority: { kind: 'verified_evidence' },
      evidenceSourcesByTarget: new Map([[
        `conflict\0${conflict.id}`,
        {
          sourceRawFindingIds: conflict.rawFindingIds,
          authorityEvidenceIds: [],
        },
      ]]),
    }],
    occurredAt: {
      runId: 'run-2',
      stepName: 'reviewers',
      timestamp: input.timestamp,
    },
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

  it('replaces a source reservation after a target-only rejected observation and commits only to the target database', async () => {
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
    await targetStore.updateLedger((ledger) => ({
      ledger: applyRejectedObservationAttachments(ledger, [{
        targetFindingId: 'F-0001',
        rawFindingId: 'raw-current',
        reason: 'The imported observation is retained for audit only.',
        rejectionCode: 'evidence_admission_failed',
      }], {
        runId: 'run-2',
        stepName: 'reviewers',
        timestamp: '2026-06-14T00:01:00.000Z',
      }),
      result: undefined,
    }));
    const resumed = await reserveFindingConflictAdjudication({
      ledgerStore: targetStore,
      conflictId,
      requestedOriginStep: 'reviewers',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:02:00.000Z',
      },
      cwd,
    });
    expect(resumed.result).toMatchObject({
      started: true,
      originStep: 'final-gate',
      evidenceHash: sourceReservation.result.evidenceHash,
    });
    if (!resumed.result.started) {
      throw new Error('Expected resumed adjudication reservation');
    }
    expect(resumed.result.reservationToken).not.toBe(
      sourceReservation.result.reservationToken,
    );
    const resumedReservations = resumed.ledger.lifecycleReservations.filter(
      (reservation) => reservation.context.kind === 'conflict_adjudication',
    );
    expect(resumedReservations).toHaveLength(2);
    expect(resumedReservations[0]?.reservedAt.runId).toBe('run-1');
    expect(resumedReservations[1]?.reservedAt.runId).toBe('run-2');

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
      timestamp: '2026-06-14T00:03:00.000Z',
      originStep: resumed.result.originStep,
    });

    expect(committed.result).toMatchObject({ applied: true });
    expect(committed.ledger.lifecycleEvents.filter(
      (event) => event.outcome.kind === 'conflict_adjudication',
    )).toEqual([
      expect.objectContaining({
        mutationId: resumed.result.reservationToken,
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

  it('keeps a stale reservation as audit history, retries on the current head, and commits the new token', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const stale = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T02:00:00.000Z',
      },
      cwd,
    });
    if (!stale.result.started) {
      throw new Error('Expected initial adjudication reservation');
    }
    await store.updateLedger((ledger) => ({
      ledger: advanceConflictLifecycleHead({
        ledger,
        conflictId,
        timestamp: '2026-06-14T02:01:00.000Z',
      }),
      result: undefined,
    }));

    const adjudicationOutput = {
      conflictId,
      outcome: 'finding_stale' as const,
      rationale: 'The current source no longer exhibits the disputed finding.',
    };
    await expect(commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: stale.result.evidenceHash,
      reservationMutationId: 'missing-reservation-token',
      output: adjudicationOutput,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:02:00.000Z',
      originStep: stale.result.originStep,
    })).rejects.toThrow(/missing pre-reservation/);
    await expect(commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: stale.result.evidenceHash,
      reservationMutationId: stale.result.reservationToken,
      output: adjudicationOutput,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:02:00.000Z',
      originStep: 'reviewers',
    })).rejects.toThrow(/no longer matches pre-reservation/);

    const beforeDiscard = store.loadLedger();
    writeFileSync(join(cwd, 'src', 'example.ts'), 'export const example = false;\n');
    const evidenceChanged = await commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: stale.result.evidenceHash,
      reservationMutationId: stale.result.reservationToken,
      output: adjudicationOutput,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:02:00.000Z',
      originStep: stale.result.originStep,
    });
    expect(evidenceChanged.result).toMatchObject({
      applied: false,
      reason: expect.stringContaining('evidence changed'),
      freshEvidenceHash: expect.any(String),
    });
    if (evidenceChanged.result.applied) {
      throw new Error('Expected changed evidence to discard the adjudication');
    }
    expect(evidenceChanged.result.freshEvidenceHash).not.toBe(stale.result.evidenceHash);
    expect(evidenceChanged.ledger).toEqual(beforeDiscard);
    writeFileSync(join(cwd, 'src', 'example.ts'), 'export const example = true;\n');

    const discarded = await commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: stale.result.evidenceHash,
      reservationMutationId: stale.result.reservationToken,
      output: adjudicationOutput,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:02:00.000Z',
      originStep: stale.result.originStep,
    });
    expect(discarded.result).toMatchObject({
      applied: false,
      reason: expect.stringContaining('full head changed'),
    });
    expect(discarded.ledger).toEqual(beforeDiscard);
    expect(store.loadLedger()).toEqual(beforeDiscard);

    const current = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'reviewers',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T02:03:00.000Z',
      },
      cwd,
    });
    if (!current.result.started) {
      throw new Error('Expected replacement adjudication reservation');
    }
    expect(current.result).toMatchObject({
      evidenceHash: stale.result.evidenceHash,
      originStep: 'final-gate',
    });
    expect(current.result.reservationToken).not.toBe(stale.result.reservationToken);
    const currentReservation = current.ledger.lifecycleReservations.find(
      (reservation) => reservation.mutationId === current.result.reservationToken,
    )!;
    expect(findingLifecycleReservationMatchesCurrentHeads(
      current.ledger,
      currentReservation,
    )).toBe(true);

    const committed = await commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: current.result.evidenceHash,
      reservationMutationId: current.result.reservationToken,
      output: adjudicationOutput,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:04:00.000Z',
      originStep: current.result.originStep,
    });
    expect(committed.result).toMatchObject({ applied: true });
    expect(committed.ledger.lifecycleEvents.some(
      (event) => event.mutationId === stale.result.reservationToken,
    )).toBe(false);
    expect(committed.ledger.lifecycleEvents).toContainEqual(expect.objectContaining({
      mutationId: current.result.reservationToken,
    }));
  });

  it('reports an existing adjudication before the consumed reservation full-head mismatch', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T02:10:00.000Z',
      },
      cwd,
    });
    if (!reservation.result.started) {
      throw new Error('Expected adjudication reservation');
    }
    const output = {
      conflictId,
      outcome: 'undetermined' as const,
      rationale: 'The available evidence does not establish either conclusion.',
    };
    const applied = await commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: reservation.result.evidenceHash,
      reservationMutationId: reservation.result.reservationToken,
      output,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:11:00.000Z',
      originStep: reservation.result.originStep,
    });
    expect(applied.result).toMatchObject({ applied: true });
    const afterApplied = store.loadLedger();

    const repeated = await commitFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      promptedEvidenceHash: reservation.result.evidenceHash,
      reservationMutationId: reservation.result.reservationToken,
      output,
      cwd,
      workflowName: WORKFLOW_NAME,
      stepName: 'finding-conflict-adjudication',
      runId: 'run-2',
      timestamp: '2026-06-14T02:12:00.000Z',
      originStep: reservation.result.originStep,
    });
    expect(repeated.result).toMatchObject({
      applied: false,
      reason: expect.stringContaining('already adjudicated'),
      freshEvidenceHash: reservation.result.evidenceHash,
    });
    expect(repeated.ledger).toEqual(afterApplied);
    expect(store.loadLedger()).toEqual(afterApplied);
  });

  it('inherits a durable null origin when replacing a stale reservation', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const stale = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: undefined,
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T03:00:00.000Z',
      },
      cwd,
    });
    if (!stale.result.started) {
      throw new Error('Expected initial adjudication reservation');
    }
    await store.updateLedger((ledger) => ({
      ledger: advanceConflictLifecycleHead({
        ledger,
        conflictId,
        timestamp: '2026-06-14T03:01:00.000Z',
      }),
      result: undefined,
    }));

    const current = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'reviewers',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T03:02:00.000Z',
      },
      cwd,
    });
    if (!current.result.started) {
      throw new Error('Expected replacement adjudication reservation');
    }
    expect(current.result.originStep).toBeUndefined();
    expect(current.result.reservationToken).not.toBe(stale.result.reservationToken);
    expect(current.ledger.lifecycleReservations.find(
      (reservation) => reservation.mutationId === current.result.reservationToken,
    )?.context).toMatchObject({
      kind: 'conflict_adjudication',
      originStep: null,
    });
  });

  it('selects the current reservation after multiple stale reservations without consuming history', async () => {
    const store = createStore();
    const initial = makeLedger(cwd);
    await store.updateLedger(() => ({ ledger: initial, result: undefined }));
    const conflictId = initial.conflicts[0]!.id;
    const reservations = [];
    for (let index = 0; index < 3; index += 1) {
      const reserved = await reserveFindingConflictAdjudication({
        ledgerStore: store,
        conflictId,
        requestedOriginStep: index === 0 ? 'final-gate' : 'reviewers',
        runId: 'run-2',
        observation: {
          runId: 'run-2',
          stepName: 'finding-conflict-adjudication',
          timestamp: `2026-06-14T04:0${index * 2}:00.000Z`,
        },
        cwd,
      });
      if (!reserved.result.started) {
        throw new Error('Expected adjudication reservation');
      }
      reservations.push(reserved.result);
      if (index < 2) {
        await store.updateLedger((ledger) => ({
          ledger: advanceConflictLifecycleHead({
            ledger,
            conflictId,
            timestamp: `2026-06-14T04:0${index * 2 + 1}:00.000Z`,
          }),
          result: undefined,
        }));
      }
    }

    const ledger = store.loadLedger();
    expect(new Set(reservations.map((reservation) => reservation.reservationToken)).size)
      .toBe(3);
    expect(reservations.map((reservation) => reservation.originStep))
      .toEqual(['final-gate', 'final-gate', 'final-gate']);
    const adjudicationReservations = ledger.lifecycleReservations.filter(
      (reservation) => reservation.context.kind === 'conflict_adjudication',
    );
    expect(adjudicationReservations).toHaveLength(3);
    expect(ledger.lifecycleEvents.some((event) => (
      reservations.some((reservation) => reservation.reservationToken === event.mutationId)
    ))).toBe(false);
    expect(findPendingFindingConflictAdjudication({
      ledger,
      conflictId,
      evidenceHash: reservations[2]!.evidenceHash,
    })?.mutationId).toBe(reservations[2]!.reservationToken);
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
