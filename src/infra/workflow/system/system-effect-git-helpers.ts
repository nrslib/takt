import { execFileSync } from 'node:child_process';
import {
  getCurrentBranch,
  materializeCloneHeadToRootBranch,
  relayPushCloneToOrigin,
} from '../../task/index.js';
import { getCommandErrorDetail } from './system-git-context.js';

function assertFetchableBranchName(branch: string): void {
  if (branch.startsWith('-')) {
    throw new Error(`Refusing to fetch branch "${branch}" because it starts with "-"`);
  }
}

function buildRemoteTrackingRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function buildRemoteHeadRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function abortMerge(worktreePath: string): string | undefined {
  try {
    execFileSync('git', ['merge', '--abort'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return undefined;
  } catch (error) {
    return getCommandErrorDetail(error);
  }
}

export function pushSynced(worktreePath: string, projectCwd: string, branch: string): void {
  materializeCloneHeadToRootBranch(worktreePath, projectCwd, branch);
  relayPushCloneToOrigin(worktreePath, projectCwd, branch);
}

export function fetchRemoteBranch(cwd: string, branch: string): void {
  assertFetchableBranchName(branch);
  execFileSync('git', ['fetch', 'origin', `${buildRemoteHeadRef(branch)}:${buildRemoteTrackingRef(branch)}`], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

export function fastForwardPrBranch(cwd: string, branch: string): void {
  execFileSync('git', ['merge', '--ff-only', buildRemoteTrackingRef(branch)], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

export function mergeBaseBranch(cwd: string, branch: string): void {
  execFileSync('git', ['merge', buildRemoteTrackingRef(branch)], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

export function isMergeInProgressError(error: unknown): boolean {
  const detail = getCommandErrorDetail(error);
  return detail.includes('MERGE_HEAD exists') || detail.includes('You have not concluded your merge');
}

export function requirePrBranchTarget(cwd: string, branch: string): void {
  const currentBranch = getCurrentBranch(cwd);
  if (currentBranch !== branch) {
    throw new Error(
      `System effect requires cwd to be on PR branch "${branch}", but current branch is "${currentBranch}"`,
    );
  }
}
