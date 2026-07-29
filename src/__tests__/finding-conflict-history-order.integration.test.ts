import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';
import { applyManagerDecisionLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import { reconcileFindingLedgerPlan } from '../core/workflow/findings/reconciler.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type {
  FindingEvidenceRecord,
  FindingLedger,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { verifiedFindingEvidenceFixture } from './helpers/finding-evidence.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import { authorizeFindingLedgerFixture } from './helpers/finding-lifecycle-fixture.js';

const WORKFLOW_NAME = 'peer-review';
const LEDGER_PATH = '.takt/findings/peer-review.json';
const RAW_FINDINGS_PATH = '.takt/findings/raw';

function makeRawFinding(
  rawFindingId: string,
  evidence: RawFinding['evidence'] = [],
): RawFinding {
  return {
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
  };
}

function makeManagerOutput(rawFindingId: string): FindingManagerOutput {
  return {
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

function makeLedger(): FindingLedger {
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

  return authorizeFindingLedgerFixture({
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
      evidenceIds: [],
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-previous'],
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [
      makeRawFinding('raw-previous'),
      makeRawFinding('raw-generated'),
    ],
    interpretations: [],
    conflicts: [{
      id: conflictId,
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-previous', 'raw-generated'],
      description: 'Existing conflict.',
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
      adjudications: [{
        evidenceHash: '1'.repeat(64),
        outcome: 'undetermined',
        rationale: 'Previous conflicting evidence.',
        decidedAt: leapSecondObservation,
      }, {
        evidenceHash: '2'.repeat(64),
        outcome: 'undetermined',
        rationale: 'Same-timestamp conflicting evidence.',
        decidedAt: nextMinuteObservation,
      }, {
        evidenceHash: '3'.repeat(64),
        outcome: 'undetermined',
        rationale: 'Generated conflicting evidence.',
        decidedAt: nextMinuteObservation,
      }],
      revision: 1,
    }],
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
    provisionalFindings: [],
    rawFindingDispositions: [],
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

  it('preserves completed decisions and appends lifecycle authority through reconcile, persistence, and reservation', async () => {
    const previousLedger = makeLedger();
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
    expect(reconciled.conflicts[0]?.adjudications?.map((record) => record.evidenceHash)).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
    ]);
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

    const store = createFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-2',
      reportDir: join(cwd, '.takt', 'runs', 'run-2', 'reports'),
      workflowName: WORKFLOW_NAME,
      ledgerPath: LEDGER_PATH,
      rawFindingsPath: RAW_FINDINGS_PATH,
    });
    await store.updateLedger(() => ({ ledger: applied, result: undefined }));
    const persisted = store.loadLedger();
    expect(persisted.lifecycleReservations).toEqual(applied.lifecycleReservations);
    expect(persisted.lifecycleEvents).toEqual(applied.lifecycleEvents);
    expect(persisted.conflicts[0]?.adjudications).toEqual(applied.conflicts[0]?.adjudications);

    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: 'final-gate',
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2017-01-01T00:02:00.000Z',
      },
      cwd,
    });

    expect(reservation.result).toMatchObject({
      started: true,
      originStep: 'final-gate',
    });
    expect(reservation.ledger.lifecycleReservations.slice(0, applied.lifecycleReservations.length))
      .toEqual(applied.lifecycleReservations);
    expect(reservation.ledger.lifecycleEvents).toEqual(applied.lifecycleEvents);
    expect(reservation.ledger.lifecycleReservations.at(-1)).toMatchObject({
      mutationId: reservation.result.started ? reservation.result.reservationToken : undefined,
      operation: 'apply_conflict_adjudication',
      context: {
        kind: 'conflict_adjudication',
        conflictId,
        originStep: 'final-gate',
      },
      targets: expect.arrayContaining([
        expect.objectContaining({
          entityKind: 'finding',
          entityId: 'F-0001',
          expectedHead: captureFindingLifecycleHead(applied, 'finding', 'F-0001'),
        }),
        expect.objectContaining({
          entityKind: 'conflict',
          entityId: conflictId,
          expectedHead: captureFindingLifecycleHead(applied, 'conflict', conflictId),
        }),
      ]),
    });
  });
});
