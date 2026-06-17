import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';

const cleanupDirs = new Set<string>();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function makeLedger(): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Open issue',
        reviewers: ['coding-reviewer'],
        rawFindingIds: ['raw-1'],
        firstSeen: { runId: 'run-1', stepName: 'peer-review', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'peer-review', timestamp: '2026-06-13T00:00:00.000Z' },
      },
    ],
  };
}

function createStore(options: {
  projectCwd: string;
  reportDir: string;
}) {
  return createFindingLedgerStore({
    ...options,
    workflowName: 'peer-review',
    ledgerPath: '.takt/findings/peer-review.json',
    rawFindingsPath: '.takt/findings/raw',
  });
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('FindingLedgerStore', () => {
  it('should persist the project ledger under projectCwd, not the run report directory', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());

    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    const reportLedgerPath = join(reportDir, '.takt/findings/peer-review.json');
    expect(existsSync(projectLedgerPath)).toBe(true);
    expect(existsSync(reportLedgerPath)).toBe(false);
    expect(JSON.parse(readFileSync(projectLedgerPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
  });

  it('should protect project ledger and raw findings with owner-only permissions', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const rawFinding = {
      rawFindingId: 'raw-secret',
      stepName: 'security-review',
      reviewer: 'security-reviewer',
      familyTag: 'prompt-injection',
      severity: 'high' as const,
      title: 'Secret leak',
      description: 'The reviewer included a secret-shaped string in evidence.',
    };

    store.saveLedger(makeLedger());
    const rawFindingsPath = store.saveRawFindings('run-1', 'reviewers', [rawFinding]);

    expect(statSync(join(projectCwd, '.takt/findings/peer-review.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectCwd, '.takt/findings/raw')).mode & 0o777).toBe(0o700);
    expect(statSync(rawFindingsPath).mode & 0o777).toBe(0o600);
  });

  it('should create a run-local copy for agent input without moving the project ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();

    expect(copyPath).toBe(join(reportDir, 'findings-ledger.json'));
    expect(JSON.parse(readFileSync(copyPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
    expect(existsSync(join(projectCwd, '.takt/findings/peer-review.json'))).toBe(true);
  });

  it('should create the run-local ledger copy as owner-only read-only', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();

    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should regenerate an existing read-only run-local ledger copy', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();
    store.saveLedger({ ...makeLedger(), nextId: 3 });
    const regeneratedPath = store.createRunCopy();

    expect(regeneratedPath).toBe(copyPath);
    expect(JSON.parse(readFileSync(copyPath, 'utf-8'))).toEqual(
      expect.objectContaining({ nextId: 3 }),
    );
    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should reject a ledger from a different workflow when loading or creating a run copy', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(join(projectCwd, '.takt/findings'), { recursive: true });
    writeFileSync(projectLedgerPath, JSON.stringify({
      ...makeLedger(),
      workflowName: 'other-workflow',
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow(
      'Finding ledger workflowName mismatch',
    );
    expect(() => store.createRunCopy()).toThrow(
      'Finding ledger workflowName mismatch',
    );
  });

  it('should reject ledgers whose nextId can reuse an existing finding id', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(join(projectCwd, '.takt/findings'), { recursive: true });
    writeFileSync(projectLedgerPath, JSON.stringify({
      ...makeLedger(),
      nextId: 1,
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow(
      'Finding ledger nextId 1 must be greater than existing finding id F-0001',
    );
  });

  it('should preserve multiple raw finding generations for the same run and step', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const rawFinding = {
      rawFindingId: 'raw-1',
      stepName: 'coding-review',
      reviewer: 'coding-reviewer',
      familyTag: 'bug',
      severity: 'high' as const,
      title: 'Open issue',
      description: 'The issue is still present.',
    };

    const firstPath = store.saveRawFindings('run-1', 'reviewers', [rawFinding]);
    const secondPath = store.saveRawFindings('run-1', 'reviewers', [
      { ...rawFinding, rawFindingId: 'raw-2' },
    ]);

    expect(firstPath).toBe(join(projectCwd, '.takt/findings/raw/run-1.reviewers.json'));
    expect(secondPath).toBe(join(projectCwd, '.takt/findings/raw/run-1.reviewers.2.json'));
    expect(JSON.parse(readFileSync(firstPath, 'utf-8'))).toEqual([rawFinding]);
    expect(JSON.parse(readFileSync(secondPath, 'utf-8'))).toEqual([{ ...rawFinding, rawFindingId: 'raw-2' }]);
  });

  it('should reject symlinked ledger files before writing outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    const outsideLedgerPath = join(outsideDir, 'peer-review.json');
    writeFileSync(outsideLedgerPath, 'outside-ledger', 'utf-8');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    symlinkSync(outsideLedgerPath, join(projectCwd, '.takt', 'findings', 'peer-review.json'));
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.saveLedger(makeLedger())).toThrow('must not be a symbolic link');
    expect(readFileSync(outsideLedgerPath, 'utf-8')).toBe('outside-ledger');
  });

  it('should reject symlinked raw findings directories before writing outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    symlinkSync(outsideDir, join(projectCwd, '.takt', 'findings', 'raw'), 'dir');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.saveRawFindings('run-1', 'reviewers', [
      {
        rawFindingId: 'raw-1',
        stepName: 'security-review',
        reviewer: 'security-reviewer',
        familyTag: 'path-escape',
        severity: 'high',
        title: 'Unsafe write',
        description: 'Raw findings must stay inside the projectCwd.',
      },
    ])).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(outsideDir, 'run-1.reviewers.json'))).toBe(false);
  });

  it('should reject ledger reads through symlinked parent directories outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(outsideDir, 'findings'), { recursive: true });
    writeFileSync(join(outsideDir, 'findings', 'peer-review.json'), JSON.stringify(makeLedger()), 'utf-8');
    symlinkSync(outsideDir, join(projectCwd, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow('Finding ledger path escapes base directory');
  });

  it('should reject run copy creation from ledgers under symlinked parent directories outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(outsideDir, 'findings'), { recursive: true });
    writeFileSync(join(outsideDir, 'findings', 'peer-review.json'), JSON.stringify(makeLedger()), 'utf-8');
    symlinkSync(outsideDir, join(projectCwd, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.createRunCopy()).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(reportDir, 'findings-ledger.json'))).toBe(false);
  });

  it('should reject empty ledger reads under symlinked parent directories outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    symlinkSync(outsideDir, join(projectCwd, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(outsideDir, 'findings', 'peer-review.json'))).toBe(false);
  });

  it('should reject run copy creation for missing ledgers under symlinked parent directories outside the projectCwd', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    symlinkSync(outsideDir, join(projectCwd, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.createRunCopy()).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(reportDir, 'findings-ledger.json'))).toBe(false);
    expect(existsSync(join(outsideDir, 'findings', 'peer-review.json'))).toBe(false);
  });

  it('should reject empty ledger reads from broken symlink ledger paths', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    symlinkSync(join(outsideDir, 'missing-peer-review.json'), join(projectCwd, '.takt', 'findings', 'peer-review.json'));
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow('Finding ledger path must not be a symbolic link');
  });

  it('should reject run copy creation from broken symlink ledger paths', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    symlinkSync(join(outsideDir, 'missing-peer-review.json'), join(projectCwd, '.takt', 'findings', 'peer-review.json'));
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.createRunCopy()).toThrow('Finding ledger path must not be a symbolic link');
    expect(existsSync(join(reportDir, 'findings-ledger.json'))).toBe(false);
  });

  it('should overwrite an existing project ledger when saving the project ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'findings', 'peer-review.json'), JSON.stringify({
      ...makeLedger(),
      nextId: 1,
      findings: [],
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());

    expect(store.loadLedger()).toEqual(expect.objectContaining({
      nextId: 2,
      findings: [expect.objectContaining({ id: 'F-0001' })],
    }));
  });

  it('should save manager validation reports under the run report directory', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    const reportPath = store.saveManagerValidationReport({
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 1,
      ledgerUpdated: false,
      finalErrors: ['Raw finding id "raw-1" appears in multiple manager decisions'],
      attempts: [
        {
          attempt: 1,
          managerOutput: {
            matches: [],
            newFindings: [{ rawFindingIds: ['raw-1'], title: 'Issue', severity: 'high' }],
            resolvedFindings: [],
            reopenedFindings: [],
            conflicts: [{ findingIds: [], rawFindingIds: ['raw-1'], description: 'Duplicate.' }],
            resolvedConflicts: [],
          },
          validationErrors: ['Raw finding id "raw-1" appears in multiple manager decisions'],
        },
      ],
    });

    expect(reportPath).toBe(join(reportDir, 'findings-manager-validation.reviewers.json'));
    expect(existsSync(join(projectCwd, 'findings-manager-validation.reviewers.json'))).toBe(false);
    expect(JSON.parse(readFileSync(reportPath, 'utf-8'))).toEqual({
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 1,
      ledgerUpdated: false,
      finalErrors: ['Raw finding id "raw-1" appears in multiple manager decisions'],
      attempts: [
        {
          attempt: 1,
          managerOutput: {
            matches: [],
            newFindings: [{ rawFindingIds: ['raw-1'], title: 'Issue', severity: 'high' }],
            resolvedFindings: [],
            reopenedFindings: [],
            conflicts: [{ findingIds: [], rawFindingIds: ['raw-1'], description: 'Duplicate.' }],
            resolvedConflicts: [],
          },
          validationErrors: ['Raw finding id "raw-1" appears in multiple manager decisions'],
        },
      ],
    });
  });

  it('should version existing manager validation reports before writing the latest report', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveManagerValidationReport({
      version: 1,
      runId: 'run-1',
      stepName: 'reviewers',
      retryCount: 1,
      ledgerUpdated: false,
      finalErrors: ['first failure'],
      attempts: [],
    });
    store.saveManagerValidationReport({
      version: 1,
      runId: 'run-2',
      stepName: 'reviewers',
      retryCount: 1,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });

    const latestPath = join(reportDir, 'findings-manager-validation.reviewers.json');
    const historyFiles = readdirSync(reportDir).filter((name) =>
      /^findings-manager-validation\.reviewers\.json\.\d{8}T\d{6}Z(?:\.\d+)?$/.test(name),
    );
    expect(JSON.parse(readFileSync(latestPath, 'utf-8'))).toEqual(expect.objectContaining({
      runId: 'run-2',
      ledgerUpdated: true,
    }));
    expect(historyFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(reportDir, historyFiles[0]!), 'utf-8'))).toEqual(expect.objectContaining({
      runId: 'run-1',
      ledgerUpdated: false,
    }));
  });
});
