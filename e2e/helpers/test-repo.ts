import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export interface LocalRepo {
  path: string;
  cleanup: () => void;
}

export interface TestRepo {
  path: string;
  repoName: string;
  branch: string;
  cleanup: () => void;
}

/**
 * Create a local git repository in a temporary directory.
 * Use this for tests that don't need a remote (GitHub) repository.
 */
export function createLocalRepo(): LocalRepo {
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return {
    path: repoPath,
    cleanup: () => {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

export interface CreateTestRepoOptions {
  /** Skip creating a test branch (stay on default branch). Use for pipeline tests. */
  skipBranch?: boolean;
}

function getGitHubUser(): string {
  const user = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  if (!user) {
    throw new Error(
      'Failed to get GitHub user. Make sure `gh` CLI is authenticated.',
    );
  }

  return user;
}

function canUseGitHubRepo(): boolean {
  try {
    const user = getGitHubUser();
    const repoName = `${user}/takt-testing`;
    execFileSync('gh', ['repo', 'view', repoName], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function isGitHubE2EAvailable(): boolean {
  return canUseGitHubRepo();
}

function createOfflineTestRepo(options?: CreateTestRepoOptions): TestRepo {
  const sandboxPath = mkdtempSync(join(tmpdir(), 'takt-e2e-repo-'));
  const originPath = join(sandboxPath, 'origin.git');
  const repoPath = join(sandboxPath, 'work');

  execFileSync('git', ['init', '--bare', originPath], { stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, repoPath], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: repoPath, stdio: 'pipe' });

  const testBranch = options?.skipBranch ? undefined : `e2e-test-${Date.now()}`;
  if (testBranch) {
    execFileSync('git', ['checkout', '-b', testBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  }

  const currentBranch = testBranch
    ?? execFileSync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();

  return {
    path: repoPath,
    repoName: 'local/takt-testing',
    branch: currentBranch,
    cleanup: () => {
      try {
        rmSync(sandboxPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

/**
 * Clone the takt-testing repository and create a test branch.
 *
 * Cleanup order (important):
 *   1. Delete remote branch (requires local directory to exist)
 *   2. Close any PRs created during the test
 *   3. Delete local directory
 */
export function createTestRepo(options?: CreateTestRepoOptions): TestRepo {
  if (!canUseGitHubRepo()) {
    return createOfflineTestRepo(options);
  }

  const user = getGitHubUser();
  const repoName = `${user}/takt-testing`;

  // Verify repository exists
  try {
    execFileSync('gh', ['repo', 'view', repoName], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Repository "${repoName}" not found. Please create it first:\n` +
        `  gh repo create takt-testing --private --add-readme`,
    );
  }

  // Clone to temporary directory
  const repoPath = mkdtempSync(join(tmpdir(), 'takt-e2e-repo-'));
  execFileSync('gh', ['repo', 'clone', repoName, repoPath], {
    stdio: 'pipe',
  });

  // Create test branch (unless skipped for pipeline tests)
  const testBranch = options?.skipBranch
    ? undefined
    : `e2e-test-${Date.now()}`;
  if (testBranch) {
    execFileSync('git', ['checkout', '-b', testBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  }

  const currentBranch = testBranch
    ?? execFileSync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();

  return {
    path: repoPath,
    repoName,
    branch: currentBranch,
    cleanup: () => {
      if (testBranch) {
        // 1. Delete remote branch (best-effort)
        try {
          execFileSync(
            'git',
            ['push', 'origin', '--delete', testBranch],
            { cwd: repoPath, stdio: 'pipe' },
          );
        } catch {
          // Branch may not have been pushed; ignore
        }

        // 2. Close any PRs from this branch (best-effort)
        try {
          const prList = execFileSync(
            'gh',
            ['pr', 'list', '--head', testBranch, '--repo', repoName, '--json', 'number', '--jq', '.[].number'],
            { encoding: 'utf-8', stdio: 'pipe' },
          ).trim();

          for (const prNumber of prList.split('\n').filter(Boolean)) {
            execFileSync(
              'gh',
              ['pr', 'close', prNumber, '--repo', repoName, '--delete-branch'],
              { stdio: 'pipe' },
            );
          }
        } catch {
          // No PRs or already closed; ignore
        }
      } else {
        // Pipeline mode: clean up takt-created PRs (best-effort)
        try {
          const prNumbers = execFileSync(
            'gh',
            ['pr', 'list', '--state', 'open', '--repo', repoName, '--json', 'number', '--jq', '.[].number'],
            { encoding: 'utf-8', stdio: 'pipe' },
          ).trim();

          for (const prNumber of prNumbers.split('\n').filter(Boolean)) {
            execFileSync(
              'gh',
              ['pr', 'close', prNumber, '--repo', repoName, '--delete-branch'],
              { stdio: 'pipe' },
            );
          }
        } catch {
          // ignore
        }
      }

      // Delete local directory last
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
