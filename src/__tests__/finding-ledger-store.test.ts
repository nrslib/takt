import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  authoritativeRoot: string;
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
  it('should persist the authoritative ledger under the engine-owned root, not projectCwd or the run report directory', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    store.saveLedger(makeLedger());

    const authoritativeLedgerPath = join(authoritativeRoot, '.takt/findings/peer-review.json');
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    const reportLedgerPath = join(reportDir, '.takt/findings/peer-review.json');
    expect(existsSync(authoritativeLedgerPath)).toBe(true);
    expect(existsSync(projectLedgerPath)).toBe(false);
    expect(existsSync(reportLedgerPath)).toBe(false);
    expect(JSON.parse(readFileSync(authoritativeLedgerPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
  });

  it('should protect authoritative ledger and raw findings with owner-only permissions', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });
    const rawFinding = {
      rawFindingId: 'raw-secret',
      stepName: 'security-review',
      reviewer: 'security-reviewer',
      severity: 'high' as const,
      title: 'Secret leak',
      description: 'The reviewer included a secret-shaped string in evidence.',
    };

    store.saveLedger(makeLedger());
    const rawFindingsPath = store.saveRawFindings('run-1', 'reviewers', [rawFinding]);

    expect(statSync(authoritativeRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(authoritativeRoot, '.takt/findings/peer-review.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(authoritativeRoot, '.takt/findings/raw')).mode & 0o777).toBe(0o700);
    expect(statSync(rawFindingsPath).mode & 0o777).toBe(0o600);
  });

  it('should create a run-local copy for agent input without moving the authoritative ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();

    expect(copyPath).toBe(join(reportDir, 'findings-ledger.json'));
    expect(JSON.parse(readFileSync(copyPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
    expect(existsSync(join(authoritativeRoot, '.takt/findings/peer-review.json'))).toBe(true);
    expect(existsSync(join(projectCwd, '.takt/findings/peer-review.json'))).toBe(false);
  });

  it('should create the run-local ledger copy as owner-only read-only', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();

    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should regenerate an existing read-only run-local ledger copy', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

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
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const authoritativeLedgerPath = join(authoritativeRoot, '.takt/findings/peer-review.json');
    mkdirSync(join(authoritativeRoot, '.takt/findings'), { recursive: true });
    writeFileSync(authoritativeLedgerPath, JSON.stringify({
      ...makeLedger(),
      workflowName: 'other-workflow',
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

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
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const authoritativeLedgerPath = join(authoritativeRoot, '.takt/findings/peer-review.json');
    mkdirSync(join(authoritativeRoot, '.takt/findings'), { recursive: true });
    writeFileSync(authoritativeLedgerPath, JSON.stringify({
      ...makeLedger(),
      nextId: 1,
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    expect(() => store.loadLedger()).toThrow(
      'Finding ledger nextId 1 must be greater than existing finding id F-0001',
    );
  });

  it('should preserve multiple raw finding generations for the same run and step', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });
    const rawFinding = {
      rawFindingId: 'raw-1',
      stepName: 'coding-review',
      reviewer: 'coding-reviewer',
      severity: 'high' as const,
      title: 'Open issue',
      description: 'The issue is still present.',
    };

    const firstPath = store.saveRawFindings('run-1', 'reviewers', [rawFinding]);
    const secondPath = store.saveRawFindings('run-1', 'reviewers', [
      { ...rawFinding, rawFindingId: 'raw-2' },
    ]);

    expect(firstPath).toBe(join(authoritativeRoot, '.takt/findings/raw/run-1.reviewers.json'));
    expect(secondPath).toBe(join(authoritativeRoot, '.takt/findings/raw/run-1.reviewers.2.json'));
    expect(JSON.parse(readFileSync(firstPath, 'utf-8'))).toEqual([rawFinding]);
    expect(JSON.parse(readFileSync(secondPath, 'utf-8'))).toEqual([{ ...rawFinding, rawFindingId: 'raw-2' }]);
  });

  it('should reject symlinked ledger files before writing outside the authoritative root', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    const outsideLedgerPath = join(outsideDir, 'peer-review.json');
    writeFileSync(outsideLedgerPath, 'outside-ledger', 'utf-8');
    mkdirSync(join(authoritativeRoot, '.takt', 'findings'), { recursive: true });
    symlinkSync(outsideLedgerPath, join(authoritativeRoot, '.takt', 'findings', 'peer-review.json'));
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    expect(() => store.saveLedger(makeLedger())).toThrow('must not be a symbolic link');
    expect(readFileSync(outsideLedgerPath, 'utf-8')).toBe('outside-ledger');
  });

  it('should reject symlinked raw findings directories before writing outside the authoritative root', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(authoritativeRoot, '.takt', 'findings'), { recursive: true });
    symlinkSync(outsideDir, join(authoritativeRoot, '.takt', 'findings', 'raw'), 'dir');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    expect(() => store.saveRawFindings('run-1', 'reviewers', [
      {
        rawFindingId: 'raw-1',
        stepName: 'security-review',
        reviewer: 'security-reviewer',
        severity: 'high',
        title: 'Unsafe write',
        description: 'Raw findings must stay inside the authoritative root.',
      },
    ])).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(outsideDir, 'run-1.reviewers.json'))).toBe(false);
  });

  it('should reject ledger reads through symlinked parent directories outside the authoritative root', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(outsideDir, 'findings'), { recursive: true });
    writeFileSync(join(outsideDir, 'findings', 'peer-review.json'), JSON.stringify(makeLedger()), 'utf-8');
    symlinkSync(outsideDir, join(authoritativeRoot, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    expect(() => store.loadLedger()).toThrow('Finding ledger path escapes base directory');
  });

  it('should reject run copy creation from ledgers under symlinked parent directories outside the authoritative root', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    mkdirSync(join(outsideDir, 'findings'), { recursive: true });
    writeFileSync(join(outsideDir, 'findings', 'peer-review.json'), JSON.stringify(makeLedger()), 'utf-8');
    symlinkSync(outsideDir, join(authoritativeRoot, '.takt'), 'dir');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    expect(() => store.createRunCopy()).toThrow('Finding ledger path escapes base directory');
    expect(existsSync(join(reportDir, 'findings-ledger.json'))).toBe(false);
  });

  it('should ignore projectCwd ledger tampering when loading the authoritative ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const authoritativeRoot = makeTempDir('takt-findings-authoritative-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'findings', 'peer-review.json'), JSON.stringify({
      ...makeLedger(),
      nextId: 1,
      findings: [],
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir, authoritativeRoot });

    store.saveLedger(makeLedger());

    expect(store.loadLedger()).toEqual(expect.objectContaining({
      nextId: 2,
      findings: [expect.objectContaining({ id: 'F-0001' })],
    }));
  });
});
