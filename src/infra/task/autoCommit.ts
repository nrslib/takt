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
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import {
  materializeCloneHeadToRootBranch,
  stageAndCommit,
  type StageAndCommitOptions,
} from './git.js';

const log = createLogger('autoCommit');
const AUTO_COMMIT_PUSH_FAILURE_MESSAGE = 'Push to main repo failed after commit creation.';
const AUTO_COMMIT_FAILURE_MESSAGE = 'Auto-commit failed.';

export interface AutoCommitResult {
  /** Whether auto-commit processing succeeded (check localPushFailed for publication) */
  success: boolean;
  /** The short commit hash (if committed) */
  commitHash?: string;
  /** The full HEAD SHA published to the main repo by this call */
  publishedHead?: string;
  /** Whether publication back to the main repo failed */
  localPushFailed?: boolean;
  /** Human-readable message */
  message: string;
}

function needsHeadPublication(cloneCwd: string, projectDir: string, head: string, branch: string | undefined): boolean {
  const targetBranch = branch ?? execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: cloneCwd, encoding: 'utf-8', stdio: 'pipe',
  }).trim();
  const targetRef = toLocalBranchRef(targetBranch);
  const objectType = execFileSync('git', ['cat-file', '--batch-check=%(objecttype)'], {
    cwd: projectDir, input: `${head}\n`, encoding: 'utf-8', stdio: 'pipe',
  }).trim();
  if (objectType === `${head} missing`) return true;
  if (objectType !== 'commit') throw new Error(`Cannot resolve clone HEAD ${head} in the main repo`);

  const targetRefs = execFileSync('git', ['for-each-ref', '--format=%(refname)', targetRef], {
    cwd: projectDir, encoding: 'utf-8', stdio: 'pipe',
  }).trim().split('\n');
  // A new result branch at the unchanged starting position does not need publication.
  const publishedRefs = targetRefs.includes(targetRef) ? [targetRef] : ['HEAD', '--branches', '--remotes'];
  const unpublished = execFileSync('git', ['rev-list', '--max-count=1', head, '--not', ...publishedRefs], {
    cwd: projectDir, encoding: 'utf-8', stdio: 'pipe',
  }).trim();
  return unpublished.length > 0;
}

export function resolveAutoCommitOptions(projectDir: string): StageAndCommitOptions {
  return {
    allowGitHooks: resolveConfigValue(projectDir, 'allowGitHooks') ?? false,
    allowGitFilters: resolveConfigValue(projectDir, 'allowGitFilters') ?? false,
  };
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
  async commitAndPush(
    cloneCwd: string,
    taskName: string,
    projectDir: string,
    branch?: string,
  ): Promise<AutoCommitResult> {
    log.info('Auto-commit starting', { cwd: cloneCwd, taskName });

    try {
      const commitMessage = `takt: ${taskName}`;
      const commitHash = await stageAndCommit(
        cloneCwd,
        commitMessage,
        resolveAutoCommitOptions(projectDir),
      );

      if (commitHash) {
        log.info('Auto-commit created', { commitHash, message: commitMessage });
      }
      const message = commitHash ? `Committed: ${commitHash} - ${commitMessage}` : 'No changes to commit';
      let head: string;

      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: cloneCwd, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        if (!needsHeadPublication(cloneCwd, projectDir, head, branch)) {
          return { success: true, commitHash, message };
        }
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
          message,
        };
      }

      return {
        success: true,
        commitHash,
        publishedHead: head,
        message: commitHash ? message : `Published: ${head}`,
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

export function autoCommitAndPush(
  cloneCwd: string,
  taskName: string,
  projectDir: string,
  branch?: string,
): Promise<AutoCommitResult> {
  return defaultCommitter.commitAndPush(cloneCwd, taskName, projectDir, branch);
}
