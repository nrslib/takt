/**
 * Auto-commit and push for clone tasks
 *
 * After a successful workflow completion in a shared clone,
 * automatically stages all changes, creates a commit, and
 * pushes to origin so the branch is reflected in the main repo.
 * No co-author trailer is added.
 */

import { execFileSync } from 'node:child_process';
import { resolveConfigValue } from '../config/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { materializeCloneHeadToRootBranch, stageAndCommit } from './git.js';

const log = createLogger('autoCommit');
const AUTO_COMMIT_PUSH_FAILURE_MESSAGE = 'Push to main repo failed after commit creation.';
const AUTO_COMMIT_FAILURE_MESSAGE = 'Auto-commit failed.';

export interface AutoCommitResult {
  /** Whether the commit was created successfully */
  success: boolean;
  /** The short commit hash (if committed) */
  commitHash?: string;
  /** Whether the local push back to the main repo failed after commit creation */
  localPushFailed?: boolean;
  /** Human-readable message */
  message: string;
}

/**
 * Handles auto-commit and push operations for clone tasks.
 */
export class AutoCommitter {
  /**
   * Auto-commit all changes and push to the main project.
   *
   * Steps:
   * 1. Stage all changes (git add -A)
   * 2. Check if there are staged changes
   * 3. If changes exist, create a commit with "takt: {taskName}"
   * 4. Push to the main project directory
   */
  commitAndPush(cloneCwd: string, taskName: string, projectDir: string, branch?: string): AutoCommitResult {
    log.info('Auto-commit starting', { cwd: cloneCwd, taskName });

    try {
      const commitMessage = `takt: ${taskName}`;
      const commitHash = stageAndCommit(cloneCwd, commitMessage, {
        allowGitHooks: resolveConfigValue(projectDir, 'allowGitHooks') ?? false,
        allowGitFilters: resolveConfigValue(projectDir, 'allowGitFilters') ?? false,
      });

      if (!commitHash) {
        log.info('No changes to commit');
        return { success: true, message: 'No changes to commit' };
      }

      log.info('Auto-commit created', { commitHash, message: commitMessage });

      try {
        if (branch !== undefined) {
          materializeCloneHeadToRootBranch(cloneCwd, projectDir, branch);
          log.info('Materialized clone HEAD to root branch', { projectDir, branch });
        } else {
          execFileSync('git', ['push', projectDir, 'HEAD'], {
            cwd: cloneCwd,
            stdio: 'pipe',
          });
          log.info('Pushed to main repo', { projectDir });
        }
      } catch (pushError) {
        log.info('Push to main repo failed after commit creation', {
          projectDir,
          outcome: AUTO_COMMIT_PUSH_FAILURE_MESSAGE,
          error: getErrorMessage(pushError),
        });

        return {
          success: true,
          commitHash,
          localPushFailed: true,
          message: `Committed: ${commitHash} - ${commitMessage}`,
        };
      }

      return {
        success: true,
        commitHash,
        message: `Committed: ${commitHash} - ${commitMessage}`,
      };
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      log.error('Auto-commit failed', { outcome: AUTO_COMMIT_FAILURE_MESSAGE });

      return {
        success: false,
        message: `Auto-commit failed: ${errorMessage}`,
      };
    }
  }
}

// ---- Module-level function ----

const defaultCommitter = new AutoCommitter();

export function autoCommitAndPush(cloneCwd: string, taskName: string, projectDir: string, branch?: string): AutoCommitResult {
  return defaultCommitter.commitAndPush(cloneCwd, taskName, projectDir, branch);
}
