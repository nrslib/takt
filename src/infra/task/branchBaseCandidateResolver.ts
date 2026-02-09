import { createLogger } from '../../shared/utils/index.js';
import { type BranchBaseResolutionCache, listCandidateRefs } from './branchBaseRefCache.js';
import { runGit } from './branchGitCommands.js';

type BaseRefCandidate = {
  baseRef: string;
  baseCommit: string;
  firstSubject: string;
  distance: number;
};

const TAKT_COMMIT_PREFIX = 'takt:';
const log = createLogger('branchGitResolver');

export function resolveMergeBase(gitCwd: string, baseRef: string, branch: string): string {
  return runGit(gitCwd, ['merge-base', baseRef, branch]);
}

function buildPriorityRefs(defaultBranch: string, branch: string): string[] {
  const refs = [defaultBranch, `origin/${defaultBranch}`];
  const distinctRefs: string[] = [];
  for (const ref of refs) {
    if (!ref || ref === branch || ref.endsWith(`/${branch}`)) {
      continue;
    }
    if (!distinctRefs.includes(ref)) {
      distinctRefs.push(ref);
    }
  }

  return distinctRefs;
}

function getFirstParentDistance(gitCwd: string, baseCommit: string, branch: string): number {
  const output = runGit(gitCwd, ['rev-list', '--count', '--first-parent', `${baseCommit}..${branch}`]);
  return Number.parseInt(output, 10);
}

function getFirstParentFirstSubject(gitCwd: string, baseCommit: string, branch: string): string {
  const output = runGit(gitCwd, ['log', '--format=%s', '--reverse', '--first-parent', `${baseCommit}..${branch}`]);
  const firstLine = output.split('\n')[0];
  if (!firstLine) {
    return '';
  }
  return firstLine.trim();
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

  const best = sorted[0];
  return best ? best : null;
}

export function resolveBranchBaseCommitFromRefs(
  gitCwd: string,
  defaultBranch: string,
  branch: string,
  cache?: BranchBaseResolutionCache,
): string | null {
  const priorityRefs = buildPriorityRefs(defaultBranch, branch);
  const priorityCandidates: BaseRefCandidate[] = [];

  for (const ref of priorityRefs) {
    const candidate = resolveBaseCandidate(gitCwd, ref, branch);
    if (candidate) {
      priorityCandidates.push(candidate);
    }
  }

  const priorityBest = chooseBestBaseCandidate(priorityCandidates);
  if (priorityBest && priorityBest.firstSubject.startsWith(TAKT_COMMIT_PREFIX)) {
    return priorityBest.baseCommit;
  }

  const refs = listCandidateRefs(gitCwd, branch, cache).filter(ref => !priorityRefs.includes(ref));
  const candidates: BaseRefCandidate[] = [...priorityCandidates];

  for (const ref of refs) {
    const candidate = resolveBaseCandidate(gitCwd, ref, branch);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const best = chooseBestBaseCandidate(candidates);
  if (!best) {
    return null;
  }
  return best.baseCommit;
}
