/**
 * Shared git operations for task execution
 */

import { execFileSync } from 'node:child_process';

/**
 * Stage all changes and create a commit.
 * Returns the short commit hash if changes were committed, undefined if no changes.
 *
 * Note: .takt/reports/ is force-added because .takt/ is gitignored.
 * When using worktree mode, reports are generated inside the clone's .takt/reports/
 * and must be included in the commit.
 */
export function stageAndCommit(cwd: string, message: string): string | undefined {
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });

  // Force-add .takt/reports/ even though .takt/ is gitignored.
  // This ensures worktree-generated reports are included in the commit.
  try {
    execFileSync('git', ['add', '-f', '.takt/reports/'], { cwd, stdio: 'pipe' });
  } catch {
    // Ignore errors if .takt/reports/ doesn't exist
  }

  const statusOutput = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (!statusOutput.trim()) {
    return undefined;
  }

  execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'pipe' });

  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}
