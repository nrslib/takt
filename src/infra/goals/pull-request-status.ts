import { fetchPrMergeStatus, type PrMergeStatus } from '../github/pr-status.js';
import { parseGitHubPullRequestTarget } from '../github/pull-request-target.js';
import type { Goal } from './schema.js';

export type GoalPullRequestStatus =
  | { status: 'unavailable' | 'mismatch' }
  | { status: 'available'; pullRequest: PrMergeStatus };

export async function readGoalPullRequestStatus(
  cwd: string, goal: Goal, signal: AbortSignal | undefined,
): Promise<GoalPullRequestStatus | undefined> {
  signal?.throwIfAborted();
  if (goal.pullRequest === undefined) return undefined;
  try {
    const target = parseGitHubPullRequestTarget(goal.pullRequest.url);
    if (target.number !== goal.pullRequest.number) return { status: 'mismatch' };
    const pullRequest = await fetchPrMergeStatus(target, cwd, { signal });
    signal?.throwIfAborted();
    if (pullRequest.headRefName !== goal.branch || pullRequest.baseRefName !== goal.integrationBranch) {
      return { status: 'mismatch' };
    }
    return { status: 'available', pullRequest };
  } catch {
    signal?.throwIfAborted();
    // PRを確認できない場合も、完成確認では従来の内容比較を使う。
    return { status: 'unavailable' };
  }
}
