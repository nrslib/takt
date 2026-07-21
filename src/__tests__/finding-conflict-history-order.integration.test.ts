import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import { formatConflictId } from '../core/workflow/findings/conflict-identity.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger, FindingManagerOutput, RawFinding } from '../core/workflow/findings/types.js';

const WORKFLOW_NAME = 'peer-review';
const LEDGER_PATH = '.takt/findings/peer-review.json';
const RAW_FINDINGS_PATH = '.takt/findings/raw';
const LEGACY_CONFLICT_ID = 'C-1CA24A220BC7';

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
    version: 1,
    workflowName: WORKFLOW_NAME,
    nextId: 2,
    updatedAt: nextMinuteObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Conflicting review conclusion',
      location: 'src/example.ts:1',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-legacy'],
      firstSeen: leapSecondObservation,
      lastSeen: nextMinuteObservation,
    }],
    rawFindings: [
      makeRawFinding('raw-legacy'),
      makeRawFinding('raw-generated'),
    ],
    conflicts: [
      {
        id: generatedConflictId,
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-generated'],
        description: 'Generated conflict.',
        firstSeen: nextMinuteObservation,
        lastSeen: nextMinuteObservation,
        adjudications: [{
          evidenceHash: 'z-generated-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Generated conflicting evidence.'],
          actionableFix: '',
          decidedAt: nextMinuteObservation,
        }],
        adjudicationAttempts: [{
          evidenceHash: 'z-generated-attempt',
          reservationToken: 'generated-reservation',
          startedAt: nextMinuteObservation,
          originStep: 'final-gate',
        }],
      },
      {
        id: LEGACY_CONFLICT_ID,
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-legacy'],
        description: 'Legacy conflict.',
        firstSeen: leapSecondObservation,
        lastSeen: leapSecondObservation,
        adjudications: [{
          evidenceHash: 'legacy-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Legacy conflicting evidence.'],
          actionableFix: '',
          decidedAt: leapSecondObservation,
        }, {
          evidenceHash: 'a-legacy-adjudication',
          outcome: 'undetermined',
          findingTransition: 'keep_open',
          evidence: ['Same-timestamp conflicting evidence.'],
          actionableFix: '',
          decidedAt: nextMinuteObservation,
        }],
        adjudicationAttempts: [{
          evidenceHash: 'legacy-attempt',
          reservationToken: 'legacy-reservation',
          startedAt: leapSecondObservation,
          originStep: 'reviewers',
        }, {
          evidenceHash: 'a-legacy-attempt',
          reservationToken: 'legacy-tie-reservation',
          startedAt: nextMinuteObservation,
          originStep: 'reviewers',
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
    const store = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir: join(cwd, '.takt', 'runs', 'run-2', 'reports'),
      workflowName: WORKFLOW_NAME,
      ledgerPath: LEDGER_PATH,
      rawFindingsPath: RAW_FINDINGS_PATH,
    });
    const reconciled = reconcileFindingLedger({
      previousLedger: makeLedger(),
      rawFindings: [makeRawFinding('raw-current')],
      managerOutput: makeManagerOutput('raw-current'),
      context: {
        workflowName: WORKFLOW_NAME,
        stepName: 'reviewers',
        runId: 'run-2',
        timestamp: '2017-01-01T00:01:00.000Z',
      },
    });

    expect(reconciled.conflicts).toHaveLength(1);
    expect(reconciled.conflicts[0]).toMatchObject({
      id: LEGACY_CONFLICT_ID,
      firstSeen: {
        runId: 'run-0',
        stepName: 'reviewers',
        timestamp: '2016-12-31T23:59:60.500Z',
      },
      rawFindingIds: ['raw-legacy', 'raw-generated', 'raw-current'],
    });
    expect(reconciled.conflicts[0]?.adjudications?.map((record) => record.evidenceHash)).toEqual([
      'legacy-adjudication',
      'a-legacy-adjudication',
      'z-generated-adjudication',
    ]);
    expect(reconciled.conflicts[0]?.adjudicationAttempts?.map((attempt) => attempt.evidenceHash)).toEqual([
      'legacy-attempt',
      'a-legacy-attempt',
      'z-generated-attempt',
    ]);

    store.saveLedger(reconciled);
    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: LEGACY_CONFLICT_ID,
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
      expect.objectContaining({ evidenceHash: 'legacy-attempt', originStep: 'reviewers' }),
      expect.objectContaining({ evidenceHash: 'a-legacy-attempt', originStep: 'reviewers' }),
      expect.objectContaining({ evidenceHash: 'z-generated-attempt', originStep: 'final-gate' }),
      expect.objectContaining({ originStep: 'final-gate' }),
    ]);
  });
});
