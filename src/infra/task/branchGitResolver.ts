import { existsSync } from 'node:fs';
import { runGit } from './branchGitCommands.js';
import {
  type BranchBaseResolutionCache,
  createBranchBaseResolutionCache,
} from './branchBaseRefCache.js';
import {
  resolveBranchBaseCommitFromRefs,
  resolveMergeBase,
} from './branchBaseCandidateResolver.js';
import {
  readCommitSubject,
  resolveBranchEntryPointFromReflog,
} from './branchEntryPointResolver.js';

type FirstTaktCommit = {
  subject: string;
};

type FindFirstTaktCommitOptions = {
  baseCommit?: string;
  cache?: BranchBaseResolutionCache;
};

function parseFirstCommitLine(output: string): FirstTaktCommit | null {
  if (!output) {
    return null;
  }

  const firstLine = output.split('\n')[0];
  if (!firstLine) {
    return null;
  }

  const tabIndex = firstLine.indexOf('\t');
  if (tabIndex === -1) {
    return null;
  }

  return {
    subject: firstLine.slice(tabIndex + 1),
  };
}

export function resolveGitCwd(cwd: string, worktreePath?: string): string {
  return worktreePath && existsSync(worktreePath) ? worktreePath : cwd;
}

export { createBranchBaseResolutionCache, resolveMergeBase };
export type { BranchBaseResolutionCache };

export function findFirstTaktCommit(
  gitCwd: string,
  defaultBranch: string,
  branch: string,
  options?: FindFirstTaktCommitOptions,
): FirstTaktCommit | null {
  let baseCommit: string;
  if (options?.baseCommit) {
    baseCommit = options.baseCommit;
  } else {
    const entryPoint = resolveBranchEntryPointFromReflog(gitCwd, branch);
    if (entryPoint) {
      const subject = readCommitSubject(gitCwd, entryPoint.firstCommit);
      return {
        subject,
      };
    }

    const resolvedFromRefs = resolveBranchBaseCommitFromRefs(gitCwd, defaultBranch, branch, options?.cache);
    baseCommit = resolvedFromRefs ? resolvedFromRefs : resolveMergeBase(gitCwd, defaultBranch, branch);
  }

  const output = runGit(gitCwd, [
    'log',
    '--format=%H\t%s',
    '--reverse',
    '--first-parent',
    '--grep=^takt:',
    `${baseCommit}..${branch}`,
  ]);

  return parseFirstCommitLine(output);
}

export function resolveBranchBaseCommit(
  gitCwd: string,
  defaultBranch: string,
  branch: string,
  cache?: BranchBaseResolutionCache,
): string {
  const entryPoint = resolveBranchEntryPointFromReflog(gitCwd, branch);
  if (entryPoint) {
    return entryPoint.baseCommit;
  }

  const baseCommitFromRefs = resolveBranchBaseCommitFromRefs(gitCwd, defaultBranch, branch, cache);
  if (baseCommitFromRefs) {
    return baseCommitFromRefs;
  }
  return resolveMergeBase(gitCwd, defaultBranch, branch);
}
