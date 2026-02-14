import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupOrphanedClone } from '../../../infra/task/index.js';
import { encodeWorktreePath } from '../../../infra/config/project/sessionStore.js';
import { info, success, error as logError, warn } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { type BranchActionTarget, resolveTargetBranch, resolveTargetWorktreePath } from './taskActionTarget.js';

const log = createLogger('list-tasks');

export function isBranchMerged(projectDir: string, branch: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.error) {
    log.error('Failed to check if branch is merged', {
      branch,
      error: getErrorMessage(result.error),
    });
    return false;
  }

  return result.status === 0;
}

export function tryMergeBranch(projectDir: string, target: BranchActionTarget): boolean {
  const branch = resolveTargetBranch(target);

  try {
    execFileSync('git', ['merge', '--squash', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    success(`Squash-merged ${branch} (changes staged, not committed)`);
    info('Run `git status` to see staged changes, `git commit` to finalize, or `git reset` to undo.');
    log.info('Try-merge (squash) completed', { branch });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Squash merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Try-merge (squash) failed', { branch, error: msg });
    return false;
  }
}

export function mergeBranch(projectDir: string, target: BranchActionTarget): boolean {
  const branch = resolveTargetBranch(target);
  const alreadyMerged = isBranchMerged(projectDir, branch);

  try {
    if (alreadyMerged) {
      info(`${branch} is already merged, skipping merge.`);
      log.info('Branch already merged, cleanup only', { branch });
    } else {
      execFileSync('git', ['merge', '--no-edit', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_MERGE_AUTOEDIT: 'no',
        },
      });
    }

    try {
      execFileSync('git', ['branch', '-d', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      warn(`Could not delete branch ${branch}. You may delete it manually.`);
      log.error('Failed to delete merged branch', {
        branch,
        error: getErrorMessage(err),
      });
    }

    cleanupOrphanedClone(projectDir, branch);

    success(`Merged & cleaned up ${branch}`);
    log.info('Branch merged & cleaned up', { branch, alreadyMerged });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Merge & cleanup failed', { branch, error: msg });
    return false;
  }
}

export function deleteBranch(projectDir: string, target: BranchActionTarget): boolean {
  const branch = resolveTargetBranch(target);
  const worktreePath = resolveTargetWorktreePath(target);

  try {
    if (worktreePath) {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        log.info('Removed worktree directory', { worktreePath });
      }

      const encodedPath = encodeWorktreePath(worktreePath);
      const sessionFile = join(projectDir, '.takt', 'worktree-sessions', `${encodedPath}.json`);
      if (existsSync(sessionFile)) {
        unlinkSync(sessionFile);
        log.info('Removed worktree-session file', { sessionFile });
      }

      success(`Deleted worktree ${branch}`);
      log.info('Worktree branch deleted', { branch, worktreePath });
      return true;
    }

    execFileSync('git', ['branch', '-D', branch], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    cleanupOrphanedClone(projectDir, branch);

    success(`Deleted ${branch}`);
    log.info('Branch deleted', { branch });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Delete failed: ${msg}`);
    log.error('Delete failed', { branch, error: msg });
    return false;
  }
}
