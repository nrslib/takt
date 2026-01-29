/**
 * Git clone management
 *
 * Creates and removes git clones for task isolation.
 * Uses `git clone --reference --dissociate` instead of worktrees so
 * each clone has a fully independent .git directory with no alternates
 * link, preventing Claude Code from traversing back to the main repository.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';
import { slugify } from '../utils/slug.js';
import { loadGlobalConfig } from '../config/globalConfig.js';

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
  /** Absolute path to the clone */
  path: string;
  /** Branch name used */
  branch: string;
}

/** Branch info from `git branch --list` */
export interface BranchInfo {
  branch: string;
  commit: string;
}

/** Branch with review metadata */
export interface BranchReviewItem {
  info: BranchInfo;
  filesChanged: number;
  taskSlug: string;
  /** Original task instruction extracted from first commit message */
  originalInstruction: string;
}

/**
 * Generate a timestamp string for paths/branches
 */
function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
}

/**
 * Resolve the clone path based on options and global config.
 *
 * Priority:
 * 1. Custom path in options.worktree (string)
 * 2. worktree_dir from config.yaml (if set)
 * 3. Default: ../{dir-name}
 */
function resolveClonePath(projectDir: string, options: WorktreeOptions): string {
  const timestamp = generateTimestamp();
  const slug = slugify(options.taskSlug);
  const dirName = slug ? `${timestamp}-${slug}` : timestamp;

  if (typeof options.worktree === 'string') {
    return path.isAbsolute(options.worktree)
      ? options.worktree
      : path.resolve(projectDir, options.worktree);
  }

  const globalConfig = loadGlobalConfig();
  if (globalConfig.worktreeDir) {
    const baseDir = path.isAbsolute(globalConfig.worktreeDir)
      ? globalConfig.worktreeDir
      : path.resolve(projectDir, globalConfig.worktreeDir);
    return path.join(baseDir, dirName);
  }

  return path.join(projectDir, '..', dirName);
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
 * Create a git shared clone for a task.
 *
 * Uses `git clone --shared` to create a lightweight clone with
 * an independent .git directory. Then checks out a new branch.
 *
 * @returns WorktreeResult with path and branch
 * @throws Error if git clone creation fails
 */
export function createSharedClone(projectDir: string, options: WorktreeOptions): WorktreeResult {
  const clonePath = resolveClonePath(projectDir, options);
  const branch = resolveBranchName(options);

  log.info('Creating shared clone', { path: clonePath, branch });

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  // Create independent clone (--reference + --dissociate = no alternates link back)
  execFileSync('git', ['clone', '--reference', projectDir, '--dissociate', projectDir, clonePath], {
    cwd: projectDir,
    stdio: 'pipe',
  });

  // Checkout branch
  if (branchExists(clonePath, branch)) {
    execFileSync('git', ['checkout', branch], {
      cwd: clonePath,
      stdio: 'pipe',
    });
  } else {
    execFileSync('git', ['checkout', '-b', branch], {
      cwd: clonePath,
      stdio: 'pipe',
    });
  }

  log.info('Clone created', { path: clonePath, branch });

  return { path: clonePath, branch };
}

/**
 * Create a temporary shared clone for an existing branch.
 * Used by review/instruct to work on a branch that was previously pushed.
 *
 * @returns WorktreeResult with path and branch
 * @throws Error if git clone creation fails
 */
export function createTempCloneForBranch(projectDir: string, branch: string): WorktreeResult {
  const timestamp = generateTimestamp();
  const globalConfig = loadGlobalConfig();
  let clonePath: string;

  if (globalConfig.worktreeDir) {
    const baseDir = path.isAbsolute(globalConfig.worktreeDir)
      ? globalConfig.worktreeDir
      : path.resolve(projectDir, globalConfig.worktreeDir);
    clonePath = path.join(baseDir, `tmp-${timestamp}`);
  } else {
    clonePath = path.join(projectDir, '..', `tmp-${timestamp}`);
  }

  log.info('Creating temp clone for branch', { path: clonePath, branch });

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  execFileSync('git', ['clone', '--reference', projectDir, '--dissociate', projectDir, clonePath], {
    cwd: projectDir,
    stdio: 'pipe',
  });

  execFileSync('git', ['checkout', branch], {
    cwd: clonePath,
    stdio: 'pipe',
  });

  log.info('Temp clone created', { path: clonePath, branch });

  return { path: clonePath, branch };
}

/**
 * Remove a clone directory
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

// --- Review-related types and helpers ---

const TAKT_BRANCH_PREFIX = 'takt/';

/**
 * Detect the default branch name (main or master).
 * Falls back to 'main'.
 */
export function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execFileSync(
      'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    // ref is like "refs/remotes/origin/main"
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'main';
  } catch {
    // Fallback: check if 'main' or 'master' exists
    try {
      execFileSync('git', ['rev-parse', '--verify', 'main'], {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      });
      return 'main';
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--verify', 'master'], {
          cwd, encoding: 'utf-8', stdio: 'pipe',
        });
        return 'master';
      } catch {
        return 'main';
      }
    }
  }
}

