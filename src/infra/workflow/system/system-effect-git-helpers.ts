import { execFileSync } from 'node:child_process';
import {
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

function buildWorktreeBranchRef(branch: string): string {
  return `refs/takt/pr-sync/${branch}`;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function fetchOriginTrackingRef(projectCwd: string, branch: string): void {
  assertFetchableBranchName(branch);
  runGit(projectCwd, ['fetch', 'origin', `${buildRemoteHeadRef(branch)}:${buildRemoteTrackingRef(branch)}`]);
}

export function abortMerge(worktreePath: string): string | undefined {
  try {
    runGit(worktreePath, ['merge', '--abort']);
    return undefined;
  } catch (error) {
    return getCommandErrorDetail(error);
  }
}

export function pushSynced(worktreePath: string, projectCwd: string, branch: string): void {
  materializeCloneHeadToRootBranch(worktreePath, projectCwd, branch);
  relayPushCloneToOrigin(worktreePath, projectCwd, branch);
}

export function checkoutWorktreeBranchFromOrigin(projectCwd: string, worktreePath: string, branch: string): void {
  const worktreeBranchRef = buildWorktreeBranchRef(branch);
  fetchOriginTrackingRef(projectCwd, branch);
  runGit(worktreePath, ['fetch', projectCwd, `${buildRemoteTrackingRef(branch)}:${worktreeBranchRef}`]);
  runGit(worktreePath, ['checkout', '-B', branch, worktreeBranchRef]);
}

export function fetchRemoteBranch(projectCwd: string, worktreePath: string, branch: string): void {
  fetchOriginTrackingRef(projectCwd, branch);
  runGit(worktreePath, ['fetch', projectCwd, `${buildRemoteTrackingRef(branch)}:${buildRemoteTrackingRef(branch)}`]);
}

export function fastForwardPrBranch(cwd: string, branch: string): void {
  runGit(cwd, ['merge', '--ff-only', buildRemoteTrackingRef(branch)]);
}

export function mergeBaseBranch(cwd: string, branch: string): void {
  runGit(cwd, ['merge', buildRemoteTrackingRef(branch)]);
}

export function isMergeInProgressError(error: unknown): boolean {
  const detail = getCommandErrorDetail(error);
  return detail.includes('MERGE_HEAD exists') || detail.includes('You have not concluded your merge');
}
