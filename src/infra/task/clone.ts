import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger, isRealPathInside } from '../../shared/utils/index.js';
import { resolveConfigValue } from '../config/index.js';
import type { WorktreeOptions, WorktreeResult } from './types.js';
import {
  localBranchExists,
  localBranchExistsAbortable,
  remoteBranchExists,
  remoteBranchExistsAbortable,
  resolveBaseBranch as resolveBaseBranchInternal,
  resolveBaseBranchName as resolveBaseBranchNameInternal,
  resolveBaseBranchAbortable,
} from './clone-base-branch.js';
import {
  cloneAndIsolate,
  cloneAndIsolateAbortable,
  fetchRemoteBranchIntoIsolatedClone,
  fetchRemoteBranchIntoIsolatedCloneAbortable,
  fetchBaseBranchIntoIsolatedClone,
  fetchBaseBranchIntoIsolatedCloneAbortable,
  resolveCloneSubmoduleOptions,
  runGitCommandAbortable,
} from './clone-exec.js';
import { loadCloneMeta, removeCloneMeta as removeCloneMetaFile, saveCloneMeta as saveCloneMetaFile } from './clone-meta.js';
import { syncProjectLocalTaktForRetry } from './projectLocalTaktSync.js';

export type { WorktreeOptions, WorktreeResult };
export {
  branchExists,
  createBaseBranchIfMissing,
  localBranchExists,
  remoteBranchExists,
  type CreateBaseBranchIfMissingConfig,
} from './clone-base-branch.js';

const log = createLogger('clone');

export class CloneManager {
  private static generateTimestamp(): string {
    return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
  }

  static resolveCloneBaseDir(projectDir: string): string {
    const worktreeDir = resolveConfigValue(projectDir, 'worktreeDir');
    if (worktreeDir) {
      return path.isAbsolute(worktreeDir)
        ? worktreeDir
        : path.resolve(projectDir, worktreeDir);
    }
    const defaultDir = path.join(projectDir, '..', 'takt-worktrees');
    if (!CloneManager.isParentWritable(defaultDir)) {
      log.info('Parent directory not writable, using fallback clone base dir', {
        defaultDir,
        fallback: path.join(projectDir, '.takt', 'worktrees'),
      });
      return path.join(projectDir, '.takt', 'worktrees');
    }
    return defaultDir;
  }

