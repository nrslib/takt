import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, isGitHubE2EAvailable, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const requiresGitHub = isGitHubE2EAvailable();

// E2E更新時は docs/testing/e2e.md も更新すること
describe.skipIf(!requiresGitHub)('E2E: Task run auto PR (takt run -> postExecutionFlow)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo({ skipBranch: true });
  });

  afterEach(() => {
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

  it('should create a PR after running a worktree task with auto_pr', () => {
    const workflowPath = resolve(__dirname, '../fixtures/workflows/simple.yaml');
    const branchName = `e2e-task-auto-pr-${Date.now()}`;
    const now = new Date().toISOString();

    mkdirSync(join(testRepo.path, '.takt'), { recursive: true });
    writeFileSync(
      join(testRepo.path, '.takt', 'tasks.yaml'),
      [
        'tasks:',
        '  - name: e2e-task-auto-pr',
        '    status: pending',
        '    content: "Create a file called task-auto-pr.txt with the content \\"Task auto PR E2E\\""',
        `    workflow: "${workflowPath}"`,
        '    worktree: true',
        '    auto_pr: true',
        `    branch: "${branchName}"`,
        `    created_at: "${now}"`,
        '    started_at: null',
        '    completed_at: null',
      ].join('\n'),
      'utf-8',
    );

    const result = runTakt({
      args: ['run'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PR created');

    const prUrl = execFileSync(
      'gh',
      ['pr', 'list', '--head', branchName, '--state', 'open', '--repo', testRepo.repoName, '--json', 'url', '--jq', '.[0].url'],
      { cwd: testRepo.path, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    expect(prUrl).toBeTruthy();
  }, 240_000);
});
