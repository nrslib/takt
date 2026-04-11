import { execFileSync } from 'node:child_process';
import {
  getCurrentBranch,
  materializeCloneHeadToRootBranch,
  relayPushCloneToOrigin,
} from '../../task/index.js';
import { getCommandErrorDetail } from './system-git-context.js';

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
  execFileSync('git', ['fetch', 'origin', branch], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

export function fastForwardPrBranch(cwd: string, branch: string): void {
  execFileSync('git', ['merge', '--ff-only', `origin/${branch}`], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

export function mergeBaseBranch(cwd: string, branch: string): void {
  execFileSync('git', ['merge', `origin/${branch}`], {
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
