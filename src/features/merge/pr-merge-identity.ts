import type { PrDetails } from '../../core/workflow/system/pr-execution-context.js';
import type { TaskFileData } from '../../infra/task/schema.js';
import { runGitCommandAbortable } from '../../infra/task/clone-exec.js';

export async function resolvePrMergeBaseRepositoryUrl(projectDir: string, signal?: AbortSignal): Promise<string> {
  const remotes = await runGitCommandAbortable(projectDir, ['remote'], signal);
  if (!remotes.stdout.trim().split(/\s+/u).includes('origin')) return projectDir;
  return (await runGitCommandAbortable(projectDir, ['remote', 'get-url', 'origin'], signal)).stdout.trim();
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