  private static isParentWritable(targetDir: string): boolean {
    const parentDir = path.dirname(targetDir);
    try {
      fs.accessSync(parentDir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private static resolveClonePath(projectDir: string, options: WorktreeOptions): string {
    const timestamp = CloneManager.generateTimestamp();
    const slug = options.taskSlug;

    let dirName: string;
    if (options.issueNumber !== undefined && slug) {
      dirName = `${timestamp}-${options.issueNumber}-${slug}`;
    } else if (slug) {
      dirName = `${timestamp}-${slug}`;
    } else {
      dirName = timestamp;
    }

    if (typeof options.worktree === 'string') {
      return path.isAbsolute(options.worktree)
        ? options.worktree
        : path.resolve(projectDir, options.worktree);
    }

    return CloneManager.resolveAvailableClonePath(
      CloneManager.resolveCloneBaseDir(projectDir),
      dirName,
    );
  }

  private static resolveAvailableClonePath(baseDir: string, dirName: string): string {
    const firstCandidate = path.join(baseDir, dirName);
    if (!fs.existsSync(firstCandidate)) {
      return firstCandidate;
    }

    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = path.join(baseDir, `${dirName}-${suffix}`);
      if (!fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(`Unable to allocate clone path in ${baseDir} for ${dirName}`);
  }

  private static resolveBranchName(options: WorktreeOptions): string {
    if (options.branch) {
      return options.branch;
    }

    const slug = options.taskSlug;

    if (options.issueNumber !== undefined && slug) {
      return `takt/${options.issueNumber}/${slug}`;
    }

    const timestamp = CloneManager.generateTimestamp();
    return slug ? `takt/${timestamp}-${slug}` : `takt/${timestamp}`;
  }

  static resolveBaseBranch(
    projectDir: string,
    explicitBaseBranch?: string,
  ): { branch: string; fetchedCommit?: string } {
    return resolveBaseBranchInternal(projectDir, explicitBaseBranch);
  }

  static resolveBaseBranchName(
    projectDir: string,
    explicitBaseBranch?: string,
  ): string {
    return resolveBaseBranchNameInternal(projectDir, explicitBaseBranch);
  }

  createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
    const clonePath = CloneManager.resolveClonePath(projectDir, options);
    const branch = CloneManager.resolveBranchName(options);
    const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);

    log.info(
      `Creating shared clone (${cloneSubmoduleOptions.label}, targets: ${cloneSubmoduleOptions.targets})`,
      { path: clonePath, branch }
    );

    try {
      execFileSync('git', ['fetch', 'origin', branch], {
        cwd: projectDir,
        stdio: 'pipe',
      });
    } catch {
      log.info('Failed to prefetch branch from origin, continuing', {
        branch,
      });
    }

    if (remoteBranchExists(projectDir, branch)) {
      cloneAndIsolate(projectDir, clonePath);
      fetchRemoteBranchIntoIsolatedClone(projectDir, clonePath, branch);
      execFileSync('git', ['checkout', branch], { cwd: clonePath, stdio: 'pipe' });
    } else if (localBranchExists(projectDir, branch)) {
      cloneAndIsolate(projectDir, clonePath, branch);
    } else {
      const { branch: baseBranch, fetchedCommit } = CloneManager.resolveBaseBranch(projectDir, options.baseBranch);
      cloneAndIsolate(projectDir, clonePath, baseBranch);
      if (fetchedCommit) {
        fetchBaseBranchIntoIsolatedClone(projectDir, clonePath, baseBranch);
        execFileSync('git', ['reset', '--hard', fetchedCommit], { cwd: clonePath, stdio: 'pipe' });
      }
      execFileSync('git', ['checkout', '-b', branch], { cwd: clonePath, stdio: 'pipe' });
    }

    syncProjectLocalTaktForRetry(projectDir, clonePath);
    this.saveCloneMeta(projectDir, branch, clonePath);
    log.info('Clone created', { path: clonePath, branch });

    return { path: clonePath, branch };
  }

  async createSharedCloneAbortable(
    projectDir: string,
    options: WorktreeOptions,
    abortSignal?: AbortSignal,
  ): Promise<WorktreeResult> {
    const clonePath = CloneManager.resolveClonePath(projectDir, options);
    const branch = CloneManager.resolveBranchName(options);
    const cloneSubmoduleOptions = resolveCloneSubmoduleOptions(projectDir);

    log.info(
      `Creating shared clone (${cloneSubmoduleOptions.label}, targets: ${cloneSubmoduleOptions.targets})`,
      { path: clonePath, branch },
    );

    try {
      await runGitCommandAbortable(projectDir, ['fetch', 'origin', branch], abortSignal);
    } catch {
      log.info('Failed to prefetch branch from origin, continuing', {
        branch,
      });
    }

    if (await remoteBranchExistsAbortable(projectDir, branch, abortSignal)) {
      await cloneAndIsolateAbortable(projectDir, clonePath, undefined, abortSignal);
      await fetchRemoteBranchIntoIsolatedCloneAbortable(projectDir, clonePath, branch, abortSignal);
      await runGitCommandAbortable(clonePath, ['checkout', branch], abortSignal);
    } else if (await localBranchExistsAbortable(projectDir, branch, abortSignal)) {
      await cloneAndIsolateAbortable(projectDir, clonePath, branch, abortSignal);
    } else {
      const { branch: baseBranch, fetchedCommit } = await resolveBaseBranchAbortable(
        projectDir,
        options.baseBranch,
        abortSignal,
      );
      await cloneAndIsolateAbortable(projectDir, clonePath, baseBranch, abortSignal);
      if (fetchedCommit) {
        await fetchBaseBranchIntoIsolatedCloneAbortable(projectDir, clonePath, baseBranch, abortSignal);
        await runGitCommandAbortable(clonePath, ['reset', '--hard', fetchedCommit], abortSignal);
      }
      await runGitCommandAbortable(clonePath, ['checkout', '-b', branch], abortSignal);
    }

    syncProjectLocalTaktForRetry(projectDir, clonePath);
    this.saveCloneMeta(projectDir, branch, clonePath);
    log.info('Clone created', { path: clonePath, branch });

    return { path: clonePath, branch };
  }

  createTempCloneForBranch(projectDir: string, branch: string): WorktreeResult {
    CloneManager.resolveBaseBranch(projectDir);

    const timestamp = CloneManager.generateTimestamp();
    const clonePath = CloneManager.resolveAvailableClonePath(
      CloneManager.resolveCloneBaseDir(projectDir),
      `tmp-${timestamp}`,
    );

    log.info('Creating temp clone for branch', { path: clonePath, branch });

    cloneAndIsolate(projectDir, clonePath, branch);

    syncProjectLocalTaktForRetry(projectDir, clonePath);
    this.saveCloneMeta(projectDir, branch, clonePath);
    log.info('Temp clone created', { path: clonePath, branch });

    return { path: clonePath, branch };
  }

  removeClone(clonePath: string): void {
    log.info('Removing clone', { path: clonePath });
    try {
      fs.rmSync(clonePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      log.info('Clone removed', { path: clonePath });
    } catch (err) {
      log.error('Failed to remove clone', { path: clonePath, error: String(err) });
    }
  }

  saveCloneMeta(projectDir: string, branch: string, clonePath: string): void {
    saveCloneMetaFile(projectDir, branch, clonePath);
  }

  removeCloneMeta(projectDir: string, branch: string): void {
    removeCloneMetaFile(projectDir, branch);
  }

  cleanupOrphanedClone(projectDir: string, branch: string): void {
    const meta = loadCloneMeta(projectDir, branch);
    if (!meta) {
      this.removeCloneMeta(projectDir, branch);
      return;
    }
    const cloneBaseDir = path.resolve(CloneManager.resolveCloneBaseDir(projectDir));
    const resolvedClonePath = path.resolve(meta.clonePath);
    if (!isRealPathInside(cloneBaseDir, resolvedClonePath)) {
      log.error('Refusing to remove clone outside of clone base directory', {
        branch,
        clonePath: meta.clonePath,
        cloneBaseDir,
      });
      return;
    }
    if (fs.existsSync(resolvedClonePath)) {
      this.removeClone(resolvedClonePath);
      log.info('Orphaned clone cleaned up', { branch, clonePath: resolvedClonePath });
    }
    this.removeCloneMeta(projectDir, branch);
  }
}

const defaultManager = new CloneManager();

export function createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
  return defaultManager.createSharedClone(projectDir, options);
}

export function createSharedCloneAbortable(
  projectDir: string,
  options: WorktreeOptions,
  abortSignal?: AbortSignal,
): Promise<WorktreeResult> {
  return defaultManager.createSharedCloneAbortable(projectDir, options, abortSignal);
}

export function createTempCloneForBranch(projectDir: string, branch: string): WorktreeResult {
  return defaultManager.createTempCloneForBranch(projectDir, branch);
}

export function removeClone(clonePath: string): void {
  defaultManager.removeClone(clonePath);
}

export function saveCloneMeta(projectDir: string, branch: string, clonePath: string): void {
  defaultManager.saveCloneMeta(projectDir, branch, clonePath);
}

export function removeCloneMeta(projectDir: string, branch: string): void {
  defaultManager.removeCloneMeta(projectDir, branch);
}

export function cleanupOrphanedClone(projectDir: string, branch: string): void {
  defaultManager.cleanupOrphanedClone(projectDir, branch);
}

export function resolveBaseBranch(
  projectDir: string,
  explicitBaseBranch?: string,
): { branch: string; fetchedCommit?: string } {
  return CloneManager.resolveBaseBranch(projectDir, explicitBaseBranch);
}

export function resolveBaseBranchName(
  projectDir: string,
  explicitBaseBranch?: string,
): string {
  return CloneManager.resolveBaseBranchName(projectDir, explicitBaseBranch);
}

export function resolveCloneBaseDir(projectDir: string): string {
  return CloneManager.resolveCloneBaseDir(projectDir);
}
