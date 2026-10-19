import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cleanupOrphanedClone, resolveCloneBaseDir } from '../../../infra/task/index.js';
import { TaskStore } from '../../../infra/task/store.js';
import { getCloneMetaPath } from '../../../infra/task/clone-meta.js';
import { encodeWorktreePath } from '../../../infra/config/project/sessionStore.js';
import { info, success, error as logError, warn } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage, isPathInside, isRealPathInside } from '../../../shared/utils/index.js';
import { lstatOrUndefined } from '../../../shared/utils/private-path-identity.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import {
  type BranchActionTarget,
  ensureRootBranchReady,
  resolveTargetBranch,
  resolveTargetWorktreePath,
} from './taskActionTarget.js';

const log = createLogger('list-tasks');

function getGitCommandErrorDetail(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr)) {
      const text = stderr.toString('utf-8').trim();
      if (text) {
        return text;
      }
    }
  }

  return getErrorMessage(err);
}

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
  if (!ensureRootBranchReady(projectDir, target, 'try merge')) {
    return false;
  }

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
    const msg = getGitCommandErrorDetail(err);
    logError(`Squash merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Try-merge (squash) failed', { branch, error: msg });
    return false;
  }
}

export function mergeBranch(projectDir: string, target: BranchActionTarget): boolean {
  if (!ensureRootBranchReady(projectDir, target, 'merge')) {
    return false;
  }

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
    const msg = getGitCommandErrorDetail(err);
    logError(`Merge failed: ${msg}`);
    logError('You may need to resolve conflicts manually.');
    log.error('Merge & cleanup failed', { branch, error: msg });
    return false;
  }
}

export interface DeleteBranchOptions { quiet?: boolean; resume?: boolean; requireCleanupSuccess?: boolean }

function assertUntrackedCloneResource(projectDir: string, filePath: string): void {
  const resourcePath = relative(projectDir, filePath);
  const indexed = execFileSync('git', ['ls-files', '--cached', '--', resourcePath], {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
  if (indexed) throw new Error(`Clone resource is tracked in the Git index: ${resourcePath}`);
  // HEAD still identifies repository-supplied records after a staged deletion.
  const committed = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', resourcePath], {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
  if (committed) throw new Error(`Clone resource is tracked in HEAD: ${resourcePath}`);
}

function inspectCloneOwnership(projectDir: string, worktreePath: string, branch: string): {
  exists: boolean;
  metaExists: boolean;
  worktreeBaseDirectory?: string;
} {
  assertUntrackedCloneResource(projectDir, new TaskStore(projectDir).getTasksFilePath());
  const exists = lstatOrUndefined(worktreePath) !== undefined;
  const metaPath = getCloneMetaPath(projectDir, branch);
  const metaStat = lstatOrUndefined(metaPath);
  if (metaStat === undefined) {
    if (exists) throw new Error('Clone ownership metadata is missing');
    return { exists: false, metaExists: false };
  }
  if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
    throw new Error('Clone ownership metadata is not a regular file');
  }
  assertUntrackedCloneResource(projectDir, metaPath);
  const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf-8'));
  if (typeof meta !== 'object' || meta === null
    || !('branch' in meta) || meta.branch !== branch
    || !('clonePath' in meta) || typeof meta.clonePath !== 'string' || !meta.clonePath
    || resolve(meta.clonePath) !== worktreePath) {
    throw new Error('Clone ownership metadata does not match the task');
  }
  if (exists) assertReusableWorktreePath(projectDir, worktreePath);
  const worktreeBaseDirectory = [resolveCloneBaseDir(projectDir), join(projectDir, '.takt', 'worktrees')]
    .find((root) => (isPathInside(root, worktreePath) || isRealPathInside(root, worktreePath))
      && !isRealPathInside(worktreePath, root));
  if (worktreeBaseDirectory === undefined) {
    throw new Error('Clone path is outside the clone base directory or is the base itself');
  }
  if (exists) {
    const stat = lstatOrUndefined(join(worktreePath, '.git'));
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Clone does not have an independent .git directory');
    }
  }
  return { exists, metaExists: true, worktreeBaseDirectory };
}

export function deleteBranch(projectDir: string, target: BranchActionTarget, options?: DeleteBranchOptions): boolean {
  const branch = resolveTargetBranch(target);
  const worktreePath = resolveTargetWorktreePath(target);
  const cleanupOptions: [] | [{ throwOnError: true }] = options?.requireCleanupSuccess === true ? [{ throwOnError: true }] : [];

  try {
    if (worktreePath) {
      const clonePath = resolve(worktreePath);
      let ownership: ReturnType<typeof inspectCloneOwnership>;
      try {
        ownership = inspectCloneOwnership(projectDir, clonePath, branch);
      } catch (err) {
        if (options?.quiet !== true) warn(`Could not verify clone ownership for ${branch}. Task resources and record are retained.`);
        log.error('Could not verify clone ownership', { branch, worktreePath, reason: getErrorMessage(err) });
        return false;
      }
      if (ownership.exists) {
        rmSync(clonePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        log.info('Removed worktree directory', { worktreePath });
      }

      const encodedPath = encodeWorktreePath(worktreePath);
      const sessionFile = join(projectDir, '.takt', 'worktree-sessions', `${encodedPath}.json`);
      if (options?.resume === true ? lstatOrUndefined(sessionFile) !== undefined : existsSync(sessionFile)) {
        unlinkSync(sessionFile);
        log.info('Removed worktree-session file', { sessionFile });
      }

      if (ownership.metaExists) {
        cleanupOrphanedClone(projectDir, branch, {
          worktreeBaseDirectory: ownership.worktreeBaseDirectory,
          ...(options?.requireCleanupSuccess === true ? { throwOnError: true } : {}),
        });
      }
      const branchExists = execFileSync('git', [
        'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`,
      ], { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' }).split('\n').includes(`refs/heads/${branch}`);
      if (branchExists) {
        try {
          execFileSync('git', ['branch', '-d', branch], {
            cwd: projectDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          });
        } catch (err) {
          if (options?.quiet !== true) warn(`Could not delete branch ${branch}. You may delete it manually.`);
          log.error('Failed to delete clone task branch', {
            branch,
            error: getErrorMessage(err),
          });
        }
      }
      if (options?.quiet !== true) success(`Deleted worktree ${branch}`);
      log.info('Worktree branch deleted', { branch, worktreePath });
      return true;
    }

    if ('kind' in target && target.data?.worktree) {
      if (options?.quiet !== true) warn(`Could not verify clone ownership for ${branch} without a worktree path. The branch is retained; you may delete it manually.`);
      log.error('Could not verify clone task branch', { branch, reason: 'Worktree path is not recorded' });
      return true;
    }

    const branchExists = options?.resume !== true || execFileSync('git', [
      'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`,
    ], { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' }).split('\n').includes(`refs/heads/${branch}`);
    if (branchExists) {
      execFileSync('git', ['branch', '-D', branch], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }

    if (options?.resume !== true || lstatOrUndefined(getCloneMetaPath(projectDir, branch)) !== undefined) {
      cleanupOrphanedClone(projectDir, branch, ...cleanupOptions);
    }

    if (options?.quiet !== true) success(`Deleted ${branch}`);
    log.info('Branch deleted', { branch });
    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (options?.quiet !== true) logError(`Delete failed: ${msg}`);
    log.error('Delete failed', { branch, error: msg });
    return false;
  }
}
