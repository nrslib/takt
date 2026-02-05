/**
 * Branch list helpers
 *
 * Listing, parsing, and enriching takt-managed branches
 * with metadata (diff stats, original instruction, task slug).
 * Used by the /list command.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../shared/utils/index.js';

import type { BranchInfo, BranchListItem } from './types.js';

export type { BranchInfo, BranchListItem };

const log = createLogger('branchList');

const TAKT_BRANCH_PREFIX = 'takt/';

/**
 * Manages takt branch listing and metadata enrichment.
 */
export class BranchManager {
  /** Detect the default branch name (main or master) */
  detectDefaultBranch(cwd: string): string {
    try {
      const ref = execFileSync(
        'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        { cwd, encoding: 'utf-8', stdio: 'pipe' },
      ).trim();
      const prefix = 'refs/remotes/origin/';
      return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
    } catch {
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

  /** List all takt-managed branches (local + remote + worktree-sessions) */
  listTaktBranches(projectDir: string): BranchInfo[] {
    try {
      // Get local branches
      const localOutput = execFileSync(
        'git', ['branch', '--list', 'takt/*', '--format=%(refname:short) %(objectname:short)'],
        { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
      );
      const localBranches = BranchManager.parseTaktBranches(localOutput);

      // Get remote branches
      const remoteOutput = execFileSync(
        'git', ['branch', '-r', '--list', 'origin/takt/*', '--format=%(refname:short) %(objectname:short)'],
        { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
      );
      const remoteBranches = BranchManager.parseTaktBranches(remoteOutput)
        .map(info => ({
          ...info,
          branch: info.branch.replace(/^origin\//, ''), // Strip origin/ prefix
        }));

      // Get branches from worktree-sessions (for isolated worktrees without remote)
      const worktreeBranches = this.listWorktreeSessions(projectDir);

      // Merge and deduplicate (local > remote > worktree-sessions)
      const branchMap = new Map<string, BranchInfo>();
      for (const info of worktreeBranches) {
        branchMap.set(info.branch, info);
      }
      for (const info of remoteBranches) {
        branchMap.set(info.branch, info);
      }
      for (const info of localBranches) {
        branchMap.set(info.branch, info);
      }

      return Array.from(branchMap.values());
    } catch (err) {
      log.error('Failed to list takt branches', { error: String(err) });
      return [];
    }
  }

  /** List branches from worktree-sessions directory */
  private listWorktreeSessions(projectDir: string): BranchInfo[] {
    const sessionsDir = join(projectDir, '.takt', 'worktree-sessions');
    if (!existsSync(sessionsDir)) {
      return [];
    }

    try {
      const files = readdirSync(sessionsDir);
      const branches: BranchInfo[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        // Extract branch slug from filename using timestamp pattern
        // Filename format: -path-to-parent-dir-{timestamp-slug}.json
        const nameWithoutExt = file.slice(0, -5); // Remove .json
        const match = nameWithoutExt.match(/(\d{8}T\d{4}-.+)$/);
        if (!match || match.index === undefined || !match[1]) continue;

        const branchSlug = match[1];
        const branch = `${TAKT_BRANCH_PREFIX}${branchSlug}`;

        // Extract parent directory path (everything before the branch slug)
        // Remove trailing dash before converting dashes to slashes
        let encodedPath = nameWithoutExt.slice(0, match.index);
        if (encodedPath.endsWith('-')) {
          encodedPath = encodedPath.slice(0, -1);
        }

        // Decode parent directory path (dashes back to slashes)
        const parentPath = encodedPath.replace(/-/g, '/');

        // Construct full worktree path
        const worktreePath = join(parentPath, branchSlug);

        // Check if worktree directory still exists
        if (!existsSync(worktreePath)) {
          continue; // Skip if worktree was deleted
        }

        // Use placeholder commit hash (worktree sessions don't track commit)
        branches.push({
          branch,
          commit: 'worktree',
          worktreePath,
        });
      }

      return branches;
    } catch (err) {
      log.error('Failed to list worktree sessions', { error: String(err) });
      return [];
    }
  }

  /** Parse `git branch --list` formatted output into BranchInfo entries */
  static parseTaktBranches(output: string): BranchInfo[] {
    const entries: BranchInfo[] = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

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

  /** Get the number of files changed between the default branch and a given branch */
  getFilesChanged(cwd: string, defaultBranch: string, branch: string, worktreePath?: string): number {
    try {
      // If worktreePath is provided, use it for git diff (for worktree-sessions branches)
      const gitCwd = worktreePath && existsSync(worktreePath) ? worktreePath : cwd;

      log.debug('getFilesChanged', { gitCwd, defaultBranch, branch, worktreePath });

      const output = execFileSync(
        'git', ['diff', '--numstat', `${defaultBranch}...${branch}`],
        { cwd: gitCwd, encoding: 'utf-8', stdio: 'pipe' },
      );

      const fileCount = output.trim().split('\n').filter(l => l.length > 0).length;
      log.debug('getFilesChanged result', { fileCount, outputLength: output.length });

      return fileCount;
    } catch (err) {
      log.error('getFilesChanged failed', { error: String(err), branch, worktreePath });
      return 0;
    }
  }

  /** Extract a human-readable task slug from a takt branch name */
  static extractTaskSlug(branch: string): string {
    const name = branch.replace(TAKT_BRANCH_PREFIX, '');
    const withoutTimestamp = name.replace(/^\d{8,}T?\d{0,6}-?/, '');
    return withoutTimestamp || name;
  }

  /**
   * Extract the original task instruction from the first commit message on a branch.
   * The first commit on a takt branch has the format: "takt: {original instruction}".
   */
  getOriginalInstruction(
    cwd: string,
    defaultBranch: string,
    branch: string,
  ): string {
    try {
      const output = execFileSync(
        'git',
        ['log', '--format=%s', '--reverse', `${defaultBranch}..${branch}`],
        { cwd, encoding: 'utf-8', stdio: 'pipe' },
      ).trim();

      if (!output) return '';

      const firstLine = output.split('\n')[0] || '';
      const TAKT_COMMIT_PREFIX = 'takt:';
      if (firstLine.startsWith(TAKT_COMMIT_PREFIX)) {
        return firstLine.slice(TAKT_COMMIT_PREFIX.length).trim();
      }

      return firstLine;
    } catch {
      return '';
    }
  }

  /** Build list items from branch list, enriching with diff stats */
  buildListItems(
    projectDir: string,
    branches: BranchInfo[],
    defaultBranch: string,
  ): BranchListItem[] {
    return branches.map(br => ({
      info: br,
      filesChanged: this.getFilesChanged(projectDir, defaultBranch, br.branch, br.worktreePath),
      taskSlug: BranchManager.extractTaskSlug(br.branch),
      originalInstruction: this.getOriginalInstruction(projectDir, defaultBranch, br.branch),
    }));
  }
}

// ---- Module-level functions ----

const defaultManager = new BranchManager();

export function detectDefaultBranch(cwd: string): string {
  return defaultManager.detectDefaultBranch(cwd);
}

export function listTaktBranches(projectDir: string): BranchInfo[] {
  return defaultManager.listTaktBranches(projectDir);
}

export function parseTaktBranches(output: string): BranchInfo[] {
  return BranchManager.parseTaktBranches(output);
}

export function getFilesChanged(cwd: string, defaultBranch: string, branch: string): number {
  return defaultManager.getFilesChanged(cwd, defaultBranch, branch);
}

export function extractTaskSlug(branch: string): string {
  return BranchManager.extractTaskSlug(branch);
}

export function getOriginalInstruction(cwd: string, defaultBranch: string, branch: string): string {
  return defaultManager.getOriginalInstruction(cwd, defaultBranch, branch);
}

export function buildListItems(
  projectDir: string,
  branches: BranchInfo[],
  defaultBranch: string,
): BranchListItem[] {
  return defaultManager.buildListItems(projectDir, branches, defaultBranch);
}
