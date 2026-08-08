import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { cleanupTestFindingStorage, createTestFindingLedgerStore } from '../../src/__tests__/helpers/finding-storage.js';
import { authorizeFindingLedgerFixture, canonicalRawFindingFixture } from '../../src/__tests__/helpers/finding-lifecycle-fixture.js';
import type { FindingLedger, ReviewerAnomalyEntry } from '../../src/core/workflow/findings/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function singleRunSlug(repoPath: string): string {
  const runsDir = join(repoPath, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    throw new Error('Expected the bootstrap run directory to exist');
  }
  const slugs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (slugs.length !== 1 || slugs[0] === undefined) {
    throw new Error(`Expected one bootstrap run, got ${slugs.length}`);
  }
  return slugs[0];
}

function readRunSessionRecords(repoPath: string, runSlug: string): Array<Record<string, unknown>> {
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

async function seedRestatementAnomaly(repoPath: string, runSlug: string): Promise<void> {
  const reportDir = join(repoPath, '.takt', 'runs', runSlug, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const observedAt = {
    runId: runSlug,
    stepName: 'review',
    timestamp: '2026-08-05T00:00:00.000Z',
  } as const;
  const claim = 'The target value must be repaired.';
  const raw = canonicalRawFindingFixture({
    rawFindingId: 'raw-weak-restatement',
    stepName: 'review',
    reviewer: 'review',
    familyTag: null,
    severity: null,
    title: null,
    description: null,
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/target.ts'] },
    rawExcerpt: claim,
    evidence: [],
    sourceBinding: {
      reportDigest: '1'.repeat(64),
      startByte: 0,
      endByte: Buffer.byteLength(claim),
      excerptDigest: '2'.repeat(64),
    },
  });
  const anomaly: ReviewerAnomalyEntry = {
    id: 'RA-E2E-RESTATEMENT',
    kind: 'intake-contract-incomplete',
    stableKey: '3'.repeat(64),
    lineageKey: '4'.repeat(64),
    sourceRawFindingIds: [raw.rawFindingId],
    sourceIntakeIds: [],
    reviewers: ['review'],
    title: 'Incomplete reviewer claim',
    claimedExcerpt: claim,
    mismatchReason: 'The reviewer claim carried no claim text and offered no evidence.',
    intakeContract: {
      observationClass: 'claim-bearing',
      classificationAuthorityId: 'system/intake_observation_classification_v1',
      reasonCodes: ['product-identity-incomplete'],
      // seed した raw は description なし・evidence なし・code target。分類事務
      // （severity / title / familyTag）は契約の要件ではないので入らない。
      missingRequirements: ['claimEvidence', 'description'],
      presentationOwnerReviewer: 'review',
      presentationLimit: 2,
    },
    firstObserved: observedAt,
    lastObserved: observedAt,
    occurrences: 1,
  };
  const store = createTestFindingLedgerStore({
    projectCwd: repoPath,
    runId: runSlug,
    reportDir,
    workflowName: 'e2e-finding-contract-restatement',
  });
  const current = store.loadLedger();
  const ledger = authorizeFindingLedgerFixture({
    ...current,
    workflowName: 'e2e-finding-contract-restatement',
    updatedAt: observedAt.timestamp,
    rawFindings: [...current.rawFindings, raw],
    reviewerAnomalies: [...(current.reviewerAnomalies ?? []), anomaly],
  } as FindingLedger);
  await store.updateLedger(() => ({ ledger, result: undefined }));
}

describe('E2E: Finding Contract restatement recovery (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let workflowPath: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'target.ts'), 'export const target = false;\n', 'utf-8');
    workflowPath = join(repo.path, '.takt', 'workflows', 'e2e-finding-contract-restatement.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, readFileSync(resolve(
      __dirname,
      '../fixtures/workflows/finding-contract-restatement.yaml',
    )));
  });

  afterEach(() => {
    cleanupTestFindingStorage();
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('promotes one clean restatement and reaches COMPLETE in one resume round', async () => {
    const bootstrap = runTakt({
      args: ['--provider', 'mock', '--task', 'Restate the seeded review claim.', '--workflow', workflowPath],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/finding-contract-restatement-bootstrap.json'),
      },
      timeout: 120_000,
    });
    expect(bootstrap.exitCode).not.toBe(0);
    const sourceRunSlug = singleRunSlug(repo.path);
    await seedRestatementAnomaly(repo.path, sourceRunSlug);

    const resumed = runTakt({
      args: ['resume'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/finding-contract-restatement-complete.json'),
      },
      timeout: 120_000,
    });

    const resumedRunSlug = readdirSync(join(repo.path, '.takt', 'runs'))
      .filter((runSlug) => runSlug !== sourceRunSlug)[0];
    expect(resumedRunSlug).toBeDefined();
    expect(resumed.exitCode).toBe(0);
    // Resume does not inherit the bootstrap CLI `--provider mock` override, so the
    // review step must be pinned to mock at the step level in the fixture workflow.
    // Without the pin the resumed round silently runs on the real default provider.
    expect(resumed.stdout).toContain('Provider: mock');
    expect(resumed.stdout).not.toContain('Provider: claude');
    expect(resumed.stdout).toContain('Workflow completed');
    const records = readRunSessionRecords(repo.path, resumedRunSlug!);
    expect(records.some((record) => record.type === 'workflow_complete')).toBe(true);
    expect(records.some((record) => record.type === 'step_complete' && record.step === 'review')).toBe(true);

    const reportDir = join(repo.path, '.takt', 'runs', resumedRunSlug!, 'reports');
    const store = createTestFindingLedgerStore({
      projectCwd: repo.path,
      runId: resumedRunSlug!,
      reportDir,
      workflowName: 'e2e-finding-contract-restatement',
    });
    const ledger = store.loadLedger();
    const anomaly = ledger.reviewerAnomalies?.find(({ id }) => id === 'RA-E2E-RESTATEMENT');
    expect(ledger.findings).toHaveLength(1);
    expect(anomaly?.promotedFindingId).toBe(ledger.findings[0]?.id);
    // 検証対象の admitted raw は「昇格した finding に束縛された raw」から解決する。
    // 「seed 以外の最初の raw」では、resume round が複数 raw を追加した場合に
    // 無関係な raw の source binding を検証してしまう。
    const promotedRawIds = ledger.findings[0]?.rawFindingIds ?? [];
    expect(promotedRawIds.length).toBeGreaterThan(0);
    const admitted = ledger.rawFindings.find(({ rawFindingId }) => promotedRawIds.includes(rawFindingId));
    expect(admitted?.sourceBinding.reportDigest).not.toBe('1'.repeat(64));
    expect(admitted?.sourceBinding.excerptDigest).not.toBe('2'.repeat(64));
  }, 120_000);
});
