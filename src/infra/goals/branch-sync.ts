import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { fetchGoalIntegrationBranchSha, goalGitText, isGoalCommitIncluded, resolveGoalBranchSha, runGoalGit } from './git-command.js';
import { targetWorktrees } from './merge-git.js';
import type { GoalBranchSync } from './schema.js';

export class GoalBranchSyncError extends Error {
  constructor(readonly result: GoalBranchSync) {
    super(`Goal branch synchronization stopped: ${result.status} (local ${result.localSha}, origin ${result.remoteSha})`);
    this.name = 'GoalBranchSyncError';
  }
}

export async function synchronizeGoalBranch(
  cwd: string, branch: string, signal: AbortSignal | undefined,
): Promise<GoalBranchSync> {
  const deadline = AbortSignal.timeout(30_000);
  const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const localSha = await resolveGoalBranchSha(cwd, branch, cancellation);
  const remotes = (await goalGitText(cwd, ['remote'], cancellation)).split('\n');
  if (!remotes.includes('origin')) return { status: 'no_origin', localSha };
  const ref = toLocalBranchRef(branch);
  const advertised = await runGoalGit(cwd, ['ls-remote', '--exit-code', '--heads', 'origin', ref], 4096, cancellation, [0, 2]);
  if (advertised.truncated) throw new Error('Goal remote ref output exceeds the limit');
  if (advertised.code === 2) return { status: 'unpublished', localSha };
  const remoteSha = await fetchGoalIntegrationBranchSha(cwd, branch, cancellation);
  if (localSha === remoteSha) return { status: 'unchanged', localSha, remoteSha };
  if (await isGoalCommitIncluded(cwd, remoteSha, localSha, cancellation)) {
    return { status: 'local_ahead', localSha, remoteSha };
  }
  if (!await isGoalCommitIncluded(cwd, localSha, remoteSha, cancellation)) {
    throw new GoalBranchSyncError({ status: 'diverged', localSha, remoteSha });
  }
  const worktrees = await targetWorktrees(cwd, branch, cancellation);
  if (worktrees.length > 0) throw new GoalBranchSyncError({ status: 'checked_out', localSha, remoteSha, worktrees });
  await goalGitText(cwd, ['update-ref', ref, remoteSha, localSha], cancellation);
  return { status: 'fast_forward', localSha, remoteSha };
}
