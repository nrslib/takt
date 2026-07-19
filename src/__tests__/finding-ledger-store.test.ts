import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsFailure = vi.hoisted(() => ({
  failWriteOnce: undefined as ((path: string) => boolean) | undefined,
  descriptorPaths: new Map<number, string>(),
  beforeOpen: undefined as ((path: string) => void) | undefined,
  beforePublication: undefined as ((targetPath: string) => void) | undefined,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const path = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    spawnSync(...args: Parameters<typeof actual.spawnSync>) {
      const commandArguments = args[1];
      const rawRequest = Array.isArray(commandArguments) ? commandArguments[2] : undefined;
      if (typeof rawRequest === 'string' && rawRequest.includes('"operation":"publish"')) {
        const request = JSON.parse(rawRequest) as { targetName: string };
        const options = args[2];
        if (typeof options === 'object' && options !== null && typeof options.cwd === 'string') {
          const beforePublication = fsFailure.beforePublication;
          fsFailure.beforePublication = undefined;
          beforePublication?.(path.join(options.cwd, request.targetName));
        }
      }
      return actual.spawnSync(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const actualWriteFileSync = actual.writeFileSync as unknown as (...args: unknown[]) => unknown;
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
      fsFailure.beforeOpen?.(String(path));
      const descriptor = Reflect.apply(actual.openSync, actual, [path, ...args]) as number;
      fsFailure.descriptorPaths.set(descriptor, String(path));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      fsFailure.descriptorPaths.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    writeFileSync: ((
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      const resolvedPath = typeof path === 'number'
        ? fsFailure.descriptorPaths.get(path) ?? String(path)
        : String(path);
      if (fsFailure.failWriteOnce?.(resolvedPath)) {
        fsFailure.failWriteOnce = undefined;
        const partialData = typeof data === 'string'
          ? data.slice(0, Math.max(1, Math.floor(data.length / 2)))
          : data;
        Reflect.apply(actualWriteFileSync, actual, [path, partialData, options]);
        throw Object.assign(new Error(`injected write failure: ${resolvedPath}`), { code: 'EFBIG' });
      }
      Reflect.apply(actualWriteFileSync, actual, [path, data, options]);
    }) as typeof actual.writeFileSync,
  };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

beforeEach(() => {
  fsFailure.failWriteOnce = undefined;
  fsFailure.descriptorPaths.clear();
  fsFailure.beforeOpen = undefined;
  fsFailure.beforePublication = undefined;
});

afterEach(() => {
  fsFailure.failWriteOnce = undefined;
  fsFailure.descriptorPaths.clear();
  fsFailure.beforeOpen = undefined;
  fsFailure.beforePublication = undefined;
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

  it('should migrate legacy version 1 adjudication attempts to stable reservation tokens', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(dirname(projectLedgerPath), { recursive: true });
    writeFileSync(projectLedgerPath, JSON.stringify({
      ...makeLedger(),
      conflicts: [{
        id: 'C-0001',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'legacy conflict',
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        adjudicationAttempts: [{
          evidenceHash: 'legacy-evidence-hash',
          startedAt: {
            runId: 'run-1',
            stepName: 'finding-conflict-adjudication',
            timestamp: '2026-06-13T01:00:00.000Z',
          },
        }],
      }],
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    const firstLoad = store.loadLedger();
    const secondLoad = store.loadLedger();

    expect(firstLoad.conflicts[0]?.adjudicationAttempts?.[0]?.reservationToken)
      .toBe('legacy-v1:0:0:C-0001');
    expect(secondLoad.conflicts[0]?.adjudicationAttempts?.[0]?.reservationToken)
      .toBe('legacy-v1:0:0:C-0001');
  });

  it('should create the run-local ledger copy as owner-only read-only', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();

    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should accept an equivalent run copy published by a concurrent writer', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    store.saveLedger(makeLedger());
    const ledger = store.loadLedger();
    const concurrentContent = JSON.stringify({
      ...ledger,
      updatedAt: '2026-06-13T00:00:01.000Z',
    }, null, 2);
    fsFailure.beforePublication = (targetPath) => {
      writeFileSync(targetPath, concurrentContent, { mode: 0o400 });
    };

    const copyPath = store.createRunCopy();

    expect(readFileSync(copyPath, 'utf-8')).toBe(concurrentContent);
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

  it('should preserve a read-only run copy when it is replaced before publication', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    store.saveLedger(makeLedger());
    const copyPath = store.createRunCopy();
    const originalCopyPath = join(reportDir, 'original-findings-ledger.json');
    fsFailure.beforeOpen = (path) => {
      if (
        dirname(path) !== dirname(copyPath)
        || !basename(path).startsWith('.findings-ledger.json.')
        || !path.endsWith('.tmp')
      ) {
        return;
      }
      fsFailure.beforeOpen = undefined;
      renameSync(copyPath, originalCopyPath);
      writeFileSync(copyPath, 'substituted', { mode: 0o600 });
    };

    expect(() => store.createRunCopy()).toThrow(/identity changed/);

    expect(JSON.parse(readFileSync(originalCopyPath, 'utf-8'))).toMatchObject({ nextId: 2 });
    expect(statSync(originalCopyPath).mode & 0o777).toBe(0o400);
    expect(readFileSync(copyPath, 'utf-8')).toBe('substituted');
    expect(statSync(copyPath).mode & 0o777).toBe(0o600);
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
    // parseRawFindings derives relation from kind for backward-compatible input (item 3).
    const expectedRawFinding = { ...rawFinding, relation: 'new' };
    expect(JSON.parse(readFileSync(firstPath, 'utf-8'))).toEqual([expectedRawFinding]);
    expect(JSON.parse(readFileSync(secondPath, 'utf-8'))).toEqual([{ ...expectedRawFinding, rawFindingId: 'raw-2' }]);
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

  it('should reject a ledger parent swap after inspection without reading the substituted ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const findingsDir = join(projectCwd, '.takt', 'findings');
    const originalFindingsDir = join(projectCwd, 'original-findings');
    const outsideDir = makeTempDir('takt-findings-outside-');
    const ledgerPath = join(findingsDir, 'peer-review.json');
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(makeLedger()));
    writeFileSync(join(outsideDir, 'peer-review.json'), JSON.stringify({
      ...makeLedger(),
      nextId: 99,
    }));
    const store = createStore({ projectCwd, reportDir });
    fsFailure.beforeOpen = (path) => {
      if (path !== ledgerPath) {
        return;
      }
      fsFailure.beforeOpen = undefined;
      renameSync(findingsDir, originalFindingsDir);
      symlinkSync(outsideDir, findingsDir, 'dir');
    };

    expect(() => store.loadLedger()).toThrow(/identity changed/);

    expect(JSON.parse(readFileSync(join(outsideDir, 'peer-review.json'), 'utf-8'))).toMatchObject({ nextId: 99 });
  });

  it('should reject a ledger parent swap before publishing without changing either ledger', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const initialLedger = makeLedger();
    store.saveLedger(initialLedger);
    const findingsDir = join(projectCwd, '.takt', 'findings');
    const originalFindingsDir = join(projectCwd, 'original-findings');
    const outsideDir = makeTempDir('takt-findings-outside-');
    const outsideLedger = join(outsideDir, 'peer-review.json');
    writeFileSync(outsideLedger, 'outside unchanged');
    fsFailure.beforeOpen = (path) => {
      if (!basename(path).startsWith('.peer-review.json.') || !path.endsWith('.tmp')) {
        return;
      }
      fsFailure.beforeOpen = undefined;
      renameSync(findingsDir, originalFindingsDir);
      symlinkSync(outsideDir, findingsDir, 'dir');
    };

    expect(() => store.saveLedger({ ...initialLedger, nextId: 3 })).toThrow(/identity changed/);

    expect(JSON.parse(readFileSync(join(originalFindingsDir, 'peer-review.json'), 'utf-8'))).toEqual(initialLedger);
    expect(readFileSync(outsideLedger, 'utf-8')).toBe('outside unchanged');
    expect(readdirSync(outsideDir)).toEqual(['peer-review.json']);
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

  it('should apply updateLedger against the ledger already on disk, not a stale in-memory copy', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    store.saveLedger(makeLedger());

    // ディスク上の台帳を直接書き換える（別の呼び出し元による更新を模す）。
    // updateLedger の mutator が受け取るのは「呼び出し時点で再読込した」台帳
    // でなければならない。
    const externallyUpdatedLedger = { ...makeLedger(), nextId: 5 };
    writeFileSync(
      join(projectCwd, '.takt/findings/peer-review.json'),
      JSON.stringify(externallyUpdatedLedger),
      'utf-8',
    );

    const result = await store.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 1 },
      result: current.nextId + 1,
    }));

    expect(result.result).toBe(6);
    expect(result.ledger.nextId).toBe(6);
    expect(store.loadLedger().nextId).toBe(6);
  });

  it('should propagate a mutator failure without changing the ledger or blocking the next update', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const initialLedger = makeLedger();
    const mutatorError = new Error('mutator failed');
    store.saveLedger(initialLedger);

    const failedUpdate = store.updateLedger(() => {
      throw mutatorError;
    });

    await expect(failedUpdate).rejects.toBe(mutatorError);
    expect(store.loadLedger()).toEqual(initialLedger);

    const recovered = await store.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 1 },
      result: 'recovered',
    }));

    expect(recovered.ledger.nextId).toBe(3);
    expect(recovered.result).toBe('recovered');
    expect(store.loadLedger()).toEqual({ ...initialLedger, nextId: 3 });
  });

  it('should propagate a save failure without partially writing or blocking the next update', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const initialLedger = makeLedger();
    store.saveLedger(initialLedger);
    const ledgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    const initialContent = readFileSync(ledgerPath, 'utf-8');
    fsFailure.failWriteOnce = (path) => (
      dirname(path) === dirname(ledgerPath)
      && basename(path).startsWith('.peer-review.json.')
      && path.endsWith('.tmp')
    );

    const failedUpdate = store.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 10 },
      result: undefined,
    }));

    await expect(failedUpdate).rejects.toMatchObject({ code: 'EFBIG' });
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(initialContent);
    expect(store.loadLedger()).toEqual(initialLedger);
    expect(readdirSync(dirname(ledgerPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const recovered = await store.updateLedger((current) => ({
      ledger: { ...current, nextId: current.nextId + 1 },
      result: 'recovered',
    }));

    expect(recovered.ledger.nextId).toBe(3);
    expect(recovered.result).toBe('recovered');
    expect(store.loadLedger()).toEqual({ ...initialLedger, nextId: 3 });
  });

  it('should serialize concurrent callers so neither increment is lost (no lost update)', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createFindingLedgerStore({
      projectCwd,
      reportDir,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    store.saveLedger(makeLedger());

    // workflow_call の並列子エンジンを模す: 各呼び出し元は「非同期処理
    // （LLM 呼び出し等）を終えたあとに updateLedger を呼ぶ」。旧実装
    // （呼び出し元が非同期処理の前に読んでおいた台帳をそのまま使って保存する
    // 方式）だと、片方の保存がもう片方の保存を上書きして加算が1回分消える。
    const callerA = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return store.updateLedger((current) => ({
        ledger: { ...current, nextId: current.nextId + 1 },
        result: current.nextId + 1,
      }));
    })();
    const callerB = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return store.updateLedger((current) => ({
        ledger: { ...current, nextId: current.nextId + 1 },
        result: current.nextId + 1,
      }));
    })();

    const [resultA, resultB] = await Promise.all([callerA, callerB]);

    expect(store.loadLedger().nextId).toBe(4);
    expect([resultA.result, resultB.result].sort()).toEqual([3, 4]);
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
