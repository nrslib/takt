/**
 * Branch list helpers
 *
 * Listing, parsing, and enriching takt-managed branches
 * with metadata (diff stats, original instruction, task slug).
 * Used by the /list command.
 */

import { execFileSync } from 'node:child_process';
import { createLogger } from '../../shared/utils/index.js';
import {
  createBranchBaseResolutionCache,
  findFirstTaktCommit,
  resolveBranchBaseCommit,
  resolveGitCwd,
  type BranchBaseResolutionCache,
} from './branchGitResolver.js';

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
    } catch (error) {
      log.debug('detectDefaultBranch symbolic-ref failed', { error: String(error), cwd });
      try {
        execFileSync('git', ['rev-parse', '--verify', 'main'], {
          cwd, encoding: 'utf-8', stdio: 'pipe',
        });
        return 'main';
      } catch (mainError) {
        log.debug('detectDefaultBranch main lookup failed', { error: String(mainError), cwd });
        try {
          execFileSync('git', ['rev-parse', '--verify', 'master'], {
            cwd, encoding: 'utf-8', stdio: 'pipe',
          });
          return 'master';
        } catch (masterError) {
          log.debug('detectDefaultBranch master lookup failed', { error: String(masterError), cwd });
          return 'main';
        }
      }
    }
  }

  /** List all takt-managed branches (local + remote) */
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

      // Merge and deduplicate (local > remote)
      const branchMap = new Map<string, BranchInfo>();
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

  /** Get the number of files changed between a branch and its inferred base commit */
  getFilesChanged(
    cwd: string,
    defaultBranch: string,
    branch: string,
    worktreePath?: string,
    baseCommit?: string | null,
    cache?: BranchBaseResolutionCache,
  ): number {
    try {
      const gitCwd = resolveGitCwd(cwd, worktreePath);
      let resolvedBaseCommit: string;
      if (baseCommit === null) {
        throw new Error(`Failed to resolve base commit for branch: ${branch}`);
      }
      if (baseCommit) {
        resolvedBaseCommit = baseCommit;
      } else {
        resolvedBaseCommit = resolveBranchBaseCommit(gitCwd, defaultBranch, branch, cache);
      }

      if (!resolvedBaseCommit) {
        throw new Error(`Failed to resolve base commit for branch: ${branch}`);
      }

      log.debug('getFilesChanged', { gitCwd, baseCommit: resolvedBaseCommit, branch, worktreePath });

      const output = execFileSync(
        'git', ['diff', '--numstat', `${resolvedBaseCommit}..${branch}`],
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
    baseCommit?: string | null,
    cache?: BranchBaseResolutionCache,
    worktreePath?: string,
  ): string {
    try {
      if (baseCommit === null) {
        throw new Error(`Failed to resolve base commit for branch: ${branch}`);
      }

      const gitCwd = resolveGitCwd(cwd, worktreePath);
      const resolvedBaseCommitOption = baseCommit ? baseCommit : undefined;
      const firstTaktCommit = findFirstTaktCommit(gitCwd, defaultBranch, branch, {
        baseCommit: resolvedBaseCommitOption,
        cache,
      });
      if (firstTaktCommit) {
        const TAKT_COMMIT_PREFIX = 'takt:';
        if (firstTaktCommit.subject.startsWith(TAKT_COMMIT_PREFIX)) {
          return firstTaktCommit.subject.slice(TAKT_COMMIT_PREFIX.length).trim();
        }
        return firstTaktCommit.subject;
      }

      const resolvedBaseCommit = baseCommit
        ? baseCommit
        : resolveBranchBaseCommit(gitCwd, defaultBranch, branch, cache);
      if (!resolvedBaseCommit) {
        throw new Error(`Failed to resolve base commit for branch: ${branch}`);
      }

      const output = execFileSync(
        'git',
        ['log', '--format=%s', '--reverse', `${resolvedBaseCommit}..${branch}`],
        { cwd: gitCwd, encoding: 'utf-8', stdio: 'pipe' },
      ).trim();

      if (!output) return '';

      const firstLine = output.split('\n')[0] || '';
      const TAKT_COMMIT_PREFIX = 'takt:';
      if (firstLine.startsWith(TAKT_COMMIT_PREFIX)) {
        return firstLine.slice(TAKT_COMMIT_PREFIX.length).trim();
      }

      return firstLine;
    } catch (error) {
      log.debug('getOriginalInstruction failed', { error: String(error), cwd, defaultBranch, branch });
      return '';
    }
  }

  /** Build list items from branch list, enriching with diff stats */
  buildListItems(
    projectDir: string,
    branches: BranchInfo[],
    defaultBranch: string,
  ): BranchListItem[] {
    const cache = createBranchBaseResolutionCache();

    return branches.map(br => {
      const gitCwd = resolveGitCwd(projectDir, br.worktreePath);
      let baseCommit: string | null = null;

      try {
        baseCommit = resolveBranchBaseCommit(gitCwd, defaultBranch, br.branch, cache);
      } catch (error) {
        log.debug('buildListItems base commit resolution failed', { error: String(error), branch: br.branch, gitCwd });
      }

      return {
        info: br,
        filesChanged: this.getFilesChanged(projectDir, defaultBranch, br.branch, br.worktreePath, baseCommit, cache),
        taskSlug: BranchManager.extractTaskSlug(br.branch),
        originalInstruction: this.getOriginalInstruction(
          projectDir,
          defaultBranch,
          br.branch,
          baseCommit,
          cache,
          br.worktreePath,
        ),
      };
    });
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
