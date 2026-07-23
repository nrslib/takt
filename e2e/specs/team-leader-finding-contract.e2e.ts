import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';
import { readSessionRecords } from '../helpers/session-log';
import { runTakt } from '../helpers/takt-runner';

const __dirname = dirname(fileURLToPath(import.meta.url));

function seedFindingLedger(repoPath: string): void {
  const findingDirectory = join(repoPath, '.takt', 'findings');
  mkdirSync(join(findingDirectory, 'raw'), { recursive: true });
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'target.ts'), 'export const target = false;\n', 'utf-8');
  writeFileSync(join(findingDirectory, 'peer-review.json'), JSON.stringify({
    version: 1,
    workflowName: 'e2e-team-leader-finding-contract-fix',
    nextId: 2,
    updatedAt: '2026-07-23T00:00:00.000Z',
    rawFindings: [{
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'test-reviewer',
      familyTag: 'correctness',
      severity: 'high',
      title: 'Target remains false',
      location: 'src/target.ts:1',
      description: 'The target value must be repaired.',
      suggestion: 'Set the target to the required value.',
      relation: 'new',
    }],
    conflicts: [],
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Target remains false',
      location: 'src/target.ts:1',
      description: 'The target value must be repaired.',
      suggestion: 'Set the target to the required value.',
      reviewers: ['test-reviewer'],
      rawFindingIds: ['raw-1'],
      firstSeen: { runId: 'seed', stepName: 'reviewers', timestamp: '2026-07-23T00:00:00.000Z' },
      lastSeen: { runId: 'seed', stepName: 'reviewers', timestamp: '2026-07-23T00:00:00.000Z' },
    }],
  }, null, 2), 'utf-8');
}

describe('E2E: Finding Contract Team Leader routing', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let workflowPath: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    delete isolatedEnv.env.CLAUDECODE;
    repo = createLocalRepo();
    seedFindingLedger(repo.path);
    workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/team-leader-finding-contract-fix.yaml'),
    );
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it.each([
    { scenario: 'team-leader-finding-contract-complete.json', expectedStep: 'reviewers' },
    { scenario: 'team-leader-finding-contract-replan.json', expectedStep: 'replan' },
  ])('routes an explicit decision to $expectedStep', ({ scenario, expectedStep }) => {
    const result = runTakt({
      args: ['--provider', 'mock', '--task', 'Repair the seeded finding.', '--workflow', workflowPath],
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
    const records = readSessionRecords(repo.path);
    const fix = records.find((record) => record.type === 'step_complete' && record.step === 'fix');
    expect(fix?.matchedRuleIndex).toBe(expectedStep === 'reviewers' ? 0 : 1);
    expect(records.some((record) => record.type === 'step_complete' && record.step === expectedStep)).toBe(true);
  }, 120_000);
});
