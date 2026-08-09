import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';
import { applyManagerDecisionLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { reconcileFindingLedgerPlan } from '../core/workflow/findings/reconciler.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import type {
  FindingEvidenceRecord,
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import { refreshActiveConflictAdjudicationSnapshots } from '../core/workflow/findings/conflict-adjudication-model.js';

const WORKFLOW_NAME = 'peer-review';
function makeRawFinding(
  rawFindingId: string,
  evidence: RawFinding['evidence'] = [],
): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Conflicting review conclusion',
    description: 'The review evidence conflicts.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    evidence,
  });
}

function makeManagerOutput(rawFindingId: string): FindingManagerOutput {
  return {
    anchorAdjudications: [createAnchorAdjudication({
      rawFindingId,
      decision: 'conflict',
      findingId: 'F-0001',
      anchorRelevance: 'not_applicable',
      evidence: 'Reobserved conflict.',
    })],
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [{
      findingIds: ['F-0001'],
      rawFindingIds: [rawFindingId],
      description: 'Reobserved conflict.',
    }],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

function makeUnlandedLedger(
  cwd: string,
  conflictRawFindingIds: readonly string[] = ['raw-previous', 'raw-generated'],
  rawRelation: 'new' | 'persists' = 'new',
): FindingLedger {
  const leapSecondObservation = {
    runId: 'run-0',
    stepName: 'reviewers',
    timestamp: '2016-12-31T23:59:60.500Z',
  };
  const nextMinuteObservation = {
    runId: 'run-1',
    stepName: 'final-gate',
    timestamp: '2017-01-01T00:00:00.000Z',
  };
  const conflictId = formatConflictId({
    findingIds: ['F-0001'],
    rawFindingIds: ['raw-generated'],
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

  const fixture = {
    workflowName: WORKFLOW_NAME,
    nextId: 2,
    updatedAt: nextMinuteObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: 'high',
      title: 'Conflicting review conclusion',
      description: 'The review evidence conflicts.',
      evidenceIds: [evidence.record.evidenceId],
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-previous'],
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
    }],
    evidenceRecords: [evidence.record],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [
      makeRawFinding('raw-previous', [evidence.evidence]),
      makeRawFinding('raw-generated', [evidence.evidence]),
    ].map((raw) => rawRelation === 'new'
      ? raw
      : { ...raw, relation: rawRelation, targetFindingId: 'F-0001' }),
    conflicts: [{
      id: conflictId,
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [...conflictRawFindingIds],
      description: 'Existing conflict.',
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
      revision: 1,
    }],
  };
  const authorized = authorizeFindingLedgerFixture(fixture);
  if (rawRelation === 'new') {
    return authorized;
  }
  const targetPrecondition = captureFindingMutationPrecondition(authorized, 'F-0001');
  if (targetPrecondition === undefined) {
    throw new Error('Fixture finding F-0001 has no target precondition');
  }
  const rawFindings = authorized.rawFindings.map((raw) => ({
    ...raw,
    relation: rawRelation,
    targetFindingId: 'F-0001',
    targetPrecondition,
  }));
  return authorizeFindingLedgerFixture({
    ...fixture,
    rawFindings,
  });
}

function makeLedger(cwd: string): FindingLedger {
  const unlanded = makeUnlandedLedger(cwd);
  return refreshActiveConflictAdjudicationSnapshots({
    ledger: landUnownedConflictRawClaims({
      ledger: unlanded,
      observation: {
        runId: 'run-1',
        stepName: 'final-gate',
        timestamp: '2017-01-01T00:00:00.000Z',
      },
    }),
    originStep: 'final-gate',
    createdAt: {
      runId: 'run-1',
      stepName: 'final-gate',
      timestamp: '2017-01-01T00:00:00.000Z',
    },
  });
}

function reconcileCurrentRaw(input: {
  cwd: string;
  previousLedger: FindingLedger;
  rawFinding: RawFinding;
  evidenceRecord: FindingEvidenceRecord;
  managerOutput: FindingManagerOutput;
}): ReturnType<typeof reconcileFindingLedgerPlan> {
  return reconcileFindingLedgerPlan({
    previousLedger: input.previousLedger,
    rawFindings: [input.rawFinding],
    managerOutput: input.managerOutput,
    entityProvisionalMutations: [],
    terminalEntityAttachmentFindingIds: new Set(),
    provisionalFindings: [],
    verifiedEvidenceRecordsByRawFindingId: new Map([[
      input.rawFinding.rawFindingId,
      [input.evidenceRecord],
    ]]),
    rawProvenanceByRawFindingId: new Map([[
      input.rawFinding.rawFindingId,
      storedRawReconcileProvenance(
        input.rawFinding,
        computeReviewerStableKey({
          workflowName: WORKFLOW_NAME,
          callNamespace: '',
          parentStepName: 'reviewers',
          reviewerPersonaKey: input.rawFinding.reviewer,
        }),
        computeLineageKey({
          claimIdentityHash: computeClaimIdentityHash(input.rawFinding),
        }),
      ),
    ]]),
    context: {
      workflowName: WORKFLOW_NAME,
      stepName: 'reviewers',
      runId: 'run-2',
      timestamp: '2017-01-01T00:01:00.000Z',
    },
  });
}

describe('reconciled conflict lifecycle history order', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-conflict-history-order-'));
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

  it('appends a later conflict landing after the first-round landing', () => {
    const unlanded = makeUnlandedLedger(cwd);
    const sortedLandings = landUnownedConflictRawClaims({
      ledger: unlanded,
      observation: {
        runId: 'run-order-probe',
        stepName: 'reviewers',
        timestamp: '2017-01-01T00:00:00.000Z',
      },
    }).conflictRawClaimLandings;
    const firstRawFindingId = sortedLandings[1]!.rawFindingId;
    const secondRawFindingId = sortedLandings[0]!.rawFindingId;
    const firstRound = landUnownedConflictRawClaims({
      ledger: makeUnlandedLedger(cwd, [firstRawFindingId], 'persists'),
      observation: {
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp: '2017-01-01T00:00:00.000Z',
      },
    });
    const conflict = firstRound.conflicts[0]!;
    const secondRoundObservation = {
      runId: 'run-2',
      stepName: 'reviewers',
      timestamp: '2017-01-01T00:01:00.000Z',
    };
    const updatedConflict = {
      ...conflict,
      rawFindingIds: [firstRawFindingId, secondRawFindingId],
      lastSeen: secondRoundObservation,
      revision: conflict.revision + 1,
    };
    const { revision: _revision, ...conflictProjection } = updatedConflict;
    void _revision;
    const afterFix = applyManagerDecisionLifecycleCommands({
      current: firstRound,
      proposed: {
        ...firstRound,
        conflicts: [updatedConflict],
      },
      commands: [{
        operation: 'observe_conflict',
        changes: { findings: [], conflicts: [conflictProjection] },
        authority: { kind: 'verified_evidence' },
        evidenceSourcesByTarget: new Map([[
          `conflict\0${conflict.id}`,
          { sourceRawFindingIds: [secondRawFindingId], authorityEvidenceIds: [] },
        ]]),
      }],
      occurredAt: secondRoundObservation,
    });
    const secondRound = landUnownedConflictRawClaims({
      ledger: afterFix,
      observation: secondRoundObservation,
    });

    expect(secondRound.conflictRawClaimLandings.map((landing) => landing.rawFindingId))
      .toEqual([firstRawFindingId, secondRawFindingId]);
  });

  it('preserves completed decisions and appends lifecycle authority through reconcile, persistence, and reservation', async () => {
    const previousLedger = makeLedger(cwd);
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
      ...makeRawFinding('raw-current', [evidence.evidence]),
      relation: 'persists',
      targetFindingId: 'F-0001',
      targetPrecondition: captureFindingMutationPrecondition(previousLedger, 'F-0001')!,
    };
    const managerOutput = makeManagerOutput(rawFinding.rawFindingId);
    const reconciledPlan = reconcileCurrentRaw({
      cwd,
      previousLedger,
      rawFinding,
      evidenceRecord: evidence.record,
      managerOutput,
    });
    const reconciled = reconciledPlan.ledger;
    const conflictId = previousLedger.conflicts[0]!.id;

    expect(reconciled.conflicts).toHaveLength(1);
    expect(reconciled.conflicts[0]).toMatchObject({
      id: conflictId,
      firstSeen: {
        runId: 'run-0',
        stepName: 'reviewers',
        timestamp: '2016-12-31T23:59:60.500Z',
      },
      rawFindingIds: ['raw-previous', 'raw-generated', 'raw-current'].sort(compareBinaryStrings),
    });
    expect(reconciled.conflicts[0]).not.toHaveProperty('adjudications');
    expect(reconciled.conflictAdjudicationSnapshots)
      .toEqual(previousLedger.conflictAdjudicationSnapshots);
    expect(reconciled.conflictAdjudicationEpisodes)
      .toEqual(previousLedger.conflictAdjudicationEpisodes);
    expect(reconciled.conflictAdjudicationAttempts)
      .toEqual(previousLedger.conflictAdjudicationAttempts);
    expect(reconciled.conflictClaimSettlements)
      .toEqual(previousLedger.conflictClaimSettlements);
    expect(reconciled.lifecycleReservations).toEqual(previousLedger.lifecycleReservations);
    expect(reconciled.lifecycleEvents).toEqual(previousLedger.lifecycleEvents);

    const applied = applyManagerDecisionLifecycleCommands({
      current: previousLedger,
      proposed: reconciled,
      commands: reconciledPlan.lifecycleCommands,
      occurredAt: {
        runId: 'run-2',
        stepName: 'reviewers',
        timestamp: '2017-01-01T00:01:00.000Z',
      },
    });
    expect(applied.lifecycleReservations.slice(0, previousLedger.lifecycleReservations.length))
      .toEqual(previousLedger.lifecycleReservations);
    expect(applied.lifecycleEvents.slice(0, previousLedger.lifecycleEvents.length))
      .toEqual(previousLedger.lifecycleEvents);
    expect(applied.lifecycleReservations.at(-1)?.operation).toBe('observe_conflict');
    expect(applied.lifecycleEvents.at(-1)).toMatchObject({
      mutationId: applied.lifecycleReservations.at(-1)?.mutationId,
      operation: 'observe_conflict',
      transitions: [{
        before: captureFindingLifecycleHead(previousLedger, 'conflict', conflictId),
        after: {
          entityKind: 'conflict',
          entityId: conflictId,
          revision: 2,
        },
      }],
    });

    const contractObservation = {
      runId: 'run-2',
      stepName: 'reviewers',
      timestamp: '2017-01-01T00:01:00.000Z',
    };
    const contractReady = refreshActiveConflictAdjudicationSnapshots({
      ledger: landUnownedConflictRawClaims({
        ledger: {
          ...applied,
          rawCanonicalSnapshots: [
            ...applied.rawCanonicalSnapshots,
            rawCanonicalSnapshotFixture(rawFinding, contractObservation),
          ],
        },
        observation: contractObservation,
      }),
      originStep: 'reviewers',
      createdAt: contractObservation,
    });
    const store = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-2',
      reportDir: join(cwd, '.takt', 'runs', 'run-2', 'reports'),
      workflowName: WORKFLOW_NAME,
    });
    await store.updateLedger(() => ({ ledger: contractReady, result: undefined }));
    const persisted = store.loadLedger();
    expect(persisted.lifecycleReservations).toEqual(contractReady.lifecycleReservations);
    expect(persisted.lifecycleEvents).toEqual(contractReady.lifecycleEvents);
    expect(persisted.conflicts[0]).not.toHaveProperty('adjudications');
    expect(persisted.conflictAdjudicationSnapshots)
      .toEqual(contractReady.conflictAdjudicationSnapshots);
    expect(persisted.conflictAdjudicationEpisodes).toEqual([]);
    expect(persisted.conflictAdjudicationAttempts).toEqual([]);
    expect(persisted.conflictClaimSettlements).toEqual([]);

    const snapshot = persisted.conflictAdjudicationSnapshots.find((candidate) => (
      candidate.conflictId === conflictId
      && candidate.expectedConflictHead.revision === 2
    ));
    expect(snapshot).toBeDefined();

    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      expectedSnapshotId: snapshot!.conflictSnapshotId,
      requestedOriginStep: 'final-gate',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2017-01-01T00:02:00.000Z',
      },
      requestBytes: '{"kind":"conflict-adjudication"}',
      scopeIdentity: store.ledgerIdentity,
      workflowName: WORKFLOW_NAME,
      roundMarker: 'history-order-round',
    });

    expect(reservation.result).toMatchObject({
      started: true,
      originStep: 'final-gate',
    });
    expect(reservation.ledger.lifecycleReservations).toEqual(contractReady.lifecycleReservations);
    expect(reservation.ledger.lifecycleEvents).toEqual(contractReady.lifecycleEvents);
    expect(reservation.ledger.conflictAdjudicationEpisodes).toEqual([
      expect.objectContaining({ conflictSnapshotId: snapshot!.conflictSnapshotId }),
    ]);
    expect(reservation.ledger.conflictAdjudicationAttempts).toEqual([
      expect.objectContaining({
        conflictSnapshotId: snapshot!.conflictSnapshotId,
        originStep: 'final-gate',
        stage: 'started',
      }),
    ]);
    expect(reservation.ledger.findingManagerProviderCalls).toEqual([
      expect.objectContaining({ purpose: 'conflict_adjudication', state: 'reserved' }),
    ]);
  });
});
