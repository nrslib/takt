/**
 * Shared git operations for task execution
 */

import { execFileSync } from 'node:child_process';

/**
 * Stage all changes and create a commit.
 * Returns the short commit hash if changes were committed, undefined if no changes.
 */
export function stageAndCommit(cwd: string, message: string): string | undefined {
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });

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
