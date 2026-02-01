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
import { createLogger } from '../utils/debug.js';
import { slugify } from '../utils/slug.js';
import { loadGlobalConfig } from '../config/globalConfig.js';

const log = createLogger('clone');

export interface WorktreeOptions {
  /** worktree setting: true = auto path, string = custom path */
  worktree: boolean | string;
  /** Branch name (optional, auto-generated if omitted) */
  branch?: string;
  /** Task slug for auto-generated paths/branches */
  taskSlug: string;
  /** GitHub Issue number (optional, for formatting branch/path) */
  issueNumber?: number;
}

export interface WorktreeResult {
  /** Absolute path to the clone */
  path: string;
  /** Branch name used */
  branch: string;
}

function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
}

/**
 * Resolve the base directory for clones from global config.
 * Returns the configured worktree_dir (resolved to absolute), or ../
 */
function resolveCloneBaseDir(projectDir: string): string {
  const globalConfig = loadGlobalConfig();
  if (globalConfig.worktreeDir) {
    return path.isAbsolute(globalConfig.worktreeDir)
      ? globalConfig.worktreeDir
      : path.resolve(projectDir, globalConfig.worktreeDir);
  }
  return path.join(projectDir, '..');
}

/**
 * Resolve the clone path based on options and global config.
 *
 * Priority:
 * 1. Custom path in options.worktree (string)
 * 2. worktree_dir from config.yaml (if set)
 * 3. Default: ../{dir-name}
 *
 * Format with issue: {timestamp}-{issue}-{slug}
 * Format without issue: {timestamp}-{slug}
 */
function resolveClonePath(projectDir: string, options: WorktreeOptions): string {
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);

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

  return path.join(resolveCloneBaseDir(projectDir), dirName);
}

/**
 * Resolve branch name from options.
 *
 * Format with issue: takt/#{issue}/{slug}
 * Format without issue: takt/{timestamp}-{slug}
 * Custom branch: use as-is
 */
function resolveBranchName(options: WorktreeOptions): string {
  if (options.branch) {
    return options.branch;
  }

  const slug = slugify(options.taskSlug);

  if (options.issueNumber !== undefined && slug) {
    return `takt/#${options.issueNumber}/${slug}`;
  }

  const timestamp = generateTimestamp();
  return slug ? `takt/${timestamp}-${slug}` : `takt/${timestamp}`;
}

function branchExists(projectDir: string, branch: string): boolean {
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
 * Clone a repository and remove origin to isolate from the main repo.
 */
function cloneAndIsolate(projectDir: string, clonePath: string): void {
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  execFileSync('git', ['clone', '--reference', projectDir, '--dissociate', projectDir, clonePath], {
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

/**
 * Create a git clone for a task.
 *
 * Uses `git clone --reference --dissociate` to create an independent clone,
 * then removes origin and checks out a new branch.
 */
export function createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
  const clonePath = resolveClonePath(projectDir, options);
  const branch = resolveBranchName(options);

  log.info('Creating shared clone', { path: clonePath, branch });

  cloneAndIsolate(projectDir, clonePath);

  if (branchExists(clonePath, branch)) {
    execFileSync('git', ['checkout', branch], { cwd: clonePath, stdio: 'pipe' });
  } else {
    execFileSync('git', ['checkout', '-b', branch], { cwd: clonePath, stdio: 'pipe' });
  }

  saveCloneMeta(projectDir, branch, clonePath);
  log.info('Clone created', { path: clonePath, branch });

  return { path: clonePath, branch };
}

/**
 * Create a temporary clone for an existing branch.
 * Used by review/instruct to work on a branch that was previously pushed.
 */
export function createTempCloneForBranch(projectDir: string, branch: string): WorktreeResult {
  const timestamp = generateTimestamp();
  const clonePath = path.join(resolveCloneBaseDir(projectDir), `tmp-${timestamp}`);

  log.info('Creating temp clone for branch', { path: clonePath, branch });

  cloneAndIsolate(projectDir, clonePath);

  execFileSync('git', ['checkout', branch], { cwd: clonePath, stdio: 'pipe' });

  saveCloneMeta(projectDir, branch, clonePath);
  log.info('Temp clone created', { path: clonePath, branch });

  return { path: clonePath, branch };
}

/**
 * Remove a clone directory.
 */
export function removeClone(clonePath: string): void {
  log.info('Removing clone', { path: clonePath });
  try {
    fs.rmSync(clonePath, { recursive: true, force: true });
    log.info('Clone removed', { path: clonePath });
  } catch (err) {
    log.error('Failed to remove clone', { path: clonePath, error: String(err) });
  }
}

// --- Clone metadata ---

const CLONE_META_DIR = 'clone-meta';

function encodeBranchName(branch: string): string {
  return branch.replace(/\//g, '--');
}

function getCloneMetaPath(projectDir: string, branch: string): string {
  return path.join(projectDir, '.takt', CLONE_META_DIR, `${encodeBranchName(branch)}.json`);
}

/**
 * Save clone metadata (branch → clonePath mapping).
 * Used to clean up orphaned clone directories on merge/delete.
 */
export function saveCloneMeta(projectDir: string, branch: string, clonePath: string): void {
  const filePath = getCloneMetaPath(projectDir, branch);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ branch, clonePath }));
  log.info('Clone meta saved', { branch, clonePath });
}

/**
 * Remove clone metadata for a branch.
 */
export function removeCloneMeta(projectDir: string, branch: string): void {
  try {
    fs.unlinkSync(getCloneMetaPath(projectDir, branch));
    log.info('Clone meta removed', { branch });
  } catch {
    // File may not exist — ignore
  }
}

/**
 * Clean up an orphaned clone directory associated with a branch.
 * Reads metadata, removes clone directory if it still exists, then removes metadata.
 */
export function cleanupOrphanedClone(projectDir: string, branch: string): void {
  try {
    const raw = fs.readFileSync(getCloneMetaPath(projectDir, branch), 'utf-8');
    const meta = JSON.parse(raw) as { clonePath: string };
    if (fs.existsSync(meta.clonePath)) {
      removeClone(meta.clonePath);
      log.info('Orphaned clone cleaned up', { branch, clonePath: meta.clonePath });
    }
  } catch {
    // No metadata or parse error — nothing to clean up
  }
  removeCloneMeta(projectDir, branch);
}
