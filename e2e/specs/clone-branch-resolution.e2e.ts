import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, isGitHubE2EAvailable, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MOCK_PIECE_PATH = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
const MOCK_SCENARIO_PATH = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

function writeTaskYaml(
  repoPath: string,
  task: { name: string; content: string; branch: string; baseBranch: string },
): void {
  const taktDir = join(repoPath, '.takt');
  mkdirSync(taktDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(taktDir, 'tasks.yaml'),
    [
      'tasks:',
      `  - name: ${task.name}`,
      '    status: pending',
      `    content: "${task.content}"`,
      `    piece: "${MOCK_PIECE_PATH}"`,
      `    branch: "${task.branch}"`,
      `    base_branch: "${task.baseBranch}"`,
      '    worktree: true',
      `    created_at: "${now}"`,
      '    started_at: null',
      '    completed_at: null',
    ].join('\n'),
    'utf-8',
  );
}

function getDefaultBranch(repoPath: string): string {
  // Use `git rev-parse --abbrev-ref origin/HEAD` first, fall back to
  // listing remote HEAD via `git remote show origin` for environments
  // where origin/HEAD symbolic ref is not set (e.g., bare-clone in CI).
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
    }).trim().replace('origin/', '');
    if (ref) return ref;
  } catch {
    // symbolic-ref not available — fall back
  }
  // Fallback: the initial branch of the repo (works for bare-clone setups)
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
  }).trim();
}

/**
 * E2E: Clone branch resolution — verifies that `takt run` correctly handles:
 *   1. Remote-only branches (e.g., PR head branches not checked out locally)
 *   2. Non-existent branches (should create from baseBranch)
 *
 * Regression test for: "Base branch does not exist: main" when running `takt --pr`
 */
// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Clone branch resolution (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo({ skipBranch: true });
  });

  afterEach(() => {
    try { testRepo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should clone with remote-only branch (PR scenario)', () => {
    // Get default branch BEFORE switching away, so fallback rev-parse returns the correct branch
    const defaultBranch = getDefaultBranch(testRepo.path);
    const remoteBranch = `takt/e2e-remote-only-${Date.now()}`;
    execFileSync('git', ['checkout', '-b', remoteBranch], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'remote-only.txt'), 'remote content\n');
    execFileSync('git', ['add', '.'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'remote-only commit'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', remoteBranch], { cwd: testRepo.path, stdio: 'pipe' });

    execFileSync('git', ['checkout', defaultBranch], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['branch', '-D', remoteBranch], { cwd: testRepo.path, stdio: 'pipe' });

    writeTaskYaml(testRepo.path, {
      name: 'remote-branch-test',
      content: 'Test remote-only branch clone',
      branch: remoteBranch,
      baseBranch: defaultBranch,
    });

    const result = runTakt({
      args: ['run'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: MOCK_SCENARIO_PATH },
      timeout: 240_000,
    });

    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('Base branch does not exist');
    expect(result.exitCode).toBe(0);
  }, 240_000);

  it('should create new branch from baseBranch when branch does not exist anywhere', () => {
    const newBranch = `takt/e2e-new-branch-${Date.now()}`;
    const defaultBranch = getDefaultBranch(testRepo.path);

    writeTaskYaml(testRepo.path, {
      name: 'new-branch-test',
      content: 'Test new branch creation from baseBranch',
      branch: newBranch,
      baseBranch: defaultBranch,
    });

    const result = runTakt({
      args: ['run'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: MOCK_SCENARIO_PATH },
      timeout: 240_000,
    });

    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('Base branch does not exist');
    expect(result.exitCode).toBe(0);
  }, 240_000);
});

const canUseGitHub = isGitHubE2EAvailable();

/**
 * E2E: Clone branch resolution with real GitHub PR.
 *
 * Creates a PR on nrslib/takt-testing, then verifies that `takt run`
 * can clone a remote-only PR branch with `worktree: true`.
 */
describe.skipIf(!canUseGitHub)('E2E: Clone branch resolution (GitHub PR)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;
  let prBranch: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo({ skipBranch: true });

    // Create a branch, push it, and open a PR
    prBranch = `takt/e2e-pr-clone-${Date.now()}`;
    execFileSync('git', ['checkout', '-b', prBranch], { cwd: testRepo.path, stdio: 'pipe' });
    writeFileSync(join(testRepo.path, 'pr-test.txt'), `PR clone test ${Date.now()}\n`);
    execFileSync('git', ['add', '.'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'e2e: PR clone test'], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', prBranch], { cwd: testRepo.path, stdio: 'pipe' });

    execFileSync('gh', [
      'pr', 'create',
      '--repo', testRepo.repoName,
      '--head', prBranch,
      '--title', `[E2E] Clone branch resolution ${Date.now()}`,
      '--body', 'Automated E2E test PR — will be closed automatically.',
    ], { cwd: testRepo.path, stdio: 'pipe' });

    // Delete local branch so it only exists on remote (simulates --pr scenario)
    const defaultBranch = getDefaultBranch(testRepo.path);
    execFileSync('git', ['checkout', defaultBranch], { cwd: testRepo.path, stdio: 'pipe' });
    execFileSync('git', ['branch', '-D', prBranch], { cwd: testRepo.path, stdio: 'pipe' });
  });

  afterEach(() => {
    // Close PR and delete remote branch
    try {
      const prNumbers = execFileSync('gh', [
        'pr', 'list', '--head', prBranch, '--repo', testRepo.repoName,
        '--json', 'number', '--jq', '.[].number',
      ], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      for (const num of prNumbers.split('\n').filter(Boolean)) {
        execFileSync('gh', ['pr', 'close', num, '--repo', testRepo.repoName, '--delete-branch'], { stdio: 'pipe' });
      }
    } catch { /* best-effort */ }
    try { testRepo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should clone remote-only PR branch with worktree', () => {
    const defaultBranch = getDefaultBranch(testRepo.path);

    writeTaskYaml(testRepo.path, {
      name: 'pr-clone-test',
      content: 'Test cloning a remote-only PR branch',
      branch: prBranch,
      baseBranch: defaultBranch,
    });

    const result = runTakt({
      args: ['run'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: MOCK_SCENARIO_PATH },
      timeout: 240_000,
    });

    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('Base branch does not exist');
    expect(combined).not.toContain('Remote branch');
    expect(combined).not.toContain('unable to read tree');
    expect(result.exitCode).toBe(0);
  }, 240_000);
});
