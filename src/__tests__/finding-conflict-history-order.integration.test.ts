import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import { computeLineageKey, computeReviewerStableKey } from '../core/workflow/findings/raw-canonicalization.js';
import type { FindingLedger, FindingManagerOutput, RawFinding } from '../core/workflow/findings/types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';

const WORKFLOW_NAME = 'peer-review';
const LEDGER_PATH = '.takt/findings/peer-review.json';
const RAW_FINDINGS_PATH = '.takt/findings/raw';

function makeRawFinding(rawFindingId: string): RawFinding {
  return {
    rawFindingId,
    stepName: 'reviewers',
    reviewer: 'coding-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Conflicting review conclusion',
    location: 'src/example.ts:1',
    description: 'The review evidence conflicts.',
    relation: 'new',
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
  const generatedConflictId = formatConflictId({
    findingIds: ['F-0001'],
    rawFindingIds: ['raw-generated'],
  });

  return {
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
      location: 'src/example.ts:1',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-previous'],
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
    }],
    rawFindings: [
      makeRawFinding('raw-previous'),
      makeRawFinding('raw-generated'),
    ],
    interpretations: [],
    conflicts: [
      {
        id: generatedConflictId,
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-previous', 'raw-generated'],
        description: 'Existing conflict.',
        firstSeen: leapSecondObservation,
        lastSeen: nextMinuteObservation,
        adjudications: [{
          evidenceHash: 'previous-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Previous conflicting evidence.'],
          actionableFix: '',
          decidedAt: leapSecondObservation,
        }, {
          evidenceHash: 'a-current-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Same-timestamp conflicting evidence.'],
          actionableFix: '',
          decidedAt: nextMinuteObservation,
        }, {
          evidenceHash: 'z-current-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Generated conflicting evidence.'],
          actionableFix: '',
          decidedAt: nextMinuteObservation,
        }],
        adjudicationAttempts: [{
          evidenceHash: 'previous-attempt',
          reservationToken: 'previous-reservation',
          startedAt: leapSecondObservation,
          originStep: 'reviewers',
        }, {
          evidenceHash: 'a-current-attempt',
          reservationToken: 'current-tie-reservation',
          startedAt: nextMinuteObservation,
          originStep: 'reviewers',
        }, {
          evidenceHash: 'z-current-attempt',
          reservationToken: 'current-reservation',
          startedAt: nextMinuteObservation,
          originStep: 'final-gate',
        }],
      },
    ],
  };
}

describe('reconciled conflict history order', () => {
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

  it('should preserve chronological histories through reconciliation, persistence, and reservation', async () => {
    const conflictId = formatConflictId({
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-generated'],
    });
    const store = createFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run-2',
      reportDir: join(cwd, '.takt', 'runs', 'run-2', 'reports'),
      workflowName: WORKFLOW_NAME,
      ledgerPath: LEDGER_PATH,
      rawFindingsPath: RAW_FINDINGS_PATH,
    });
    const rawFinding = makeRawFinding('raw-current');
    const reconciled = reconcileFindingLedger({
      previousLedger: makeLedger(),
      rawFindings: [rawFinding],
      managerOutput: makeManagerOutput('raw-current'),
      provisionalFindings: [],
      rawFindingDispositions: [],
      rawProvenanceByRawFindingId: new Map([[
        rawFinding.rawFindingId,
        storedRawReconcileProvenance(
          rawFinding,
          computeReviewerStableKey({
            workflowName: WORKFLOW_NAME,
            callNamespace: '',
            parentStepName: 'reviewers',
            reviewerPersonaKey: rawFinding.reviewer,
          }),
          computeLineageKey({
            location: rawFinding.location,
            title: rawFinding.title,
            familyTag: rawFinding.familyTag,
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
      'previous-adjudication',
      'a-current-adjudication',
      'z-current-adjudication',
    ]);
    expect(reconciled.conflicts[0]?.adjudicationAttempts?.map((attempt) => attempt.evidenceHash)).toEqual([
      'previous-attempt',
      'a-current-attempt',
      'z-current-attempt',
    ]);

    await store.updateLedger(() => ({ ledger: reconciled, result: undefined }));
    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId,
      requestedOriginStep: undefined,
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2017-01-01T00:02:00.000Z',
      },
      cwd,
    });

    expect(reservation.result).toMatchObject({ started: true, originStep: 'final-gate' });
    expect(reservation.ledger.conflicts[0]?.adjudicationAttempts).toEqual([
      expect.objectContaining({ evidenceHash: 'previous-attempt', originStep: 'reviewers' }),
      expect.objectContaining({ evidenceHash: 'a-current-attempt', originStep: 'reviewers' }),
      expect.objectContaining({ evidenceHash: 'z-current-attempt', originStep: 'final-gate' }),
      expect.objectContaining({ originStep: 'final-gate' }),
    ]);
  });
});
