import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { cleanupTestFindingStorage, createTestFindingLedgerStore } from '../../src/__tests__/helpers/finding-storage.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from '../../src/__tests__/helpers/finding-lifecycle-fixture.js';
import { createProvisionalClaimBindingAuthorizationReference } from '../../src/core/models/finding-provisional-claim-authorization.js';
import { createEngineProofRecord } from '../../src/core/models/finding-evidence-record.js';
import type { FindingLedger } from '../../src/core/workflow/findings/types.js';

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

/**
 * run-3 実走回帰: 旧エンジンが作った「移行適格な legacy provisional」（evidence-less
 * pre-admission holding = allowlist B）を継承した run の最初の FC manager round が、
 * 移行を lifecycle event として CAS 保存できること（旧実装は
 * 'Lifecycle head "finding\0F-0001" does not match the current entity projection'
 * で abort していた）と、移行で生まれた anomaly が restatement 経由で promotion され
 * COMPLETE まで到達することを mock provider で検証する。
 */
async function seedLegacyProvisional(repoPath: string, runSlug: string): Promise<void> {
  const reportDir = join(repoPath, '.takt', 'runs', runSlug, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const observedAt = {
    runId: runSlug,
    stepName: 'review',
    timestamp: '2026-08-05T00:00:00.000Z',
  } as const;
  const claim = 'The legacy defect remains observable.';
  const raw = canonicalRawFindingFixture({
    rawFindingId: 'raw-legacy-holding',
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
  const snapshot = rawCanonicalSnapshotFixture(raw, observedAt);
  const findingId = 'F-0001';
  const provisional = {
    kind: 'raw-adjudication-unresolved' as const,
    stableKey: 'a'.repeat(64),
    lineageKey: 'b'.repeat(64),
    sourceRawFindingIds: [raw.rawFindingId],
    reason: 'evidence-less pre-admission holding',
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    gateEffect: 'block' as const,
    firstObservedRound: 1,
  };
  const authorization = createProvisionalClaimBindingAuthorizationReference({
    kind: 'new_provisional_bundle' as const,
    bindingDecisionId: 'd'.repeat(64),
    creationRequestKey: 'c'.repeat(64),
    expectedHead: null,
    sourceRawFindingIds: [raw.rawFindingId],
  });
  const proof = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: 'e2e-finding-contract-restatement',
    runId: observedAt.runId,
    scopeIdentity: 'scope',
    snapshotId: '1'.repeat(64),
    claimIdentityHash: raw.claimIdentityHash,
    targetFindingId: null,
    subject: {
      kind: 'finding_provisional_isolation',
      findingId,
      provisionalKind: 'raw-adjudication-unresolved',
      stableKey: provisional.stableKey,
      claimBindingAuthorizationReferences: [authorization],
    },
    dependencyDigests: [],
    resultDigest: '2'.repeat(64),
    issuedAt: observedAt.timestamp,
  });
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
    nextId: 2,
    findings: [...current.findings, {
      id: findingId,
      status: 'open' as const,
      lifecycle: 'new' as const,
      target: raw.target,
      targetIdentityHash: raw.targetIdentityHash,
      claimIdentityHash: raw.claimIdentityHash,
      semanticClaimIdentityHash: raw.semanticClaimIdentityHash,
      severity: null,
      title: null,
      evidenceIds: [proof.evidenceId],
      reviewers: [raw.reviewer],
      rawFindingIds: [raw.rawFindingId],
      firstSeen: observedAt,
      lastSeen: observedAt,
      revision: 1,
      provisional,
    }],
    rawFindings: [...current.rawFindings, raw],
    rawCanonicalSnapshots: [...current.rawCanonicalSnapshots, snapshot],
    evidenceRecords: [...current.evidenceRecords, proof],
  } as FindingLedger);
  await store.updateLedger(() => ({ ledger, result: undefined }));
}

describe('E2E: Finding Contract legacy provisional migration (mock)', () => {
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
    updateIsolatedConfig(isolatedEnv.taktDir, {
      finding_contract: {
        intake_normalize: {
          provider: 'mock',
          model: 'mock-model',
        },
      },
    });
  });

  afterEach(() => {
    cleanupTestFindingStorage();
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should migrate the inherited legacy provisional and complete via promotion when the first manager round runs on the inherited ledger', async () => {
    const bootstrap = runTakt({
      args: ['--provider', 'mock', '--task', 'Handle the inherited legacy holding.', '--workflow', workflowPath],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/finding-contract-restatement-bootstrap.json'),
      },
      timeout: 120_000,
    });
    expect(bootstrap.exitCode).not.toBe(0);
    const sourceRunSlug = singleRunSlug(repo.path);
    await seedLegacyProvisional(repo.path, sourceRunSlug);

    const resumed = runTakt({
      args: ['resume'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/finding-contract-legacy-migration-complete.json'),
      },
      timeout: 120_000,
    });

    expect(resumed.exitCode).toBe(0);
    const resumedRunSlug = readdirSync(join(repo.path, '.takt', 'runs'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((runSlug) => runSlug !== sourceRunSlug)[0];
    expect(resumedRunSlug).toBeDefined();
    expect(resumed.stdout).toContain('Provider: mock');
    expect(resumed.stdout).not.toContain('Provider: claude');
    expect(resumed.stdout).toContain('Workflow completed');

    const reportDir = join(repo.path, '.takt', 'runs', resumedRunSlug!, 'reports');
    const store = createTestFindingLedgerStore({
      projectCwd: repo.path,
      runId: resumedRunSlug!,
      reportDir,
      workflowName: 'e2e-finding-contract-restatement',
    });
    const ledger = store.loadLedger();
    // 移行: marker は lifecycle event として記録され、旧 holding は open 集計から外れる。
    const legacyFinding = ledger.findings.find(({ id }) => id === 'F-0001');
    expect(legacyFinding?.reviewerAnomalyReclassification).toMatchObject({
      kind: 'reclassified_to_reviewer_anomaly',
      reason: 'product_claim_not_adjudicated',
    });
    expect(ledger.lifecycleEvents.some(
      (event) => event.operation === 'reclassify_provisional',
    )).toBe(true);
    // 移行で生まれた anomaly は restatement round の clean claim で promotion される。
    const anomaly = ledger.reviewerAnomalies?.find(
      (entry) => entry.kind === 'intake-contract-incomplete',
    );
    expect(anomaly?.promotedFindingId).toBeDefined();
    const promoted = ledger.findings.find(({ id }) => id === anomaly?.promotedFindingId);
    expect(promoted?.status).toBe('open');
    expect(promoted?.provisional).toBeUndefined();
  }, 120_000);
});
