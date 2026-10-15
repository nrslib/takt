import type { SystemStepServicesOptions } from '../../core/workflow/system/system-step-services.js';
import type { PullRequestContext } from '../../core/workflow/pr-context.js';
import { detectVcsProvider } from '../../infra/git/detect.js';
import type { PrDetails, PrExecutionContext } from '../../core/workflow/system/pr-execution-context.js';
import { getGitProvider, type GitProvider } from '../../infra/git/index.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { runGitCommandAbortable } from '../../infra/task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../infra/task/git-environment.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { createLogger } from '../../shared/utils/debug.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../shared/utils/gitBranchValidation.js';
import { checkForkThreats, toPublicThreatCheckComment } from '../merge/threat-check.js';
import { resolveMergeSettings } from '../merge/settings.js';
import { resolveCacciaSettings, runCaccia } from './index.js';
import type { CacciaDisplayOptions } from './output.js';

const log = createLogger('caccia-effect');

interface CacciaEffectOptions extends Omit<SystemStepServicesOptions, 'gitProvider'>, CacciaDisplayOptions {
  readonly gitProvider?: GitProvider;
  readonly prContext?: PullRequestContext;
}

function assertPrIdentity(context: PrExecutionContext, details: PrDetails): void {
  if (context.prNumber !== details.number || context.headBranch !== details.headBranch
    || context.baseBranch !== details.baseBranch || context.headRepositoryUrl !== details.headRepositoryUrl
    || JSON.stringify(context.headRepositoryPushUrls) !== JSON.stringify(details.headRepositoryPushUrls)) {
    throw new Error('Pull request identity changed during Caccia execution');
  }
}

export async function cacciaEffect(
  options: CacciaEffectOptions,
  prNumber: number,
): Promise<Record<string, unknown>> {
  try {
    const context = options.prExecutionContext;
    const prContext = context ?? options.prContext;
    if (!prContext || prContext.prNumber !== prNumber || options.cwd === options.projectCwd) {
      throw new Error('A matching isolated PR execution context is required');
    }
    const env = await buildSafeGitEnvironment(options.cwd, { ...options, allowGitFilters: false });
    const git = (args: string[]) => runGitCommandAbortable(options.cwd, args, options.abortSignal, env);
    if ((await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim() !== prContext.headBranch) {
      throw new Error('PR clone is on a different head branch');
    }
    const initialHeadSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const settings = resolveCacciaSettings(resolveConfigValue(options.projectCwd, 'caccia'));
    if (!settings.enabled) {
      return { success: true, failed: false, outcome: 'skipped', headSha: initialHeadSha,
        unresolvedCount: 0, skipReason: 'config_disabled', reason: 'Caccia is disabled in configuration' };
    }
    if ((resolveConfigValue(options.projectCwd, 'vcsProvider') ?? detectVcsProvider(options.projectCwd)) !== 'github') {
      return { success: true, failed: false, outcome: 'skipped', headSha: initialHeadSha,
        unresolvedCount: 0, skipReason: 'github_unavailable', reason: 'GitHub is required for the Caccia effect' };
    }
    if (!context) throw new Error('GitHub PR execution metadata is required for Caccia');
    const provider = options.gitProvider ?? getGitProvider();
    if (!provider.fetchPrDetails) throw new Error('PR details are not supported by this Git provider');
    const before = await provider.fetchPrDetails(prNumber, options.projectCwd, options.abortSignal);
    assertPrIdentity(context, before);
    if (before.headSha !== initialHeadSha) throw new Error('Pull request head changed before Caccia execution');
    let expectedHeadSha = initialHeadSha;
    const result = await runCaccia({
      entry: 'linked', prNumber, projectCwd: options.projectCwd, settings,
      expectedInitialHeadSha: initialHeadSha, abortSignal: options.abortSignal,
      onPushedHead: (headSha) => {
        options.prMergePushRecorder?.record(headSha, expectedHeadSha, context);
        expectedHeadSha = headSha;
      },
      outputMode: options.outputMode, taskPrefix: options.taskPrefix,
      taskColorIndex: options.taskColorIndex, taskDisplayLabel: options.taskDisplayLabel,
    });
    if (result.outcome === 'not_run') throw new Error('Enabled Caccia did not execute');
    if (result.skipReason === 'github_unavailable') {
      return { success: true, failed: false, outcome: result.outcome, headSha: initialHeadSha,
        unresolvedCount: result.unresolvedCount, skipReason: result.skipReason, reason: result.reason ?? null };
    }
    const latest = await provider.fetchPrDetails(prNumber, options.projectCwd, options.abortSignal);
    assertPrIdentity(context, latest);
    // 初回待機だけで終了した結果にはpushがないため、開始時のheadを検証して補う。
    if (result.headSha === undefined && result.skipReason !== 'initial_review_unavailable') {
      throw new Error('Caccia result is missing its head SHA');
    }
    const headSha = result.headSha ?? initialHeadSha;
    if (headSha !== expectedHeadSha || latest.headSha !== headSha) throw new Error('Pull request head changed after Caccia review');
    if (headSha !== initialHeadSha) {
      if (!options.prGitOperations) throw new Error('PR Git operations are required for Caccia synchronization');
      await options.prGitOperations.fetch('origin', toLocalBranchRef(context.headBranch));
      if ((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== headSha) {
        throw new Error('Pull request head changed during Caccia synchronization');
      }
      await git(['merge', '--ff-only', 'FETCH_HEAD']);
      if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== headSha) {
        throw new Error('Pull request head changed during Caccia synchronization');
      }
      if (!latest.sameRepository) {
        await options.prGitOperations.fetch('base',
          `${toLocalBranchRef(context.baseBranch)}:${toPullRequestBaseRef(context.baseBranch)}`);
        const maxDiffBytes = context.threatCheckMaxDiffBytes
          ?? resolveMergeSettings(resolveConfigValue(options.projectCwd, 'merge')).threatCheckMaxDiffBytes;
        const check = await checkForkThreats({
          cwd: options.cwd, projectCwd: options.projectCwd, baseRef: toPullRequestBaseRef(context.baseBranch),
          maxDiffBytes, abortSignal: options.abortSignal,
        });
        options.abortSignal?.throwIfAborted();
        if (!check.passed) {
          const comment = provider.commentOnPr(prNumber, toPublicThreatCheckComment(check.comment), options.projectCwd);
          if (!comment.success) throw new Error(comment.error);
          throw new Error('Fork threat check failed after Caccia changes');
        }
      }
    }
    return { success: true, failed: false, outcome: result.outcome, headSha,
      unresolvedCount: result.unresolvedCount, skipReason: result.skipReason ?? null, reason: result.reason ?? null };
  } catch (error) {
    log.error('Caccia effect failed', { prNumber, error: getErrorMessage(error) });
    return { success: false, failed: true, error: safeExternalErrorMessage(error).replaceAll('@', '＠') };
  }
}
