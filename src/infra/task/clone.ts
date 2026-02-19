/**
 * Git clone lifecycle management
 *
 * Creates, removes, and tracks git clones for task isolation.
 * Uses `git clone --reference --dissociate` so each clone has a fully
 * independent .git directory, then removes the origin remote to prevent
 * Claude Code SDK from traversing back to the main repository.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import { resolveConfigValue } from '../config/index.js';
import type { WorktreeOptions, WorktreeResult } from './types.js';

export type { WorktreeOptions, WorktreeResult };

const log = createLogger('clone');

const CLONE_META_DIR = 'clone-meta';

/**
 * Manages git clone lifecycle for task isolation.
 *
 * Handles creation, removal, and metadata tracking of clones
 * used for parallel task execution.
 */
export class CloneManager {
  private static generateTimestamp(): string {
    return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
  }

  /**
   * Resolve the base directory for clones from global config.
   * Returns the configured worktree_dir (resolved to absolute), or ../
   */
  private static resolveCloneBaseDir(projectDir: string): string {
    const worktreeDir = resolveConfigValue(projectDir, 'worktreeDir');
    if (worktreeDir) {
      return path.isAbsolute(worktreeDir)
        ? worktreeDir
        : path.resolve(projectDir, worktreeDir);
    }
    return path.join(projectDir, '..', 'takt-worktree');
  }

  /** Resolve the clone path based on options and global config */
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

    return path.join(CloneManager.resolveCloneBaseDir(projectDir), dirName);
  }

  /** Resolve branch name from options */
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

  private static branchExists(projectDir: string, branch: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the main repository path (handles git worktree case).
   * If projectDir is a worktree, returns the main repo path.
   * Otherwise, returns projectDir as-is.
   */
  private static resolveMainRepo(projectDir: string): string {
    const gitPath = path.join(projectDir, '.git');

    try {
      const stats = fs.statSync(gitPath);
      if (stats.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match && match[1]) {
          const worktreePath = match[1].trim();
          const gitDir = path.resolve(worktreePath, '..', '..');
          const mainRepoPath = path.dirname(gitDir);
          log.info('Detected worktree, using main repo', { worktree: projectDir, mainRepo: mainRepoPath });
          return mainRepoPath;
        }
      }
    } catch (err) {
      log.debug('Failed to resolve main repo, using projectDir as-is', { error: String(err) });
    }

    return projectDir;
  }

  /** Clone a repository and remove origin to isolate from the main repo.
   *  When `branch` is specified, `--branch` is passed to `git clone` so the
   *  branch is checked out as a local branch *before* origin is removed.
   *  Without this, non-default branches are lost when `git remote remove origin`
   *  deletes the remote-tracking refs.
   */
  private static cloneAndIsolate(projectDir: string, clonePath: string, branch?: string): void {
    const referenceRepo = CloneManager.resolveMainRepo(projectDir);

    fs.mkdirSync(path.dirname(clonePath), { recursive: true });

    const cloneArgs = ['clone', '--reference', referenceRepo, '--dissociate'];
    if (branch) {
      cloneArgs.push('--branch', branch);
    }
    cloneArgs.push(projectDir, clonePath);

    execFileSync('git', cloneArgs, {
      cwd: projectDir,
      stdio: 'pipe',
    });

    execFileSync('git', ['remote', 'remove', 'origin'], {
      cwd: clonePath,
      stdio: 'pipe',
    });

    // Propagate local git user config from source repo to clone
    for (const key of ['user.name', 'user.email']) {
      try {
        const value = execFileSync('git', ['config', '--local', key], {
          cwd: projectDir,
          stdio: 'pipe',
        }).toString().trim();
        if (value) {
          execFileSync('git', ['config', key, value], {
            cwd: clonePath,
            stdio: 'pipe',
          });
        }
      } catch {
        // not set locally — skip
      }
    }
  }

  private static encodeBranchName(branch: string): string {
    return branch.replace(/\//g, '--');
  }

  private static getCloneMetaPath(projectDir: string, branch: string): string {
    return path.join(projectDir, '.takt', CLONE_META_DIR, `${CloneManager.encodeBranchName(branch)}.json`);
  }

  /** Create a git clone for a task */
  createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
    const clonePath = CloneManager.resolveClonePath(projectDir, options);
    const branch = CloneManager.resolveBranchName(options);

    log.info('Creating shared clone', { path: clonePath, branch });

    if (CloneManager.branchExists(projectDir, branch)) {
      CloneManager.cloneAndIsolate(projectDir, clonePath, branch);
    } else {
      CloneManager.cloneAndIsolate(projectDir, clonePath);
      execFileSync('git', ['checkout', '-b', branch], { cwd: clonePath, stdio: 'pipe' });
    }

    this.saveCloneMeta(projectDir, branch, clonePath);
    log.info('Clone created', { path: clonePath, branch });

    return { path: clonePath, branch };
  }

  /** Create a temporary clone for an existing branch */
  createTempCloneForBranch(projectDir: string, branch: string): WorktreeResult {
    const timestamp = CloneManager.generateTimestamp();
    const clonePath = path.join(CloneManager.resolveCloneBaseDir(projectDir), `tmp-${timestamp}`);

    log.info('Creating temp clone for branch', { path: clonePath, branch });

    CloneManager.cloneAndIsolate(projectDir, clonePath, branch);

    this.saveCloneMeta(projectDir, branch, clonePath);
    log.info('Temp clone created', { path: clonePath, branch });

    return { path: clonePath, branch };
  }

  /** Remove a clone directory */
  removeClone(clonePath: string): void {
    log.info('Removing clone', { path: clonePath });
    try {
      fs.rmSync(clonePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      log.info('Clone removed', { path: clonePath });
    } catch (err) {
      log.error('Failed to remove clone', { path: clonePath, error: String(err) });
    }
  }

  /** Save clone metadata (branch → clonePath mapping) */
  saveCloneMeta(projectDir: string, branch: string, clonePath: string): void {
    const filePath = CloneManager.getCloneMetaPath(projectDir, branch);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ branch, clonePath }));
    log.info('Clone meta saved', { branch, clonePath });
  }

  /** Remove clone metadata for a branch */
  removeCloneMeta(projectDir: string, branch: string): void {
    try {
      fs.unlinkSync(CloneManager.getCloneMetaPath(projectDir, branch));
      log.info('Clone meta removed', { branch });
    } catch {
      // File may not exist — ignore
    }
  }

  /** Clean up an orphaned clone directory associated with a branch */
  cleanupOrphanedClone(projectDir: string, branch: string): void {
    try {
      const raw = fs.readFileSync(CloneManager.getCloneMetaPath(projectDir, branch), 'utf-8');
      const meta = JSON.parse(raw) as { clonePath: string };
      if (fs.existsSync(meta.clonePath)) {
        this.removeClone(meta.clonePath);
        log.info('Orphaned clone cleaned up', { branch, clonePath: meta.clonePath });
      }
    } catch {
      // No metadata or parse error — nothing to clean up
    }
    this.removeCloneMeta(projectDir, branch);
  }
}

// ---- Module-level functions ----

const defaultManager = new CloneManager();

export function createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
  return defaultManager.createSharedClone(projectDir, options);
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
