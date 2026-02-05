import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export interface TestRepo {
  path: string;
  repoName: string;
  branch: string;
  cleanup: () => void;
}

function getGitHubUser(): string {
  const user = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf-8',
  }).trim();

  if (!user) {
    throw new Error(
      'Failed to get GitHub user. Make sure `gh` CLI is authenticated.',
    );
  }

  return user;
}

/**
 * Clone the takt-testing repository and create a test branch.
 *
 * Cleanup order (important):
 *   1. Delete remote branch (requires local directory to exist)
 *   2. Close any PRs created during the test
 *   3. Delete local directory
 */
export function createTestRepo(): TestRepo {
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

  // Create test branch
  const testBranch = `e2e-test-${Date.now()}`;
  execFileSync('git', ['checkout', '-b', testBranch], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  return {
    path: repoPath,
    repoName,
    branch: testBranch,
    cleanup: () => {
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

      // 3. Delete local directory last
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
