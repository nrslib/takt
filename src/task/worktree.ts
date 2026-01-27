/**
 * Git worktree management
 *
 * Creates and removes git worktrees for task isolation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';
import { slugify } from '../utils/slug.js';
import { isPathSafe } from '../config/paths.js';

const log = createLogger('worktree');

export interface WorktreeOptions {
  /** worktree setting: true = auto path, string = custom path */
  worktree: boolean | string;
  /** Branch name (optional, auto-generated if omitted) */
  branch?: string;
  /** Task slug for auto-generated paths/branches */
  taskSlug: string;
}

export interface WorktreeResult {
  /** Absolute path to the worktree */
  path: string;
  /** Branch name used */
  branch: string;
}

/**
 * Generate a timestamp string for paths/branches
 */
function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
}

/**
 * Resolve the worktree path based on options.
 * Validates that the resolved path stays within the project directory.
 *
 * @throws Error if the resolved path escapes projectDir (path traversal)
 */
function resolveWorktreePath(projectDir: string, options: WorktreeOptions): string {
  if (typeof options.worktree === 'string') {
    const resolved = path.isAbsolute(options.worktree)
      ? options.worktree
      : path.resolve(projectDir, options.worktree);

    if (!isPathSafe(projectDir, resolved)) {
      throw new Error(`Worktree path escapes project directory: ${options.worktree}`);
    }

    return resolved;
  }

  // worktree: true → .takt/worktrees/{timestamp}-{task-slug}/
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);
  const dirName = slug ? `${timestamp}-${slug}` : timestamp;
  return path.join(projectDir, '.takt', 'worktrees', dirName);
}

/**
 * Resolve the branch name based on options
 */
function resolveBranchName(options: WorktreeOptions): string {
  if (options.branch) {
    return options.branch;
  }

  // Auto-generate: takt/{timestamp}-{task-slug}
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);
  return slug ? `takt/${timestamp}-${slug}` : `takt/${timestamp}`;
}

/**
 * Check if a git branch exists
 */
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
 * Create a git worktree for a task
 *
 * @returns WorktreeResult with path and branch
 * @throws Error if git worktree creation fails
 */
export function createWorktree(projectDir: string, options: WorktreeOptions): WorktreeResult {
  const worktreePath = resolveWorktreePath(projectDir, options);
  const branch = resolveBranchName(options);

  log.info('Creating worktree', { path: worktreePath, branch });

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create worktree (use execFileSync to avoid shell injection)
  if (branchExists(projectDir, branch)) {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } else {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath], {
      cwd: projectDir,
      stdio: 'pipe',
    });
  }

  log.info('Worktree created', { path: worktreePath, branch });

  return { path: worktreePath, branch };
}

/**
 * Remove a git worktree
 */
export function removeWorktree(projectDir: string, worktreePath: string): void {
  log.info('Removing worktree', { path: worktreePath });

  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: projectDir,
      stdio: 'pipe',
    });
    log.info('Worktree removed', { path: worktreePath });
  } catch (err) {
    log.error('Failed to remove worktree', { path: worktreePath, error: String(err) });
  }
}
