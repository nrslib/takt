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
  const olderObservation = {
    runId: 'run-0',
    stepName: 'reviewers',
    timestamp: '2017-01-01T00:59:60.500+01:00',
  };
  const newerObservation = {
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
    updatedAt: newerObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Conflicting review conclusion',
      location: 'src/example.ts:1',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-legacy'],
      firstSeen: olderObservation,
      lastSeen: newerObservation,
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
        firstSeen: newerObservation,
        lastSeen: newerObservation,
        adjudicationAttempts: [{
          evidenceHash: 'generated-pending-evidence',
          reservationToken: 'generated-reservation',
          startedAt: newerObservation,
          originStep: 'final-gate',
        }],
      },
      {
        id: LEGACY_CONFLICT_ID,
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-legacy'],
        description: 'Legacy conflict.',
        firstSeen: olderObservation,
        lastSeen: olderObservation,
        adjudicationAttempts: [{
          evidenceHash: 'legacy-pending-evidence',
          reservationToken: 'legacy-reservation',
          startedAt: olderObservation,
          originStep: 'reviewers',
        }],
      },
    ],
  };
}

describe('reconciled conflict history reservation', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-conflict-history-'));
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

  it('should use the newest pending origin across equivalent RFC 3339 offset representations', async () => {
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
        timestamp: '2026-06-14T00:00:00.000Z',
      },
    });
    expect(reconciled.conflicts[0]?.adjudicationAttempts?.map((attempt) => attempt.evidenceHash)).toEqual([
      'legacy-pending-evidence',
      'generated-pending-evidence',
    ]);
    store.saveLedger(reconciled);
    expect(store.loadLedger().conflicts[0]?.adjudicationAttempts?.map((attempt) => attempt.startedAt.timestamp)).toEqual([
      '2016-12-31T23:59:60.500Z',
      '2017-01-01T00:00:00.000Z',
    ]);

    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: LEGACY_CONFLICT_ID,
      requestedOriginStep: undefined,
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });

    expect(reservation.result).toMatchObject({
      started: true,
      originStep: 'final-gate',
    });
    expect(reservation.ledger.conflicts).toHaveLength(1);
    expect(reservation.ledger.conflicts[0]?.adjudicationAttempts).toEqual([
      expect.objectContaining({ originStep: 'reviewers' }),
      expect.objectContaining({ originStep: 'final-gate' }),
      expect.objectContaining({ originStep: 'final-gate' }),
    ]);
  });

  it('should preserve the reconciled reservation origin when rejecting submillisecond history timestamps', async () => {
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
        timestamp: '2026-06-14T00:00:00.000Z',
      },
    });
    store.saveLedger(reconciled);
    const ledger = structuredClone(reconciled);
    ledger.conflicts[0]!.adjudicationAttempts![0]!.startedAt.timestamp = '2026-06-12T22:15:00.0001Z';

    expect(() => store.saveLedger(ledger)).toThrow('Expected an RFC 3339 timestamp');

    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore: store,
      conflictId: LEGACY_CONFLICT_ID,
      requestedOriginStep: undefined,
      runId: 'run-2',
      observation: {
        runId: 'run-2',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-14T00:01:00.000Z',
      },
      cwd,
    });

    expect(reservation.result).toMatchObject({ started: true, originStep: 'final-gate' });
  });
});
