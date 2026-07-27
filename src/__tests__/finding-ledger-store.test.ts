import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createFindingLedgerStore } from '../core/workflow/findings/store.js';
import type {
  FindingLedger,
  FindingManagerReportPublication,
  FindingManagerValidationReport,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { runManagerRoundExclusive } from '../core/workflow/findings/manager-round-lock.js';
import { runLedgerUpdateExclusive } from '../core/workflow/findings/ledger-identity-queue.js';
import {
  finalizePendingManagerCommit,
  stagePendingManagerCommit,
} from '../core/workflow/findings/manager-pending-commit.js';
import { resumePendingManagerCommit } from '../core/workflow/findings/manager-commit.js';
import {
  publishReportFile,
  writeReportFile,
} from '../core/workflow/report-writer.js';
import * as privateFile from '../shared/utils/private-file.js';

const TEST_INTEGRITY_DIGEST = 'a'.repeat(64);
const cleanupDirs = new Set<string>();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function makeLedger(): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
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
  trustedResumeSourceRunId?: string;
}) {
  return createFindingLedgerStore({
    ...options,
    workflowName: 'peer-review',
    ledgerPath: '.takt/findings/peer-review.json',
    rawFindingsPath: '.takt/findings/raw',
  } as never);
}

function makePendingPublication(
  report: FindingManagerValidationReport,
): FindingManagerReportPublication {
  return {
    publicationId: 'a'.repeat(64),
    domainId: 'b'.repeat(64),
    originRunId: report.runId,
    destinationRunId: report.runId,
    fileName: `findings-manager-validation.${report.stepName}.json`,
    contentSha256: 'c'.repeat(64),
    report,
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function publicationHistoryPaths(reportDir: string, targetPath: string): string[] {
  const historyDir = join(
    reportDir,
    '.takt-report-internal',
    'history',
    sha256(['filesystem-report', resolve(targetPath)].join('\0')),
    'publication',
  );
  if (!existsSync(historyDir)) {
    return [];
  }
  return readdirSync(historyDir).map((name) => join(historyDir, name));
}

function runChildFileMutation(script: string, args: readonly string[]): void {
  const result = spawnSync(process.execPath, ['-e', script, ...args], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`Child file mutation failed: ${result.stderr}`);
  }
}

function writeForgedResumeManifest(
  projectCwd: string,
  sourceRunSlug: string,
  targetRunSlug: string,
): void {
  writeFileSync(
    join(projectCwd, '.takt', 'runs', targetRunSlug, 'reports', 'resume-artifacts.json'),
    JSON.stringify({
      version: 1,
      sourceRunSlug,
      targetRunSlug,
      createdAt: '2026-07-25T00:00:00.000Z',
      files: [],
    }),
    'utf-8',
  );
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
  it.each([
    ['stopBudget', ['round-a', 'round-a']],
    ['reviewIntegrity', ['round-b', 'round-a']],
  ] as const)('rejects noncanonical %s.roundMarkers at the filesystem load boundary', (
    field,
    roundMarkers,
  ) => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const ledgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({
      ...makeLedger(),
      [field]: {
        roundMarkers,
        firstRoundAt: '2026-06-13T00:00:00.000Z',
        exhausted: false,
      },
    }));

    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow(/binary-sorted unique set/);
  });

  it('should persist the project ledger under projectCwd, not the run report directory', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));

    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    const reportLedgerPath = join(reportDir, '.takt/findings/peer-review.json');
    expect(existsSync(projectLedgerPath)).toBe(true);
    expect(existsSync(reportLedgerPath)).toBe(false);
    expect(JSON.parse(readFileSync(projectLedgerPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
  });

  it('should reject invalid semantic timestamps without overwriting the persisted ledger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const ledgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const persistedContent = readFileSync(ledgerPath, 'utf-8');
    const timestamp = 'not-a-timestamp';
    const invalidLedgers: FindingLedger[] = [
      { ...makeLedger(), updatedAt: timestamp },
      {
        ...makeLedger(),
        findings: makeLedger().findings.map((finding) => ({
          ...finding,
          firstSeen: { ...finding.firstSeen, timestamp },
          lastSeen: { ...finding.lastSeen, timestamp },
          resolvedAt: timestamp,
          invalidatedAt: timestamp,
        })),
      },
      {
        ...makeLedger(),
        conflicts: [{
          id: formatConflictId({ findingIds: ['F-0001'], rawFindingIds: ['raw-1'] }),
          status: 'resolved',
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-1'],
          description: 'Resolved conflict.',
          firstSeen: makeLedger().findings[0]!.firstSeen,
          lastSeen: makeLedger().findings[0]!.lastSeen,
          resolvedAt: timestamp,
          resolvedEvidence: 'evidence',
        }],
      },
      { ...makeLedger(), stopBudget: { roundMarkers: ['round-1'], firstRoundAt: timestamp, exhausted: false } },
      { ...makeLedger(), reviewIntegrity: { roundMarkers: ['round-1'], firstRoundAt: timestamp, exhausted: false } },
    ];

    for (const invalidLedger of invalidLedgers) {
      await expect(store.updateLedger(() => ({
        ledger: invalidLedger,
        result: undefined,
      }))).rejects.toThrow('Expected an RFC 3339 timestamp');
      expect(readFileSync(ledgerPath, 'utf-8')).toBe(persistedContent);
    }
  });

  it('should normalize every semantic timestamp before saving the ledger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const ledger = {
      ...makeLedger(),
      updatedAt: '2026-06-13T00:15:00+02:00',
      findings: makeLedger().findings.map((finding) => ({
        ...finding,
        firstSeen: { ...finding.firstSeen, timestamp: '2026-06-13T00:15:00+02:00' },
        lastSeen: { ...finding.lastSeen, timestamp: '2026-06-13T00:15:00+02:00' },
        resolvedAt: '2026-06-13T00:15:00+02:00',
        invalidatedAt: '2026-06-13T00:15:00+02:00',
      })),
      conflicts: [{
        id: formatConflictId({ findingIds: ['F-0001'], rawFindingIds: ['raw-1'] }),
        status: 'resolved',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-1'],
        description: 'Resolved conflict.',
        firstSeen: makeLedger().findings[0]!.firstSeen,
        lastSeen: makeLedger().findings[0]!.lastSeen,
        resolvedAt: '2026-06-13T00:15:00+02:00',
        resolvedEvidence: 'evidence',
      }],
      stopBudget: { roundMarkers: ['round-1'], firstRoundAt: '2026-06-13T00:15:00+02:00', exhausted: false },
      reviewIntegrity: { roundMarkers: ['round-1'], firstRoundAt: '2026-06-13T00:15:00+02:00', exhausted: false },
    };

    await store.updateLedger(() => ({ ledger, result: undefined }));

    const saved = parseFindingLedger(JSON.parse(
      readFileSync(join(projectCwd, '.takt/findings/peer-review.json'), 'utf-8'),
    ));
    expect(saved.findings[0]?.firstSeen.timestamp).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.findings[0]?.lastSeen.timestamp).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.updatedAt).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.findings[0]?.resolvedAt).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.findings[0]?.invalidatedAt).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.conflicts[0]?.resolvedAt).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.stopBudget?.firstRoundAt).toBe('2026-06-12T22:15:00.000Z');
    expect(saved.reviewIntegrity?.firstRoundAt).toBe('2026-06-12T22:15:00.000Z');
  });

  it('should return the normalized ledger that it persisted from every update path', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const offsetTimestamp = '2026-06-13T00:15:00+02:00';
    const revalidators = [
      undefined,
      (_current: FindingLedger, mutation: { ledger: FindingLedger; result: string }) => ({ mutation, publish: false }),
      (_current: FindingLedger, mutation: { ledger: FindingLedger; result: string }) => ({ mutation, publish: true }),
    ];

    for (const revalidateBeforeSave of revalidators) {
      await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
      const result = await store.updateLedger(
        (current) => ({ ledger: { ...current, updatedAt: offsetTimestamp }, result: 'saved' }),
        revalidateBeforeSave,
      );
      expect(result.ledger).toEqual(store.loadLedger());
      expect(result.ledger.updatedAt).toBe('2026-06-12T22:15:00.000Z');
    }
  });

  it('should persist a canonical UTC leap second and return that same ledger from updateLedger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));

    const result = await store.updateLedger((current) => ({
      ledger: { ...current, updatedAt: '2017-01-01T00:59:60.500+01:00' },
      result: undefined,
    }));

    expect(result.ledger.updatedAt).toBe('2016-12-31T23:59:60.500Z');
    expect(store.loadLedger()).toEqual(result.ledger);
  });

  it('should not consume a provisional interpretation epoch before the WAL is applied', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const ledger = makeLedger();
    const lineageKey = 'lineage-interrupted';
    ledger.findings[0] = {
      ...ledger.findings[0]!,
      provisional: {
        kind: 'interpretation-interrupted',
        stableKey: 'provisional-interrupted',
        lineageKey,
        sourceRawFindingIds: ['raw-1'],
        reason: 'interrupted',
        firstObservedAt: ledger.findings[0]!.firstSeen,
        lastObservedAt: ledger.findings[0]!.lastSeen,
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    };
    ledger.interpretations = [{
      interpretationKey: 'interpretation-1',
      baseInterpretationKey: 'interpretation-base-1',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer-1',
      lineageKey,
      candidateEvidenceHash: 'evidence-1',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      stage: 'interpretation_started',
      startedAt: ledger.findings[0]!.firstSeen,
      reservationToken: 'reservation-interrupted',
      promptPreconditions: [],
    }];

    await store.updateLedger(() => ({ ledger, result: undefined }));

    const saved = store.loadLedger();
    expect(saved.findings[0]?.provisional?.interpretationEpochs).toBe(0);
  });

  it('should not consume a pending interpretation epoch in a run-local copy', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const ledger = makeLedger();
    const lineageKey = 'lineage-run-copy';
    ledger.findings[0] = {
      ...ledger.findings[0]!,
      provisional: {
        kind: 'interpretation-interrupted',
        stableKey: 'provisional-run-copy',
        lineageKey,
        sourceRawFindingIds: ['raw-1'],
        reason: 'interrupted',
        firstObservedAt: ledger.findings[0]!.firstSeen,
        lastObservedAt: ledger.findings[0]!.lastSeen,
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    };
    ledger.interpretations = [{
      interpretationKey: 'interpretation-run-copy',
      baseInterpretationKey: 'interpretation-base-run-copy',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer-run-copy',
      lineageKey,
      candidateEvidenceHash: 'evidence-run-copy',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      stage: 'interpretation_started',
      startedAt: ledger.findings[0]!.firstSeen,
      reservationToken: 'reservation-run-copy',
      promptPreconditions: [],
    }];
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(dirname(projectLedgerPath), { recursive: true });
    writeFileSync(projectLedgerPath, JSON.stringify(ledger), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();

    const copy = parseFindingLedger(JSON.parse(readFileSync(copyPath, 'utf-8')));
    expect(copy.findings[0]?.provisional?.interpretationEpochs).toBe(0);
  });

  it.each([true, false])('should preserve pending WAL epochs in a revalidated mutation when publish is %s', async (publish) => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const ledger = makeLedger();
    const lineageKey = 'lineage-revalidated';
    ledger.findings[0] = {
      ...ledger.findings[0]!,
      provisional: {
        kind: 'interpretation-interrupted',
        stableKey: 'provisional-revalidated',
        lineageKey,
        sourceRawFindingIds: ['raw-1'],
        reason: 'interrupted',
        firstObservedAt: ledger.findings[0]!.firstSeen,
        lastObservedAt: ledger.findings[0]!.lastSeen,
        interpretationEpochs: 0,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    };
    ledger.interpretations = [{
      interpretationKey: 'interpretation-revalidated',
      baseInterpretationKey: 'interpretation-base-revalidated',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer-revalidated',
      lineageKey,
      candidateEvidenceHash: 'evidence-revalidated',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      stage: 'interpretation_started',
      startedAt: ledger.findings[0]!.firstSeen,
      reservationToken: 'reservation-revalidated',
      promptPreconditions: [],
    }];
    await store.updateLedger(() => ({ ledger, result: undefined }));

    const result = await store.updateLedger(
      (current) => ({ ledger: current, result: undefined }),
      (_current, mutation) => ({
        publish,
        mutation: {
          ...mutation,
          ledger: {
            ...mutation.ledger,
            findings: mutation.ledger.findings.map((finding) => (
              finding.id === 'F-0001'
                ? {
                  ...finding,
                  firstSeen: { ...finding.firstSeen, timestamp: '2026-06-13T00:15:00+02:00' },
                  lastSeen: { ...finding.lastSeen, timestamp: '2026-06-13T00:15:00+02:00' },
                  provisional: {
                    ...finding.provisional!,
                    interpretationEpochs: 0,
                  },
                }
                : finding
            )),
          },
        },
      }),
    );

    expect(result.ledger.findings[0]?.provisional?.interpretationEpochs).toBe(0);
    const persisted = parseFindingLedger(JSON.parse(
      readFileSync(join(projectCwd, '.takt/findings/peer-review.json'), 'utf-8'),
    ));
    expect(persisted.findings[0]?.provisional?.interpretationEpochs).toBe(0);
    expect(persisted.findings[0]?.firstSeen.timestamp).toBe('2026-06-12T22:15:00.000Z');
    expect(persisted.findings[0]?.lastSeen.timestamp).toBe('2026-06-12T22:15:00.000Z');
    expect(store.loadLedger().findings[0]?.provisional?.interpretationEpochs).toBe(0);
  });

  it('should atomically persist the mutation from the publication-time revalidation', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    let revalidationCount = 0;

    const result = await store.updateLedger(
      (current) => ({ ledger: current, result: 'initial' }),
      (_current, mutation) => {
        revalidationCount += 1;
        const updatedAt = revalidationCount === 1
          ? '2026-06-13T22:15:00.000Z'
          : '2026-06-13T23:15:00.000Z';
        return {
          publish: true,
          mutation: {
            ledger: { ...mutation.ledger, updatedAt },
            result: updatedAt,
          },
        };
      },
    );

    expect(revalidationCount).toBe(2);
    expect(result.ledger.updatedAt).toBe('2026-06-13T23:15:00.000Z');
    expect(result.result).toBe('2026-06-13T23:15:00.000Z');
    expect(store.loadLedger()).toEqual(result.ledger);
  });

  it('should protect project ledger and raw findings with owner-only permissions', async () => {
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
      relation: 'new' as const,
    };

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const rawFindingsPath = join(projectCwd, '.takt/findings/raw/run-1.reviewers.json');
    store.saveRawFindings('run-1', 'reviewers', [rawFinding]);

    expect(statSync(join(projectCwd, '.takt/findings/peer-review.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectCwd, '.takt/findings/raw')).mode & 0o777).toBe(0o700);
    expect(statSync(rawFindingsPath).mode & 0o777).toBe(0o600);
  });

  it('should create a run-local audit snapshot without moving the project ledger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();

    expect(JSON.parse(readFileSync(copyPath, 'utf-8'))).toEqual(
      expect.objectContaining({ workflowName: 'peer-review', nextId: 2 }),
    );
    expect(existsSync(join(projectCwd, '.takt/findings/peer-review.json'))).toBe(true);
  });

  it('should reject adjudication attempts without reservation tokens through normal schema validation', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const projectLedgerPath = join(projectCwd, '.takt/findings/peer-review.json');
    mkdirSync(dirname(projectLedgerPath), { recursive: true });
    writeFileSync(projectLedgerPath, JSON.stringify({
      ...makeLedger(),
      conflicts: [{
        id: 'C-FA2947446963',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'active conflict',
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        adjudicationAttempts: [{
          evidenceHash: 'evidence-hash-without-reservation',
          startedAt: {
            runId: 'run-1',
            stepName: 'finding-conflict-adjudication',
            timestamp: '2026-06-13T01:00:00.000Z',
          },
        }],
      }],
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    expect(() => store.loadLedger()).toThrow(/reservationToken/);
  });

  it('should create the run-local ledger copy as owner-only read-only', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();

    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should accept an equivalent run copy published by a concurrent writer', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const ledger = store.loadLedger();
    const concurrentContent = JSON.stringify({
      ...ledger,
      updatedAt: '2026-06-13T00:00:01.000Z',
    }, null, 2);
    fsFailure.beforePublication = (targetPath) => {
      writeFileSync(targetPath, concurrentContent, { mode: 0o400 });
    };

    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();

    expect(readFileSync(copyPath, 'utf-8')).toBe(concurrentContent);
    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should regenerate an existing read-only run-local ledger copy', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();
    await store.updateLedger(() => ({
      ledger: { ...makeLedger(), nextId: 3 },
      result: undefined,
    }));
    store.saveLedgerSnapshot();

    expect(JSON.parse(readFileSync(copyPath, 'utf-8'))).toEqual(
      expect.objectContaining({ nextId: 3 }),
    );
    expect(statSync(copyPath).mode & 0o777).toBe(0o400);
  });

  it('should preserve a read-only run copy when it is replaced before publication', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const copyPath = join(reportDir, 'findings-ledger.json');
    store.saveLedgerSnapshot();
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

    expect(() => store.saveLedgerSnapshot()).toThrow(/identity changed/);

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
    expect(() => store.saveLedgerSnapshot()).toThrow(
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
      relation: 'new' as const,
    };

    const firstPath = join(projectCwd, '.takt/findings/raw/run-1.reviewers.json');
    const secondPath = join(projectCwd, '.takt/findings/raw/run-1.reviewers.2.json');
    store.saveRawFindings('run-1', 'reviewers', [rawFinding]);
    store.saveRawFindings('run-1', 'reviewers', [
      { ...rawFinding, rawFindingId: 'raw-2' },
    ]);

    expect(JSON.parse(readFileSync(firstPath, 'utf-8'))).toEqual([rawFinding]);
    expect(JSON.parse(readFileSync(secondPath, 'utf-8'))).toEqual([{ ...rawFinding, rawFindingId: 'raw-2' }]);
  });

  it('should reject symlinked ledger files before writing outside the projectCwd', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const outsideDir = makeTempDir('takt-findings-outside-');
    const outsideLedgerPath = join(outsideDir, 'peer-review.json');
    writeFileSync(outsideLedgerPath, 'outside-ledger', 'utf-8');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    symlinkSync(outsideLedgerPath, join(projectCwd, '.takt', 'findings', 'peer-review.json'));
    const store = createStore({ projectCwd, reportDir });

    await expect(store.updateLedger(() => ({
      ledger: makeLedger(),
      result: undefined,
    }))).rejects.toThrow('must not be a symbolic link');
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
        relation: 'new',
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

  it('should reject a ledger parent swap before publishing without changing either ledger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const initialLedger = makeLedger();
    await store.updateLedger(() => ({ ledger: initialLedger, result: undefined }));
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

    await expect(store.updateLedger(() => ({
      ledger: { ...initialLedger, nextId: 3 },
      result: undefined,
    }))).rejects.toThrow(/identity changed/);

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

    expect(() => store.saveLedgerSnapshot()).toThrow('Finding ledger path escapes base directory');
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

    expect(() => store.saveLedgerSnapshot()).toThrow('Finding ledger path escapes base directory');
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

    expect(() => store.saveLedgerSnapshot()).toThrow('Finding ledger path must not be a symbolic link');
    expect(existsSync(join(reportDir, 'findings-ledger.json'))).toBe(false);
  });

  it('should replace the current project ledger through updateLedger', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    mkdirSync(join(projectCwd, '.takt', 'findings'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'findings', 'peer-review.json'), JSON.stringify({
      ...makeLedger(),
      nextId: 1,
      findings: [],
    }), 'utf-8');
    const store = createStore({ projectCwd, reportDir });

    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));

    expect(store.loadLedger()).toEqual(expect.objectContaining({
      nextId: 2,
      findings: [expect.objectContaining({ id: 'F-0001' })],
    }));
  });

  it('should apply updateLedger against the ledger already on disk, not a stale in-memory copy', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));

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
    await store.updateLedger(() => ({ ledger: initialLedger, result: undefined }));

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
    await store.updateLedger(() => ({ ledger: initialLedger, result: undefined }));
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
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));

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

  it('should reject a stale process update at the publication boundary so a safe retry preserves both updates', async () => {
    const projectCwd = makeTempDir('takt-findings-process-cas-');
    const reportDir = join(projectCwd, '.takt', 'runs', 'parent', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    await store.updateLedger(() => ({ ledger: makeLedger(), result: undefined }));
    const releasePath = join(projectCwd, 'release');
    const fixturePath = fileURLToPath(new URL(
      './fixtures/finding-ledger-concurrent-update.ts',
      import.meta.url,
    ));
    const viteNodePath = join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
    const readyPaths = ['one', 'two'].map((workerId) => join(projectCwd, `ready-${workerId}`));
    const workers = readyPaths.map((readyPath, index) => new Promise<void>((resolve, reject) => {
      const workerId = String(index + 1);
      const child = spawn(process.execPath, [
        viteNodePath,
        fixturePath,
        projectCwd,
        workerId,
        readyPath,
        releasePath,
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Finding ledger worker ${workerId} failed: ${stderr}`));
        }
      });
    }));
    const deadline = Date.now() + 10_000;
    while (readyPaths.some((readyPath) => !existsSync(readyPath))) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for finding ledger workers');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(releasePath, 'go', 'utf-8');

    await Promise.all(workers);

    expect(store.loadLedger().nextId).toBe(4);
  }, 20_000);

  it('should canonicalize a missing ledger through the longest existing symlink ancestor', async () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const stateDir = join(projectCwd, 'state');
    const reportDirA = makeTempDir('takt-findings-report-a-');
    const reportDirB = makeTempDir('takt-findings-report-b-');
    mkdirSync(stateDir);
    symlinkSync(stateDir, join(projectCwd, '.takt'), 'dir');

    const aliasStore = createFindingLedgerStore({
      projectCwd,
      reportDir: reportDirA,
      workflowName: 'peer-review',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });
    const physicalStore = createFindingLedgerStore({
      projectCwd,
      reportDir: reportDirB,
      workflowName: 'peer-review',
      ledgerPath: 'state/findings/peer-review.json',
      rawFindingsPath: 'state/findings/raw',
    });
    const otherLedgerStore = createFindingLedgerStore({
      projectCwd,
      reportDir: reportDirB,
      workflowName: 'peer-review',
      ledgerPath: 'state/findings/other.json',
      rawFindingsPath: 'state/findings/raw',
    });

    expect(existsSync(join(stateDir, 'findings'))).toBe(false);
    expect(aliasStore.ledgerIdentity).toBe(physicalStore.ledgerIdentity);
    expect(aliasStore.ledgerIdentity).not.toBe(otherLedgerStore.ledgerIdentity);

    let activeRounds = 0;
    let maximumActiveRounds = 0;
    const enterRound = async (store: typeof aliasStore): Promise<void> => {
      await runManagerRoundExclusive(store, async () => {
        activeRounds += 1;
        maximumActiveRounds = Math.max(maximumActiveRounds, activeRounds);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRounds -= 1;
      });
    };

    await Promise.all([enterRound(aliasStore), enterRound(physicalStore)]);

    expect(maximumActiveRounds).toBe(1);
  });

  it('should hide every completed projection until the exact pending publication CAS finalizes', () => {
    const previousLedger: FindingLedger = {
      ...makeLedger(),
      reviewIntegrity: {
        roundMarkers: ['review-round-1'],
        firstRoundAt: makeLedger().updatedAt,
        exhausted: false,
      },
    };
    const roundMarker = 'round-pending';
    const conflictWithoutId = {
      status: 'active' as const,
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-pending'],
      description: 'Pending conflict.',
      firstSeen: {
        runId: 'run-pending',
        stepName: 'reviewers',
        timestamp: '2026-06-14T00:00:00.000Z',
      },
      lastSeen: {
        runId: 'run-pending',
        stepName: 'reviewers',
        timestamp: '2026-06-14T00:00:00.000Z',
      },
    };
    const completedLedger: FindingLedger = {
      ...previousLedger,
      nextId: 3,
      updatedAt: '2026-06-14T00:00:00.000Z',
      findings: previousLedger.findings.map((finding) => ({
        ...finding,
        status: 'resolved',
        lifecycle: 'resolved',
        revision: finding.revision + 1,
        resolvedAt: '2026-06-14T00:00:00.000Z',
        resolvedEvidence: 'Resolved in the pending round.',
      })),
      rawFindings: [{
        rawFindingId: 'raw-pending',
        stepName: 'reviewers',
        reviewer: 'reviewer',
        familyTag: 'bug',
        severity: 'high',
        title: 'Pending raw',
        description: 'Pending raw description.',
        relation: 'new',
        evidence: { kind: 'locationless', explanation: 'Pending evidence.' },
      }],
      conflicts: [{
        id: formatConflictId(conflictWithoutId),
        ...conflictWithoutId,
      }],
      interpretations: [{
        interpretationKey: 'pending-interpretation:1',
        baseInterpretationKey: 'pending-interpretation',
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable',
        lineageKey: 'pending-lineage',
        candidateEvidenceHash: 'pending-evidence-hash',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'interpretation_started',
        reservationToken: 'pending-reservation',
        startedAt: conflictWithoutId.firstSeen,
        promptPreconditions: [],
      }],
      fixpoint: {
        snapshot: {
          provisionalKeys: [],
          substantiveEntries: ['F-0001:resolved'],
          unadjudicatedConflictEntries: [],
        },
        reached: false,
      },
      stopBudget: {
        roundMarkers: [roundMarker],
        firstRoundAt: previousLedger.updatedAt,
        exhausted: false,
      },
      reviewerAnomalies: [{
        id: 'RA-PENDING',
        kind: 'quote-mismatch',
        stableKey: 'pending-anomaly',
        lineageKey: 'pending-anomaly-lineage',
        sourceRawFindingIds: ['raw-pending'],
        reviewers: ['reviewer'],
        title: 'Pending anomaly',
        mismatchReason: 'Pending quote does not match.',
        firstObserved: conflictWithoutId.firstSeen,
        lastObserved: conflictWithoutId.lastSeen,
        occurrences: 1,
      }],
      reviewIntegrity: {
        roundMarkers: ['review-round-1', roundMarker],
        firstRoundAt: previousLedger.updatedAt,
        exhausted: false,
      },
    };
    const report = {
      version: 1 as const,
      runId: 'run-pending',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    const publication = makePendingPublication(report);
    const staged = stagePendingManagerCommit({
      completedLedger,
      previousLedger,
      roundMarker,
      publication,
    });

    expect(staged.stopBudget).toBeUndefined();
    expect(staged.nextId).toBe(previousLedger.nextId);
    expect(staged.updatedAt).toBe(previousLedger.updatedAt);
    expect(staged.findings).toEqual(previousLedger.findings);
    expect(staged.rawFindings).toEqual(previousLedger.rawFindings);
    expect(staged.conflicts).toEqual(previousLedger.conflicts);
    expect(staged.interpretations).toEqual(previousLedger.interpretations);
    expect(staged.fixpoint).toEqual(previousLedger.fixpoint);
    expect(staged.reviewerAnomalies).toEqual(previousLedger.reviewerAnomalies);
    expect(staged.reviewIntegrity).toEqual(previousLedger.reviewIntegrity);
    expect(staged.pendingManagerCommit?.roundMarker).toBe(roundMarker);
    expect(staged.pendingManagerCommit?.completed.reviewIntegrity).toEqual(
      completedLedger.reviewIntegrity,
    );
    expect(parseFindingLedger(staged)).toEqual(staged);
    expect(() => finalizePendingManagerCommit(staged, 'd'.repeat(64))).toThrow(
      'Pending manager commit CAS failed',
    );

    const finalized = finalizePendingManagerCommit(staged, publication.publicationId);

    expect(finalized.pendingManagerCommit).toBeUndefined();
    expect(finalized.nextId).toBe(completedLedger.nextId);
    expect(finalized.updatedAt).toBe(completedLedger.updatedAt);
    expect(finalized.findings).toEqual(completedLedger.findings);
    expect(finalized.rawFindings).toEqual(completedLedger.rawFindings);
    expect(finalized.conflicts).toEqual(completedLedger.conflicts);
    expect(finalized.interpretations).toEqual(completedLedger.interpretations);
    expect(finalized.fixpoint).toEqual(completedLedger.fixpoint);
    expect(finalized.reviewerAnomalies).toEqual(completedLedger.reviewerAnomalies);
    expect(finalized.stopBudget?.roundMarkers).toEqual([roundMarker]);
    expect(finalized.reviewIntegrity).toEqual(completedLedger.reviewIntegrity);
    expect(() => finalizePendingManagerCommit(finalized, publication.publicationId)).toThrow(
      'Pending manager commit CAS failed',
    );
  });

  it.each([
    ['raw deletion', (_raw: RawFinding) => []],
    ['typed evidence replacement', (raw: RawFinding) => [{
      ...raw,
      evidence: { kind: 'locationless' as const, explanation: 'evidence E2' },
    }]],
  ])('should reject pending %s at filesystem stage and dedicated finalization', async (
    _label,
    attack,
  ) => {
    const projectCwd = makeTempDir('takt-findings-pending-raw-integrity-');
    const runId = 'pending-raw-integrity-run';
    const reportDir = join(projectCwd, '.takt', 'runs', runId, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const rawE1: RawFinding = {
      rawFindingId: 'raw-pending-integrity',
      stepName: 'reviewers',
      reviewer: 'reviewer',
      familyTag: 'bug',
      severity: 'high',
      title: 'Pending integrity raw',
      description: 'Pending integrity description',
      relation: 'new',
      evidence: { kind: 'locationless', explanation: 'evidence E1' },
    };
    await store.updateLedger((current) => ({
      ledger: { ...current, rawFindings: [rawE1] },
      result: undefined,
    }));
    const previousLedger = store.loadLedger();
    const roundMarker = `round-${_label.replaceAll(' ', '-')}`;
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const validStaged = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    const maliciousStaged: FindingLedger = {
      ...validStaged,
      pendingManagerCommit: {
        ...validStaged.pendingManagerCommit!,
        completed: {
          ...validStaged.pendingManagerCommit!.completed,
          rawFindings: attack(rawE1),
        },
      },
    };

    await expect(Promise.resolve().then(() => store.updateLedger(() => ({
      ledger: maliciousStaged,
      result: undefined,
    })))).rejects.toThrow(/append-only|replaced with different content/);

    await store.commitManagerLedger(() => ({ ledger: validStaged, result: undefined }));
    const receipt = store.publishManagerValidationPublication(publication);
    writeFileSync(
      join(projectCwd, '.takt', 'findings', 'peer-review.json'),
      JSON.stringify(maliciousStaged, null, 2),
      'utf-8',
    );

    await expect(store.finalizeManagerValidationPublication(publication, receipt))
      .rejects.toThrow(/append-only|replaced with different content/);
  });

  it('should reject exact pending finalization through general filesystem ledger mutations', async () => {
    const projectCwd = makeTempDir('takt-findings-general-finalization-project-');
    const reportDir = join(
      projectCwd,
      '.takt',
      'runs',
      'general-finalization-run',
      'reports',
    );
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousLedger = makeLedger();
    const roundMarker = 'general-finalization-round';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId: 'general-finalization-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const staged = stagePendingManagerCommit({
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      previousLedger,
      roundMarker,
      publication,
    });
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await expect(store.updateLedger(() => ({
      ledger: staged,
      result: undefined,
    }))).rejects.toThrow(/cannot be staged through the general mutation API/i);
    await store.commitManagerLedger(() => ({ ledger: staged, result: undefined }));
    const finalized = finalizePendingManagerCommit(staged, publication.publicationId);

    await expect(store.updateLedger(() => ({
      ledger: finalized,
      result: undefined,
    }))).rejects.toThrow(/pending.*dedicated finalization/i);
    expect(store.loadLedger()).toEqual(staged);
  });

  it('should isolate direct callback mutation from the filesystem comparison baseline', async () => {
    const projectCwd = makeTempDir('takt-findings-callback-isolation-project-');
    const reportDir = join(
      projectCwd,
      '.takt',
      'runs',
      'callback-isolation-run',
      'reports',
    );
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousLedger = makeLedger();
    const roundMarker = 'callback-isolation-round';
    const publication = store.planManagerValidationPublication(roundMarker, {
      version: 1,
      runId: 'callback-isolation-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    });
    const staged = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));

    await expect(store.updateLedger((current) => {
      current.pendingManagerCommit = staged.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/cannot be staged through the general mutation API/i);

    await store.commitManagerLedger(() => ({ ledger: staged, result: undefined }));

    await expect(store.updateLedger((current) => {
      current.pendingManagerCommit!.publication.destinationRunId = 'forged-run';
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(store.updateLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(store.updateLedger(
      (current) => ({ ledger: current, result: undefined }),
      (current, mutation) => {
        delete current.pendingManagerCommit;
        mutation.ledger = current;
        return { mutation, publish: true };
      },
    )).rejects.toThrow(/pending.*dedicated finalization/i);

    await expect(store.commitManagerLedger((current) => {
      delete current.pendingManagerCommit;
      return { ledger: current, result: undefined };
    })).rejects.toThrow(/pending.*dedicated finalization/i);

    expect(store.loadLedger()).toEqual(staged);
  });

  it('should allow exactly one competing finalization through the real filesystem store', async () => {
    const projectCwd = makeTempDir('takt-findings-competing-finalize-project-');
    const reportDir = join(
      projectCwd,
      '.takt',
      'runs',
      'competing-finalize-run',
      'reports',
    );
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousLedger = makeLedger();
    const roundMarker = 'competing-finalize-round';
    const report = {
      version: 1 as const,
      runId: 'competing-finalize-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    const publication = store.planManagerValidationPublication(roundMarker, report);
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    const staged = stagePendingManagerCommit({
      previousLedger,
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      roundMarker,
      publication,
    });
    await store.commitManagerLedger(() => ({ ledger: staged, result: undefined }));
    const receipt = store.publishManagerValidationPublication(publication);

    const results = await Promise.allSettled([
      store.finalizeManagerValidationPublication(publication, receipt),
      store.finalizeManagerValidationPublication(publication, receipt),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
    expect(store.loadLedger().stopBudget?.roundMarkers).toEqual([roundMarker]);
  });

  it('should not publish a persisted pending report through an unrelated report directory', async () => {
    const projectCwd = makeTempDir('takt-findings-pending-domain-project-');
    const reportDirA = join(projectCwd, '.takt', 'runs', 'pending-domain-run', 'reports');
    const reportDirB = join(projectCwd, '.takt', 'runs', 'unrelated-run', 'reports');
    mkdirSync(reportDirA, { recursive: true });
    mkdirSync(reportDirB, { recursive: true });
    const storeA = createStore({ projectCwd, reportDir: reportDirA });
    const storeB = createStore({ projectCwd, reportDir: reportDirB });
    const previousLedger = makeLedger();
    const roundMarker = 'pending-domain-round';
    const report = {
      version: 1 as const,
      runId: 'pending-domain-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    await storeA.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    const staged = stagePendingManagerCommit({
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      previousLedger,
      roundMarker,
      publication: storeA.planManagerValidationPublication(roundMarker, report),
    });
    await storeA.commitManagerLedger(() => ({ ledger: staged, result: undefined }));
    writeForgedResumeManifest(projectCwd, 'pending-domain-run', 'unrelated-run');

    await expect(resumePendingManagerCommit(
      { ledgerStore: storeB } as never,
      storeB.loadLedger(),
    )).rejects.toThrow(/publication destination|report directory/i);

    expect(storeB.loadLedger().pendingManagerCommit).toBeDefined();
    expect(existsSync(join(reportDirB, 'findings-manager-validation.reviewers.json'))).toBe(false);
  });

  it('should authorize pending publication rebinding from the trusted resume source without trusting a report manifest', async () => {
    const projectCwd = makeTempDir('takt-findings-trusted-resume-project-');
    const sourceRunId = 'trusted-source-run';
    const targetRunId = 'trusted-target-run';
    const attackerRunId = 'untrusted-attacker-run';
    const sourceReports = join(projectCwd, '.takt', 'runs', sourceRunId, 'reports');
    const targetReports = join(projectCwd, '.takt', 'runs', targetRunId, 'reports');
    const attackerReports = join(projectCwd, '.takt', 'runs', attackerRunId, 'reports');
    mkdirSync(sourceReports, { recursive: true });
    mkdirSync(targetReports, { recursive: true });
    mkdirSync(attackerReports, { recursive: true });
    const sourceStore = createStore({ projectCwd, reportDir: sourceReports });
    const attackerStore = createStore({ projectCwd, reportDir: attackerReports });
    const targetStore = createStore({
      projectCwd,
      reportDir: targetReports,
      trustedResumeSourceRunId: sourceRunId,
    });
    const previousLedger = makeLedger();
    const roundMarker = 'trusted-resume-round';
    const report = {
      version: 1 as const,
      runId: sourceRunId,
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    await sourceStore.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await sourceStore.commitManagerLedger(() => ({
      ledger: stagePendingManagerCommit({
        completedLedger: {
          ...previousLedger,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: previousLedger.updatedAt,
            exhausted: false,
          },
        },
        previousLedger,
        roundMarker,
        publication: sourceStore.planManagerValidationPublication(roundMarker, report),
      }),
      result: undefined,
    }));
    const staged = attackerStore.loadLedger();
    const pending = staged.pendingManagerCommit!;
    const stolen: FindingLedger = {
      ...staged,
      pendingManagerCommit: {
        ...pending,
        publication: {
          ...pending.publication,
          destinationRunId: attackerRunId,
        },
      },
    };

    await expect(attackerStore.rebindPendingManagerValidationPublication(
      stolen.pendingManagerCommit!.publication,
    )).rejects.toThrow(/not authorized to inherit/i);
    await expect(attackerStore.updateLedger(() => ({
      ledger: stolen,
      result: undefined,
    }))).rejects.toThrow(/pending.*dedicated.*rebind/i);
    expect(attackerStore.loadLedger().pendingManagerCommit?.publication.destinationRunId)
      .toBe(sourceRunId);

    await expect(resumePendingManagerCommit(
      { ledgerStore: targetStore } as never,
      targetStore.loadLedger(),
    )).resolves.toEqual(expect.objectContaining({ completedRoundMarker: roundMarker }));

    expect(targetStore.loadLedger().pendingManagerCommit).toBeUndefined();
    expect(existsSync(join(targetReports, 'findings-manager-validation.reviewers.json'))).toBe(true);
  });

  it('should rebind a pending publication at each trusted resume bootstrap hop before the manager is reached', async () => {
    const projectCwd = makeTempDir('takt-findings-multi-hop-resume-project-');
    const runIds = ['resume-hop-a', 'resume-hop-b', 'resume-hop-c'] as const;
    for (const runId of runIds) {
      mkdirSync(join(projectCwd, '.takt', 'runs', runId, 'reports'), { recursive: true });
    }
    const storeA = createStore({
      projectCwd,
      reportDir: join(projectCwd, '.takt', 'runs', runIds[0], 'reports'),
    });
    const previousLedger = makeLedger();
    const roundMarker = 'multi-hop-round';
    const report = {
      version: 1 as const,
      runId: runIds[0],
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    await storeA.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await storeA.commitManagerLedger(() => ({
      ledger: stagePendingManagerCommit({
        completedLedger: {
          ...previousLedger,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: previousLedger.updatedAt,
            exhausted: false,
          },
        },
        previousLedger,
        roundMarker,
        publication: storeA.planManagerValidationPublication(roundMarker, report),
      }),
      result: undefined,
    }));
    const storeB = createStore({
      projectCwd,
      reportDir: join(projectCwd, '.takt', 'runs', runIds[1], 'reports'),
      trustedResumeSourceRunId: runIds[0],
    });
    const storeC = createStore({
      projectCwd,
      reportDir: join(projectCwd, '.takt', 'runs', runIds[2], 'reports'),
      trustedResumeSourceRunId: runIds[1],
    });
    const managerCommit = await import('../core/workflow/findings/manager-commit.js') as unknown as {
      rebindPendingManagerPublicationAtBootstrap: (store: typeof storeA) => Promise<void>;
    };

    await managerCommit.rebindPendingManagerPublicationAtBootstrap(storeB);
    expect(storeB.loadLedger().pendingManagerCommit?.publication.destinationRunId).toBe(runIds[1]);
    await managerCommit.rebindPendingManagerPublicationAtBootstrap(storeC);
    expect(storeC.loadLedger().pendingManagerCommit?.publication.destinationRunId).toBe(runIds[2]);

    await expect(resumePendingManagerCommit(
      { ledgerStore: storeC } as never,
      storeC.loadLedger(),
    )).resolves.toEqual(expect.objectContaining({ completedRoundMarker: roundMarker }));
  });

  it('should save manager validation reports under the run report directory', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });

    const reportPath = join(reportDir, 'findings-manager-validation.reviewers.json');
    store.saveManagerValidationReport({
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
    const historyFiles = publicationHistoryPaths(reportDir, latestPath);
    expect(JSON.parse(readFileSync(latestPath, 'utf-8'))).toEqual(expect.objectContaining({
      runId: 'run-2',
      ledgerUpdated: true,
    }));
    expect(historyFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(historyFiles[0]!, 'utf-8'))).toEqual(expect.objectContaining({
      runId: 'run-1',
      ledgerUpdated: false,
    }));
  });

  it('should create one deterministic history entry when latest publication fails after backup and is retried', () => {
    const projectCwd = makeTempDir('takt-findings-project-');
    const reportDir = makeTempDir('takt-findings-report-');
    const store = createStore({ projectCwd, reportDir });
    const firstReport = {
      version: 1 as const,
      runId: 'run-history-1',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    const secondReport = {
      ...firstReport,
      runId: 'run-history-2',
    };
    store.saveManagerValidationReport(firstReport);
    fsFailure.failWriteOnce = (path) => {
      if (!basename(path).startsWith('.findings-manager-validation.reviewers.json')) {
        return false;
      }
      return true;
    };

    expect(() => store.saveManagerValidationReport(secondReport)).toThrow('injected write failure');
    store.saveManagerValidationReport(secondReport);

    const latestPath = join(reportDir, 'findings-manager-validation.reviewers.json');
    const historyFiles = publicationHistoryPaths(reportDir, latestPath);
    expect(historyFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(historyFiles[0]!, 'utf-8'))).toEqual(firstReport);
    expect(JSON.parse(readFileSync(
      join(reportDir, 'findings-manager-validation.reviewers.json'),
      'utf-8',
    ))).toEqual(secondReport);
  });

  it('should retain every predecessor when direct publications repeat A to B to C to B', () => {
    const projectCwd = makeTempDir('takt-findings-repeated-history-project-');
    const reportDir = makeTempDir('takt-findings-repeated-history-report-');
    const store = createStore({ projectCwd, reportDir });
    const reportA = {
      version: 1 as const,
      runId: 'history-a',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: false,
      finalErrors: ['A'],
      attempts: [],
    };
    const reportB = { ...reportA, runId: 'history-b', finalErrors: ['B'] };
    const reportC = { ...reportA, runId: 'history-c', finalErrors: ['C'] };

    for (const report of [reportA, reportB, reportC, reportB]) {
      store.saveManagerValidationReport(report);
    }

    const latestPath = join(reportDir, 'findings-manager-validation.reviewers.json');
    const historyFiles = publicationHistoryPaths(reportDir, latestPath);
    expect(historyFiles).toHaveLength(3);
    expect(historyFiles.map((path) => (
      JSON.parse(readFileSync(path, 'utf-8')).runId
    )).sort()).toEqual(['history-a', 'history-b', 'history-c']);
    expect(JSON.parse(readFileSync(
      join(reportDir, 'findings-manager-validation.reviewers.json'),
      'utf-8',
    ))).toEqual(reportB);
  });

  it('should preserve a concurrently created report when publication expected the target to be absent', () => {
    const reportDir = makeTempDir('takt-findings-report-cas-absent-');
    const targetPath = join(reportDir, 'manager.json');
    const concurrentContent = 'concurrent\n';
    const publicationContent = 'publication\n';
    const readPrivateFileState = privateFile.readPrivateFileState;
    const readSpy = vi.spyOn(privateFile, 'readPrivateFileState').mockImplementation((path) => {
      const snapshot = readPrivateFileState(path);
      if (path === targetPath && !snapshot.state.exists) {
        runChildFileMutation(
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf-8')",
          [targetPath, concurrentContent],
        );
      }
      return snapshot;
    });

    try {
      expect(() => publishReportFile({
        reportDir,
        fileName: 'manager.json',
        content: publicationContent,
        publicationId: 'a'.repeat(64),
        contentSha256: sha256(publicationContent),
      })).toThrow(/identity changed|publication conflict/i);
    } finally {
      readSpy.mockRestore();
    }

    expect(readFileSync(targetPath, 'utf-8')).toBe(concurrentContent);
  });

  it('should hold the publication lock while a normal report writer replaces the target', () => {
    const reportDir = makeTempDir('takt-findings-report-normal-writer-lock-');
    const targetPath = join(reportDir, 'manager.json');
    const publicationLockPath = join(
      reportDir,
      '.takt-report-internal',
      'locks',
      `${sha256(['filesystem-report', resolve(targetPath)].join('\0'))}.lock`,
    );
    let publicationLockWasHeld = false;
    fsFailure.beforeOpen = (openedPath) => {
      if (basename(openedPath).startsWith(`.manager.json.${process.pid}.`)) {
        publicationLockWasHeld = existsSync(publicationLockPath);
      }
    };

    writeReportFile(reportDir, 'manager.json', 'replacement\n');

    expect(publicationLockWasHeld).toBe(true);
  });

  it('should keep publication history unreachable from normal and cross-stream writers', () => {
    const reportDir = makeTempDir('takt-findings-report-history-namespace-');
    const targetPath = join(reportDir, 'manager.json');
    publishReportFile({
      reportDir,
      fileName: 'manager.json',
      content: 'first\n',
      publicationId: 'e'.repeat(64),
      contentSha256: sha256('first\n'),
    });
    publishReportFile({
      reportDir,
      fileName: 'manager.json',
      content: 'second\n',
      publicationId: 'f'.repeat(64),
      contentSha256: sha256('second\n'),
    });
    const historyPath = publicationHistoryPaths(reportDir, targetPath)[0]!;
    const internalName = relative(reportDir, historyPath);

    expect(() => writeReportFile(reportDir, internalName, 'tampered\n'))
      .toThrow(/internal report namespace/);
    expect(() => publishReportFile({
      reportDir,
      fileName: internalName,
      content: 'tampered\n',
      publicationId: '1'.repeat(64),
      contentSha256: sha256('tampered\n'),
    })).toThrow(/internal report namespace/);
    expect(readFileSync(historyPath, 'utf-8')).toBe('first\n');
  });

  it('should release the publication lock when a normal report writer fails', () => {
    const reportDir = makeTempDir('takt-findings-report-writer-release-');
    const targetPath = join(reportDir, 'manager.json');
    fsFailure.failWriteOnce = (path) => (
      basename(path).startsWith(`.manager.json.${process.pid}.`)
    );

    expect(() => writeReportFile(reportDir, 'manager.json', 'failed\n'))
      .toThrow('injected write failure');
    expect(() => writeReportFile(reportDir, 'manager.json', 'recovered\n'))
      .not.toThrow();
    expect(readFileSync(targetPath, 'utf-8')).toBe('recovered\n');
  });

  it('should revalidate the report only after the ledger queue is available', async () => {
    const projectCwd = makeTempDir('takt-findings-finalize-lock-order-project-');
    const reportDir = join(
      projectCwd,
      '.takt',
      'runs',
      'finalize-lock-order-run',
      'reports',
    );
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousLedger = makeLedger();
    const roundMarker = 'finalize-lock-order-round';
    const report = {
      version: 1 as const,
      runId: 'finalize-lock-order-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    const publication = store.planManagerValidationPublication(roundMarker, report);
    const staged = stagePendingManagerCommit({
      completedLedger: {
        ...previousLedger,
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: previousLedger.updatedAt,
          exhausted: false,
        },
      },
      previousLedger,
      roundMarker,
      publication,
    });
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await store.commitManagerLedger(() => ({ ledger: staged, result: undefined }));
    const receipt = store.publishManagerValidationPublication(publication);
    let releaseQueue!: () => void;
    let queueEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      queueEntered = resolveEntered;
    });
    const queueBlocker = runLedgerUpdateExclusive(store.ledgerIdentity, async () => {
      queueEntered();
      await new Promise<void>((resolveQueue) => {
        releaseQueue = resolveQueue;
      });
    });
    await entered;

    const finalization = store.finalizeManagerValidationPublication(publication, receipt);
    writeReportFile(
      reportDir,
      publication.fileName,
      JSON.stringify({ ...report, retryCount: 1 }, null, 2),
    );
    releaseQueue();

    await queueBlocker;
    await expect(finalization).rejects.toThrow(/changed before manager finalization/);
    expect(store.loadLedger()).toEqual(staged);
  });

  it('should resume after latest publication succeeds but final ledger CAS crashes', async () => {
    const projectCwd = makeTempDir('takt-findings-finalize-resume-project-');
    const reportDir = join(projectCwd, '.takt', 'runs', 'finalize-resume-run', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousLedger = makeLedger();
    const roundMarker = 'finalize-resume-round';
    const report = {
      version: 1 as const,
      runId: 'finalize-resume-run',
      stepName: 'reviewers',
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
      attempts: [],
    };
    const publication = store.planManagerValidationPublication(roundMarker, report);
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await store.commitManagerLedger(() => ({
      ledger: stagePendingManagerCommit({
        completedLedger: {
          ...previousLedger,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: previousLedger.updatedAt,
            exhausted: false,
          },
        },
        previousLedger,
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    const finalizePublication = store.finalizeManagerValidationPublication;
    vi.spyOn(store, 'finalizeManagerValidationPublication')
      .mockImplementationOnce(async () => {
        throw new Error('injected final ledger CAS crash');
      })
      .mockImplementation(finalizePublication);

    await expect(resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    )).rejects.toThrow('injected final ledger CAS crash');

    expect(store.loadLedger().pendingManagerCommit?.publication.publicationId)
      .toBe(publication.publicationId);
    expect(JSON.parse(readFileSync(
      join(reportDir, publication.fileName),
      'utf-8',
    ))).toEqual(report);

    const resumed = await resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    );

    expect(resumed?.completedRoundMarker).toBe(roundMarker);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
    expect(store.loadLedger().stopBudget?.roundMarkers).toEqual([roundMarker]);
    expect(await resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    )).toBeUndefined();
  });

  it('should resume one pending publication after backup succeeds but latest write fails', async () => {
    const projectCwd = makeTempDir('takt-findings-backup-resume-project-');
    const reportDir = join(projectCwd, '.takt', 'runs', 'backup-resume-run', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const store = createStore({ projectCwd, reportDir });
    const previousReport = {
      version: 1 as const,
      runId: 'backup-resume-run',
      stepName: 'reviewers',
      retryCount: 1,
      ledgerUpdated: false,
      finalErrors: ['previous validation failure'],
      attempts: [],
    };
    store.saveManagerValidationReport(previousReport);
    const report = {
      ...previousReport,
      retryCount: 0,
      ledgerUpdated: true,
      finalErrors: [],
    };
    const previousLedger = makeLedger();
    const roundMarker = 'backup-resume-round';
    const publication = store.planManagerValidationPublication(roundMarker, report);
    await store.updateLedger(() => ({ ledger: previousLedger, result: undefined }));
    await store.commitManagerLedger(() => ({
      ledger: stagePendingManagerCommit({
        completedLedger: {
          ...previousLedger,
          stopBudget: {
            roundMarkers: [roundMarker],
            firstRoundAt: previousLedger.updatedAt,
            exhausted: false,
          },
        },
        previousLedger,
        roundMarker,
        publication,
      }),
      result: undefined,
    }));
    fsFailure.failWriteOnce = (path) => {
      if (!basename(path).startsWith('.findings-manager-validation.reviewers.json')) {
        return false;
      }
      return true;
    };

    await expect(resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    )).rejects.toThrow('injected write failure');
    expect(store.loadLedger().pendingManagerCommit).toBeDefined();

    await resumePendingManagerCommit(
      { ledgerStore: store } as never,
      store.loadLedger(),
    );

    const historyFiles = publicationHistoryPaths(
      reportDir,
      join(reportDir, publication.fileName),
    );
    expect(historyFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(historyFiles[0]!, 'utf-8')))
      .toEqual(previousReport);
    expect(JSON.parse(readFileSync(join(reportDir, publication.fileName), 'utf-8')))
      .toEqual(report);
    expect(store.loadLedger().pendingManagerCommit).toBeUndefined();
  });
});
