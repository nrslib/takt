import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from '../../shared/utils/index.js';

type BranchEntryPoint = {
  baseCommit: string;
  firstCommit: string;
};

type FirstTaktCommit = {
  subject: string;
};

type BaseRefCandidate = {
  baseRef: string;
  baseCommit: string;
  firstSubject: string;
  distance: number;
};

const TAKT_COMMIT_PREFIX = 'takt:';
const log = createLogger('branchGitResolver');

function runGit(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

function parseDistinctHashes(output: string): string[] {
  const hashes = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const distinct: string[] = [];
  for (const hash of hashes) {
    if (distinct[distinct.length - 1] !== hash) {
      distinct.push(hash);
    }
  }

  return distinct;
}

export function resolveGitCwd(cwd: string, worktreePath?: string): string {
  return worktreePath && existsSync(worktreePath) ? worktreePath : cwd;
}

export function resolveMergeBase(gitCwd: string, baseRef: string, branch: string): string {
  return runGit(gitCwd, ['merge-base', baseRef, branch]);
}

function listCandidateRefs(gitCwd: string, branch: string): string[] {
  const output = runGit(gitCwd, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);

  const refs = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(ref => ref !== branch)
    .filter(ref => !ref.endsWith(`/${branch}`))
    .filter(ref => !ref.endsWith('/HEAD'));

  return Array.from(new Set(refs));
}

function getFirstParentDistance(gitCwd: string, baseCommit: string, branch: string): number {
  const output = runGit(gitCwd, ['rev-list', '--count', '--first-parent', `${baseCommit}..${branch}`]);
  return Number.parseInt(output, 10);
}

function getFirstParentFirstSubject(gitCwd: string, baseCommit: string, branch: string): string {
  const output = runGit(gitCwd, ['log', '--format=%s', '--reverse', '--first-parent', `${baseCommit}..${branch}`]);
  return output.split('\n')[0]?.trim() ?? '';
}

function resolveBaseCandidate(gitCwd: string, baseRef: string, branch: string): BaseRefCandidate | null {
  try {
    const baseCommit = resolveMergeBase(gitCwd, baseRef, branch);
    if (!baseCommit) {
      return null;
    }

    const distance = getFirstParentDistance(gitCwd, baseCommit, branch);
    if (!Number.isFinite(distance) || distance <= 0) {
      return null;
    }

    const firstSubject = getFirstParentFirstSubject(gitCwd, baseCommit, branch);
    return { baseRef, baseCommit, firstSubject, distance };
  } catch (error) {
    log.debug('Failed to resolve base candidate', { error: String(error), gitCwd, baseRef, branch });
    return null;
  }
}

function chooseBestBaseCandidate(candidates: BaseRefCandidate[]): BaseRefCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    const aTakt = a.firstSubject.startsWith(TAKT_COMMIT_PREFIX);
    const bTakt = b.firstSubject.startsWith(TAKT_COMMIT_PREFIX);
    if (aTakt !== bTakt) {
      return aTakt ? -1 : 1;
    }

    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }

    const aRemote = a.baseRef.includes('/');
    const bRemote = b.baseRef.includes('/');
    if (aRemote !== bRemote) {
      return aRemote ? 1 : -1;
    }

    return a.baseRef.localeCompare(b.baseRef);
  });

  return sorted[0] ?? null;
}

function resolveBranchBaseCommitFromRefs(gitCwd: string, branch: string): string | null {
  const refs = listCandidateRefs(gitCwd, branch);
  const candidates: BaseRefCandidate[] = [];

  for (const ref of refs) {
    const candidate = resolveBaseCandidate(gitCwd, ref, branch);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const best = chooseBestBaseCandidate(candidates);
  return best?.baseCommit ?? null;
}

function resolveBranchEntryPointFromReflog(gitCwd: string, branch: string): BranchEntryPoint | null {
  try {
    const output = runGit(gitCwd, ['reflog', 'show', '--format=%H', branch]);
    const hashes = parseDistinctHashes(output).reverse();
    if (hashes.length < 2) {
      return null;
    }

    return {
      baseCommit: hashes[0]!,
      firstCommit: hashes[1]!,
    };
  } catch (error) {
    log.debug('Failed to resolve branch entry point from reflog', { error: String(error), gitCwd, branch });
    return null;
  }
}

function readCommitSubject(gitCwd: string, commit: string): string {
  return runGit(gitCwd, ['show', '-s', '--format=%s', commit]);
}

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

export function findFirstTaktCommit(
  gitCwd: string,
  defaultBranch: string,
  branch: string,
): FirstTaktCommit | null {
  const entryPoint = resolveBranchEntryPointFromReflog(gitCwd, branch);
  if (entryPoint) {
    const subject = readCommitSubject(gitCwd, entryPoint.firstCommit);
    return {
      subject,
    };
  }

  const baseCommit = resolveBranchBaseCommitFromRefs(gitCwd, branch) ?? resolveMergeBase(gitCwd, defaultBranch, branch);
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

export function resolveBranchBaseCommit(gitCwd: string, defaultBranch: string, branch: string): string {
  const entryPoint = resolveBranchEntryPointFromReflog(gitCwd, branch);
  if (entryPoint) {
    return entryPoint.baseCommit;
  }

  return resolveBranchBaseCommitFromRefs(gitCwd, branch) ?? resolveMergeBase(gitCwd, defaultBranch, branch);
}
