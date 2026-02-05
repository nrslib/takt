import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: GitHub Issue processing', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let issueNumber: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();

    // Create a test issue
    const createOutput = execFileSync(
      'gh',
      [
        'issue', 'create',
        '--title', 'E2E Test Issue',
        '--body', 'Create a file called issue-test.txt with the content "Issue resolved"',
        '--repo', testRepo.repoName,
      ],
      { encoding: 'utf-8' },
    );

    // Extract issue number from URL (e.g., https://github.com/user/repo/issues/123)
    const match = createOutput.match(/\/issues\/(\d+)/);
    if (!match?.[1]) {
      throw new Error(`Failed to extract issue number from: ${createOutput}`);
    }
    issueNumber = match[1];
  });

  afterEach(() => {
    // Close test issue (best-effort)
    try {
      execFileSync(
        'gh',
        ['issue', 'close', issueNumber, '--repo', testRepo.repoName],
        { stdio: 'pipe' },
      );
    } catch {
      // ignore
    }

    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should execute pipeline from GitHub issue number', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/simple.yaml');

    const result = runTakt({
      args: [
        '--pipeline',
        '--issue', issueNumber,
        '--piece', piecePath,
        '--auto-pr',
        '--repo', testRepo.repoName,
      ],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    // Pipeline should succeed
    expect(result.exitCode).toBe(0);

    // Verify issue was fetched
    expect(result.stdout).toContain('Issue #');

    // Verify piece completion
    expect(result.stdout).toContain('completed');

    // Verify PR was created
    expect(result.stdout).toContain('PR created');

    // Verify PR exists on GitHub
    const prList = execFileSync(
      'gh',
      ['pr', 'list', '--repo', testRepo.repoName, '--json', 'title', '--jq', '.[].title'],
      { encoding: 'utf-8' },
    ).trim();
    expect(prList).toContain('E2E Test Issue');
  }, 240_000);
});