/**
 * List all takt-managed branches.
 * Uses `git branch --list 'takt/*'` instead of worktree list.
 */
export function listTaktBranches(projectDir: string): BranchInfo[] {
  try {
    const output = execFileSync(
      'git', ['branch', '--list', 'takt/*', '--format=%(refname:short) %(objectname:short)'],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    );
    return parseTaktBranches(output);
  } catch (err) {
    log.error('Failed to list takt branches', { error: String(err) });
    return [];
  }
}

/**
 * Parse `git branch --list` formatted output into BranchInfo entries.
 */
export function parseTaktBranches(output: string): BranchInfo[] {
  const entries: BranchInfo[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Format: "takt/20260128-fix-auth abc1234"
    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx === -1) continue;

    const branch = trimmed.slice(0, spaceIdx);
    const commit = trimmed.slice(spaceIdx + 1);

    if (branch.startsWith(TAKT_BRANCH_PREFIX)) {
      entries.push({ branch, commit });
    }
  }

  return entries;
}

/**
 * Get the number of files changed between the default branch and a given branch.
 */
export function getFilesChanged(cwd: string, defaultBranch: string, branch: string): number {
  try {
    const output = execFileSync(
      'git', ['diff', '--numstat', `${defaultBranch}...${branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    return output.trim().split('\n').filter(l => l.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Extract a human-readable task slug from a takt branch name.
 * e.g. "takt/20260128T032800-fix-auth" -> "fix-auth"
 */
export function extractTaskSlug(branch: string): string {
  const name = branch.replace(TAKT_BRANCH_PREFIX, '');
  // Remove timestamp prefix (format: YYYYMMDDTHHmmss- or similar)
  const withoutTimestamp = name.replace(/^\d{8,}T?\d{0,6}-?/, '');
  return withoutTimestamp || name;
}

/**
 * Extract the original task instruction from the first commit message on a branch.
 *
 * The first commit on a takt branch has the format: "takt: {original instruction}".
 * This function retrieves the first commit's message and strips the "takt: " prefix.
 * Returns empty string if extraction fails.
 */
export function getOriginalInstruction(
  cwd: string,
  defaultBranch: string,
  branch: string,
): string {
  try {
    // Get the first commit message on the branch (oldest first)
    const output = execFileSync(
      'git',
      ['log', '--format=%s', '--reverse', `${defaultBranch}..${branch}`],
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    if (!output) return '';

    const firstLine = output.split('\n')[0] || '';
    // Strip "takt: " prefix if present
    const TAKT_COMMIT_PREFIX = 'takt:';
    if (firstLine.startsWith(TAKT_COMMIT_PREFIX)) {
      return firstLine.slice(TAKT_COMMIT_PREFIX.length).trim();
    }

    return firstLine;
  } catch {
    return '';
  }
}

/**
 * Build review items from branch list, enriching with diff stats.
 */
export function buildReviewItems(
  projectDir: string,
  branches: BranchInfo[],
  defaultBranch: string,
): BranchReviewItem[] {
  return branches.map(br => ({
    info: br,
    filesChanged: getFilesChanged(projectDir, defaultBranch, br.branch),
    taskSlug: extractTaskSlug(br.branch),
    originalInstruction: getOriginalInstruction(projectDir, defaultBranch, br.branch),
  }));
}
