/**
 * Auto-commit and push for clone tasks
 *
 * After a successful workflow completion in a shared clone,
 * automatically stages all changes, creates a commit, and
 * pushes to origin so the branch is reflected in the main repo.
 * No co-author trailer is added.
 */

import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { stageAndCommit } from './git.js';

const log = createLogger('autoCommit');

export interface AutoCommitResult {
  /** Whether the commit was created successfully */
  success: boolean;
  /** The short commit hash (if committed) */
  commitHash?: string;
  /** Human-readable message */
  message: string;
}

/**
 * Auto-commit all changes and push to origin.
 *
 * Steps:
 * 1. Stage all changes (git add -A)
 * 2. Check if there are staged changes (git status --porcelain)
 * 3. If changes exist, create a commit with "takt: {taskName}"
 * 4. Push to origin (git push origin HEAD)
 *
 * @param cloneCwd - The clone directory
 * @param taskName - Task name used in commit message
 * @param projectDir - The main project directory (push target)
 */
export function autoCommitAndPush(cloneCwd: string, taskName: string, projectDir: string): AutoCommitResult {
  log.info('Auto-commit starting', { cwd: cloneCwd, taskName });

  try {
    const commitMessage = `takt: ${taskName}`;
    const commitHash = stageAndCommit(cloneCwd, commitMessage);

    if (!commitHash) {
      log.info('No changes to commit');
      return { success: true, message: 'No changes to commit' };
    }

    log.info('Auto-commit created', { commitHash, message: commitMessage });

    // Push directly to the main repo (origin was removed to isolate the clone)
    execFileSync('git', ['push', projectDir, 'HEAD'], {
      cwd: cloneCwd,
      stdio: 'pipe',
    });

    log.info('Pushed to main repo', { projectDir });

    return {
      success: true,
      commitHash,
      message: `Committed & pushed: ${commitHash} - ${commitMessage}`,
    };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('Auto-commit failed', { error: errorMessage });

    return {
      success: false,
      message: `Auto-commit failed: ${errorMessage}`,
    };
  }
}
