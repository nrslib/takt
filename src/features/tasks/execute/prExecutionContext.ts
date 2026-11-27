import type { PullRequestContext } from '../../../core/workflow/pr-context.js';
import type { PrMergeOptions } from '../../../core/workflow/system/pr-execution-context.js';
import { detectVcsProvider } from '../../../infra/git/detect.js';
import { getGitProvider, type GitProvider } from '../../../infra/git/index.js';
import { resolveMergeSettings } from '../../merge/settings.js';
import { resolveConfigValue, resolveConfigValues } from '../../../infra/config/index.js';
import { createPrCloneGitOperations } from '../../../infra/workflow/system/pr-clone-git.js';
import { runGitCommandAbortable } from '../../../infra/task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../../infra/task/git-environment.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../../shared/utils/gitBranchValidation.js';
import { checkForkThreats, toPublicThreatCheckComment } from '../../merge/threat-check.js';
import { resolvePrMergeBaseRepositoryUrl } from '../../merge/pr-merge-identity.js';

export async function resolveTaskPrExecutionContext(
  options: PrMergeOptions & {
    readonly cwd: string;
    readonly projectCwd: string;
    readonly prContext?: PullRequestContext;
    readonly abortSignal?: AbortSignal;
    readonly gitProvider?: GitProvider;
  },
): Promise<PrMergeOptions> {
  if (options.prExecutionContext || !options.prContext || options.cwd === options.projectCwd) {
    return { prExecutionContext: options.prExecutionContext, prGitOperations: options.prGitOperations };
  }
  const provider = options.gitProvider ?? getGitProvider();
  if (!provider.fetchPrDetails) {
    if ((resolveConfigValue(options.projectCwd, 'vcsProvider') ?? detectVcsProvider(options.projectCwd)) !== 'github') {
      return { prExecutionContext: undefined, prGitOperations: options.prGitOperations };
    }
    throw new Error('PR details are not supported by this Git provider');
  }
  const context = options.prContext;
  const details = await provider.fetchPrDetails(context.prNumber, options.projectCwd, options.abortSignal);
  if (details.number !== context.prNumber || details.headBranch !== context.headBranch) {
    throw new Error('Pull request identity changed since the task was created');
  }
  const saved = options.cacciaPushedHead;
  if (saved && (saved.baseBranch !== details.baseBranch
    || saved.headRepositoryUrl !== details.headRepositoryUrl
    || JSON.stringify(saved.headRepositoryPushUrls) !== JSON.stringify(details.headRepositoryPushUrls))) {
    throw new Error('Pull request identity changed since Caccia pushed');
  }
  if (saved && saved.headSha !== details.headSha) {
    throw new Error('Pull request head changed since Caccia pushed');
  }
  const safety = resolveConfigValues(options.projectCwd, ['allowGitHooks', 'allowGitFilters']);
  const env = await buildSafeGitEnvironment(options.cwd, { ...safety, allowGitFilters: false });
  const git = (args: string[]) => runGitCommandAbortable(options.cwd, args, options.abortSignal, env);
  const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  if (branch !== details.headBranch) throw new Error('PR clone is on a different head branch');
  const cloneGit = await createPrCloneGitOperations({
    cwd: options.cwd, headRepositoryUrl: details.headRepositoryUrl,
    headRepositoryPushUrls: details.headRepositoryPushUrls,
    baseRepositoryUrl: await resolvePrMergeBaseRepositoryUrl(options.projectCwd, options.abortSignal),
    ...safety, abortSignal: options.abortSignal,
  });
  const settings = resolveMergeSettings(resolveConfigValue(options.projectCwd, 'merge'));
  if (saved) {
    await cloneGit.operations.fetch('origin', toLocalBranchRef(details.headBranch));
    if ((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== saved.headSha) {
      throw new Error('Pull request head changed during Caccia retry synchronization');
    }
    await git(['merge', '--ff-only', 'FETCH_HEAD']);
    if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== saved.headSha) {
      throw new Error('Pull request head changed during Caccia retry synchronization');
    }
    if (!details.sameRepository) {
      const baseRef = toPullRequestBaseRef(details.baseBranch);
      await cloneGit.operations.fetch('base', `${toLocalBranchRef(details.baseBranch)}:${baseRef}`);
      const check = await checkForkThreats({
        cwd: options.cwd, projectCwd: options.projectCwd, baseRef,
        maxDiffBytes: settings.threatCheckMaxDiffBytes, abortSignal: options.abortSignal,
      });
      options.abortSignal?.throwIfAborted();
      if (!check.passed) {
        const comment = provider.commentOnPr(context.prNumber,
          toPublicThreatCheckComment(check.comment), options.projectCwd);
        if (!comment.success) throw new Error(comment.error);
        throw new Error('Fork threat check failed after Caccia changes');
      }
    }
  }
  return { prExecutionContext: {
    prNumber: context.prNumber, headBranch: details.headBranch, baseBranch: details.baseBranch,
    headSha: details.headSha, headRepositoryUrl: cloneGit.headRepositoryUrl,
    headRepositoryPushUrls: cloneGit.headRepositoryPushUrls,
    threatCheckMaxDiffBytes: settings.threatCheckMaxDiffBytes,
  }, prGitOperations: cloneGit.operations };
}
