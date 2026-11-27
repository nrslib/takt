import type { PrDetails } from '../../core/workflow/system/pr-execution-context.js';
import type { TaskFileData } from '../../infra/task/schema.js';
import { runGitCommandAbortable } from '../../infra/task/clone-exec.js';
import { resolvePublishedPrRepositoryUrl, type GitHubPullRequestTarget } from '../../infra/github/pull-request-target.js';

export async function resolvePrMergeBaseRepositoryUrl(projectDir: string, signal?: AbortSignal, target?: GitHubPullRequestTarget): Promise<string> {
  const remotes = await runGitCommandAbortable(projectDir, ['remote'], signal);
  const origin = remotes.stdout.trim().split(/\s+/u).includes('origin')
    ? (await runGitCommandAbortable(projectDir, ['remote', 'get-url', 'origin'], signal)).stdout.trim()
    : projectDir;
  return target === undefined ? origin : resolvePublishedPrRepositoryUrl(origin,
    `git@${target.hostname}:${target.owner}/${target.repo}.git`, target);
}

export function assertSavedPrMergeIdentity(
  data: TaskFileData,
  details: PrDetails,
  prNumber: number,
): void {
  if (data.merge_head_repository_url !== details.headRepositoryUrl
    || JSON.stringify(data.merge_head_repository_push_urls) !== JSON.stringify(details.headRepositoryPushUrls)
    || data.merge_initial_head_sha === undefined
    || details.number !== prNumber || data.branch !== details.headBranch
    || data.base_branch !== details.baseBranch) {
    throw new Error('Pull request identity changed since the merge task was created');
  }
}

export function assertPrMergeCloneIdentity(
  actual: { branch: string; originUrl: string; baseUrl: string },
  expected: { branch: string; originUrl: string; baseUrl: string },
): void {
  if (actual.branch !== expected.branch || actual.originUrl !== expected.originUrl
    || actual.baseUrl !== expected.baseUrl) {
    throw new Error('Saved PR merge clone identity or remotes changed');
  }
}
