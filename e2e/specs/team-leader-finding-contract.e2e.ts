import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import {
  cleanupTestFindingStorage,
  createTestFindingLedgerStore,
} from '../../src/__tests__/helpers/finding-storage.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from '../../src/__tests__/helpers/finding-lifecycle-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function seedFindingLedger(
  repoPath: string,
  sourceRunSlug: string,
): Promise<void> {
  const reportDir = join(repoPath, '.takt', 'runs', sourceRunSlug, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const raw = canonicalRawFindingFixture({
    rawFindingId: 'raw-1',
    stepName: 'reviewers',
    reviewer: 'test-reviewer',
    familyTag: 'correctness',
    severity: 'high',
    title: 'Target remains false',
    description: 'The target value must be repaired.',
    suggestion: 'Set the target to the required value.',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/target.ts'] },
    evidence: [],
  });
  const ledger = authorizeFindingLedgerFixture({
    workflowName: 'e2e-team-leader-finding-contract-fix',
    nextId: 2,
    updatedAt: '2026-07-23T00:00:00.000Z',
    rawFindings: [raw],
    conflicts: [],
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      target: raw.target,
      targetIdentityHash: raw.targetIdentityHash,
      claimIdentityHash: raw.claimIdentityHash,
      semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
      severity: 'high',
      title: 'Target remains false',
      evidenceIds: [],
      description: 'The target value must be repaired.',
      suggestion: 'Set the target to the required value.',
      reviewers: ['test-reviewer'],
      rawFindingIds: ['raw-1'],
      firstSeen: {
        runId: sourceRunSlug,
        stepName: 'reviewers',
        timestamp: '2026-07-23T00:00:00.000Z',
      },
      lastSeen: {
        runId: sourceRunSlug,
        stepName: 'reviewers',
        timestamp: '2026-07-23T00:00:00.000Z',
      },
      revision: 1,
    }],
  });
  const store = createTestFindingLedgerStore({
    projectCwd: repoPath,
    runId: sourceRunSlug,
    reportDir,
    workflowName: ledger.workflowName,
  });
  await store.updateLedger(() => ({ ledger, result: undefined }));
}

function singleRunSlug(repoPath: string): string {
  const runsDir = join(repoPath, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    throw new Error('Expected the failed source run directory to exist');
  }
  const slugs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (slugs.length !== 1 || slugs[0] === undefined) {
    throw new Error(`Expected one failed source run, got ${slugs.length}`);
  }
  return slugs[0];
}

function readRunSessionRecords(
  repoPath: string,
  runSlug: string,
): Array<Record<string, unknown>> {
  const logsDir = join(repoPath, '.takt', 'runs', runSlug, 'logs');
  const logFile = readdirSync(logsDir).find((file) => (
    file.endsWith('.jsonl')
    && !file.endsWith('-otel-session-shadow.jsonl')
    && !file.endsWith('-usage-events.jsonl')
  ));
  if (logFile === undefined) {
    throw new Error(`Session log is missing for run "${runSlug}"`);
  }
  return readFileSync(join(logsDir, logFile), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('E2E: Finding Contract Team Leader routing', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let workflowPath: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    delete isolatedEnv.env.CLAUDECODE;
    repo = createLocalRepo();
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(
      join(repo.path, 'src', 'target.ts'),
      'export const target = false;\n',
      'utf-8',
    );
    workflowPath = join(
      repo.path,
      '.takt',
      'workflows',
      'e2e-team-leader-finding-contract-fix.yaml',
    );
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, readFileSync(resolve(
      __dirname,
      '../fixtures/workflows/team-leader-finding-contract-fix.yaml',
    )));
  });

  afterEach(() => {
    cleanupTestFindingStorage();
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it.each([
    { scenario: 'team-leader-finding-contract-complete.json', expectedStep: 'reviewers' },
    { scenario: 'team-leader-finding-contract-replan.json', expectedStep: 'replan' },
  ])('routes an explicit decision to $expectedStep', async ({ scenario, expectedStep }) => {
    const source = runTakt({
      args: ['--provider', 'mock', '--task', 'Repair the seeded finding.', '--workflow', workflowPath],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios', scenario),
      },
      timeout: 120_000,
    });
    expect(source.exitCode).not.toBe(0);
    const sourceRunSlug = singleRunSlug(repo.path);
    await seedFindingLedger(repo.path, sourceRunSlug);

    const result = runTakt({
      args: ['resume'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios', scenario),
      },
      timeout: 120_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }
    expect(result.exitCode).toBe(0);
    const resumedRunSlugs = readdirSync(join(repo.path, '.takt', 'runs'))
      .filter((runSlug) => runSlug !== sourceRunSlug);
    expect(resumedRunSlugs).toHaveLength(1);
    const records = readRunSessionRecords(repo.path, resumedRunSlugs[0]!);
    const fix = records.find((record) => record.type === 'step_complete' && record.step === 'fix');
    expect(fix?.matchedRuleIndex).toBe(expectedStep === 'reviewers' ? 0 : 1);
    expect(records.some((record) => record.type === 'step_complete' && record.step === expectedStep)).toBe(true);
  }, 120_000);
});
