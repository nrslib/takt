import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MergeConfig, MergeSettings } from '../../core/models/config-types.js';
import type { WorkflowPrListWhere } from '../../core/models/workflow-system-input-types.js';
import { matchesPrWhere } from '../../core/workflow/system/pr-matcher.js';
import { createPullRequestContext } from '../../core/workflow/pr-context.js';
import { getGitProvider } from '../../infra/git/index.js';
import type { PrListItem } from '../../infra/git/types.js';
import { isWorkflowPath, resolveConfigValue } from '../../infra/config/index.js';
import { cloneAndIsolateAbortable, runGitCommandAbortable } from '../../infra/task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../infra/task/git-environment.js';
import { createPrCloneGitOperations } from '../../infra/workflow/system/pr-clone-git.js';
import { fetchCodeRabbitCommitActivity, fetchCodeRabbitReviewStatus } from '../../infra/github/pr.js';
import { resolveCacciaSettings, runCaccia } from '../caccia/index.js';
import { checkForkThreats } from './threat-check.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../shared/utils/gitBranchValidation.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { runWorkflowExecution } from '../tasks/execute/workflowExecutionApi.js';
import type { ExecuteTaskOptions } from '../tasks/execute/types.js';

const log = createLogger('merge');

export function resolveMergeSettings(config: MergeConfig | undefined): MergeSettings {
  return {
    workflow: config?.workflow ?? 'merge-review-fix-simple',
    method: config?.method ?? 'squash',
    concurrency: config?.concurrency ?? 2,
    autoStart: config?.autoStart ?? false,
    includeDraft: config?.includeDraft ?? false,
    includeForks: config?.includeForks ?? false,
    threatCheckMaxDiffBytes: config?.threatCheckMaxDiffBytes ?? 200_000,
    ...(config?.where === undefined ? {} : { where: config.where }),
  };
}

type MergeDisplayOptions = Pick<ExecuteTaskOptions,
  'outputMode' | 'taskPrefix' | 'taskColorIndex' | 'taskDisplayLabel'>;

interface MergeOptions {
  readonly projectCwd: string;
  readonly settings: MergeSettings;
  readonly concurrency: number;
  readonly prNumber?: number;
  readonly workflow?: string;
  readonly where?: WorkflowPrListWhere;
  readonly includeDraft?: boolean;
  readonly includeForks?: boolean;
  readonly abortSignal?: AbortSignal;
  readonly display?: MergeDisplayOptions;
}

interface PrWorkflowRequest {
  readonly projectCwd: string;
  readonly prNumber: number;
  readonly workflow: string;
  readonly settings: MergeSettings;
  readonly abortSignal?: AbortSignal;
  readonly display?: MergeDisplayOptions;
}

interface MergeDependencies {
  readonly listOpenPrNumbers: (cwd: string) => number[];
  readonly fetchPrListItem: (prNumber: number, cwd: string) => PrListItem | undefined;
  readonly executePrWorkflow: (request: PrWorkflowRequest) => Promise<{ merged: boolean }>;
}

export async function executePrWorkflow(request: PrWorkflowRequest): Promise<{ merged: boolean }> {
  const provider = getGitProvider();
  const cli = provider.checkCliStatus(request.projectCwd);
  if (!cli.available) throw new Error(cli.error);
  if (!provider.fetchPrDetails || !provider.fetchPrStatus) {
    throw new Error('The VCS provider does not support PR merge workflow execution');
  }
  const details = await provider.fetchPrDetails(request.prNumber, request.projectCwd, request.abortSignal);
  if (details.number !== request.prNumber) throw new Error('PR metadata refers to a different PR');
  const prContext = createPullRequestContext({
    source: 'pr_review', prNumber: request.prNumber, baseBranch: details.baseBranch,
    headBranch: details.headBranch, baseBranchSource: 'pull_request',
    baseDiffRef: toPullRequestBaseRef(details.baseBranch), headDiffRef: toLocalBranchRef(details.headBranch),
  });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'takt-merge-'));
  const cwd = join(temporaryDirectory, 'clone');
  const cleanup = () => rmSync(temporaryDirectory, { recursive: true, force: true });
  process.once('exit', cleanup);
  try {
    await cloneAndIsolateAbortable(request.projectCwd, cwd, undefined, request.abortSignal);
    const gitSafety = resolveConfigValue(request.projectCwd, 'allowGitHooks');
    const allowGitFilters = resolveConfigValue(request.projectCwd, 'allowGitFilters');
    const env = await buildSafeGitEnvironment(cwd, {
      allowGitHooks: gitSafety, allowGitFilters: false,
    });
    const git = (args: string[]) => runGitCommandAbortable(cwd, args, request.abortSignal, env);
    const rootRemotes = await runGitCommandAbortable(request.projectCwd, ['remote'], request.abortSignal);
    const hasOrigin = rootRemotes.stdout.trim().split(/\s+/u).includes('origin');
    const baseUrl = hasOrigin
      ? (await runGitCommandAbortable(request.projectCwd, ['remote', 'get-url', 'origin'], request.abortSignal)).stdout.trim()
      : request.projectCwd;
    const cloneGit = await createPrCloneGitOperations({
      cwd,
      headRepositoryUrl: details.headRepositoryUrl, headRepositoryPushUrls: details.headRepositoryPushUrls,
      baseRepositoryUrl: baseUrl, allowGitHooks: gitSafety,
      allowGitFilters, abortSignal: request.abortSignal,
    });
    await git(['remote', 'add', 'origin', cloneGit.headRepositoryUrl]);
    for (const url of cloneGit.headRepositoryPushUrls) {
      await git(['remote', 'set-url', '--add', '--push', 'origin', url]);
    }
    const headRef = toLocalBranchRef(details.headBranch);
    await cloneGit.operations.fetch('origin', headRef);
    await git(['checkout', '-B', details.headBranch, 'FETCH_HEAD']);
    const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (headSha !== details.headSha) throw new Error('PR head changed during clone preparation');
    await git(['remote', 'add', 'base', cloneGit.baseRepositoryUrl]);
    await cloneGit.operations.fetch('base', `${toLocalBranchRef(details.baseBranch)}:${prContext.baseDiffRef}`);
    if (!details.sameRepository) {
      const check = await checkForkThreats({
        cwd, projectCwd: request.projectCwd, baseRef: prContext.baseDiffRef!,
        maxDiffBytes: request.settings.threatCheckMaxDiffBytes, abortSignal: request.abortSignal,
      });
      request.abortSignal?.throwIfAborted();
      if (!check.passed) {
        const comment = provider.commentOnPr(request.prNumber, check.comment, request.projectCwd);
        if (!comment.success) throw new Error(comment.error);
        return { merged: false };
      }
    }
    const cacciaSettings = resolveCacciaSettings(resolveConfigValue(request.projectCwd, 'caccia'));
    let pushedHeadRequiresCaccia = false;
    let approvedHeadSha: string | undefined;
    const prGitOperations = cacciaSettings.enabled ? {
      ...cloneGit.operations,
      push: async (refspec: string): Promise<void> => {
        pushedHeadRequiresCaccia = true;
        const previouslyApprovedHeadSha = approvedHeadSha ?? details.headSha;
        approvedHeadSha = undefined;
        const pushedHeadSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const presenceDeadlineAt = Date.now() + cacciaSettings.waitTimeoutMs;
        const previousReview = await fetchCodeRabbitReviewStatus(
          request.prNumber, request.projectCwd, presenceDeadlineAt, request.abortSignal,
        );
        if (previousReview !== undefined && previousReview.headSha !== previouslyApprovedHeadSha) {
          throw new Error('Pull request head changed before the merge workflow push');
        }
        let skipIfNoCodeRabbitActivity = false;
        if (previousReview !== undefined && !previousReview.hasCodeRabbitPost
          && !previousReview.hasCodeRabbitReviewActivity
          && !previousReview.hasCodeRabbitThreadReplyActivity
          && previousReview.reviewedHeadShas.length === 0) {
          const previousActivity = await fetchCodeRabbitCommitActivity(
            request.prNumber, request.projectCwd, previousReview.headSha, presenceDeadlineAt, request.abortSignal,
          );
          if (previousActivity !== undefined && previousActivity.headSha !== previousReview.headSha) {
            throw new Error('Pull request head changed while checking CodeRabbit activity');
          }
          skipIfNoCodeRabbitActivity = previousActivity?.detected === false;
        }
        await cloneGit.operations.push(refspec);
        const result = await runCaccia({
          entry: 'linked', prNumber: request.prNumber, projectCwd: request.projectCwd,
          settings: cacciaSettings, abortSignal: request.abortSignal,
          expectedInitialHeadSha: pushedHeadSha, skipIfNoCodeRabbitActivity, ...request.display,
        });
        if (result.outcome !== 'success'
          && !(result.outcome === 'skipped' && result.skipReason === 'no_coderabbit_activity'
            && skipIfNoCodeRabbitActivity)) {
          throw new Error(`Caccia did not complete for pull request #${request.prNumber}: ${result.reason ?? result.outcome}`);
        }
        const latest = await provider.fetchPrDetails!(request.prNumber, request.projectCwd, request.abortSignal);
        if (latest.number !== details.number || latest.headBranch !== details.headBranch
          || latest.baseBranch !== details.baseBranch || latest.headRepositoryUrl !== details.headRepositoryUrl) {
          throw new Error('Pull request identity changed during Caccia execution');
        }
        if (result.headSha === undefined || latest.headSha !== result.headSha) {
          throw new Error('Pull request head changed after Caccia review');
        }
        await cloneGit.operations.fetch('origin', headRef);
        await git(['merge', '--ff-only', 'FETCH_HEAD']);
        const updatedHeadSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        if (updatedHeadSha !== latest.headSha) {
          throw new Error('Pull request head changed during Caccia synchronization');
        }
        if (!details.sameRepository) {
          const check = await checkForkThreats({
            cwd, projectCwd: request.projectCwd, baseRef: prContext.baseDiffRef!,
            maxDiffBytes: request.settings.threatCheckMaxDiffBytes, abortSignal: request.abortSignal,
          });
          if (!check.passed) {
            const comment = provider.commentOnPr(request.prNumber, check.comment, request.projectCwd);
            if (!comment.success) throw new Error(comment.error);
            throw new Error('Fork threat check failed after Caccia changes');
          }
        }
        approvedHeadSha = updatedHeadSha;
      },
      assertMergeAllowed: (headSha: string): void => {
        if (pushedHeadRequiresCaccia && approvedHeadSha !== headSha) {
          throw new Error('PR merge is blocked until Caccia approves the pushed head');
        }
      },
    } : cloneGit.operations;
    const result = await runWorkflowExecution({
      ...request.display,
      cwd, projectCwd: request.projectCwd,
      workflowIdentifier: isWorkflowPath(request.workflow)
        ? request.workflow.startsWith('~')
          ? resolve(homedir(), request.workflow.slice(1).replace(/^\//u, ''))
          : resolve(request.projectCwd, request.workflow)
        : request.workflow,
      task: `Evaluate pull request #${request.prNumber} using this workflow. Review the cumulative PR diff and record the outcome on the PR.`,
      prContext, prExecutionContext: {
        prNumber: request.prNumber, headBranch: details.headBranch, baseBranch: details.baseBranch, headSha: details.headSha,
        headRepositoryUrl: cloneGit.headRepositoryUrl, headRepositoryPushUrls: cloneGit.headRepositoryPushUrls,
      },
      prGitOperations,
      mergeMethod: request.settings.method, abortSignal: request.abortSignal,
      runPathsDirectory: join(request.projectCwd, '.takt', 'runs'),
      skipWorktreeRuntimeProtection: true,
    });
    if (!result.success) log.error('PR workflow failed', { prNumber: request.prNumber });
    return { merged: (await provider.fetchPrStatus(request.prNumber, request.projectCwd,
      { signal: request.abortSignal })).merged };
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}

export async function runMerge(
  options: MergeOptions,
  dependencies: MergeDependencies = {
    listOpenPrNumbers: (cwd) => {
      const provider = getGitProvider();
      if (!provider.listOpenPrNumbers || !provider.fetchPrListItem) {
        throw new Error('The VCS provider does not support bulk PR merge workflow execution');
      }
      return provider.listOpenPrNumbers(cwd);
    },
    fetchPrListItem: (prNumber, cwd) => {
      const provider = getGitProvider();
      if (!provider.fetchPrListItem) {
        throw new Error('The VCS provider does not support bulk PR merge workflow execution');
      }
      return provider.fetchPrListItem(prNumber, cwd);
    },
    executePrWorkflow,
  },
): Promise<{ processedCount: number; mergedCount: number; exitCode: number }> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Merge concurrency must be a positive integer');
  }
  if (options.prNumber !== undefined && (!Number.isSafeInteger(options.prNumber) || options.prNumber < 1)) {
    throw new Error('PR number must be a positive safe integer');
  }
  const cliConditions = options.where !== undefined || options.includeDraft !== undefined || options.includeForks !== undefined;
  const where = { ...(cliConditions ? options.where : options.settings.where) };
  const includeDraft = cliConditions ? options.includeDraft === true : options.settings.includeDraft;
  const includeForks = cliConditions ? options.includeForks === true : options.settings.includeForks;
  const numbers = options.prNumber !== undefined ? [options.prNumber]
    : dependencies.listOpenPrNumbers(options.projectCwd);
  const workflow = options.workflow ?? options.settings.workflow;
  const running = new Set<Promise<void>>();
  let notifyCompletion: (() => void) | undefined;
  let processedCount = 0;
  let mergedCount = 0;

  const execute = async (prNumber: number): Promise<void> => {
    try {
      const result = await dependencies.executePrWorkflow({
        projectCwd: options.projectCwd, prNumber, settings: options.settings,
        workflow, abortSignal: options.abortSignal,
        display: options.display,
      });
      if (result.merged) mergedCount += 1;
    } catch (error) {
      log.error('PR merge workflow failed', { prNumber, error: getErrorMessage(error) });
    }
    processedCount += 1;
  };

  try {
    for (const prNumber of numbers) {
      if (options.prNumber === undefined) {
        let pr: PrListItem | undefined;
        try {
          pr = dependencies.fetchPrListItem(prNumber, options.projectCwd);
        } catch (error) {
          log.error('PR details could not be fetched', { prNumber, error: getErrorMessage(error) });
          processedCount += 1;
          continue;
        }
        if (pr === undefined || !((includeDraft || !pr.draft)
          && (includeForks || pr.same_repository === true) && matchesPrWhere(pr, where))) continue;
      }
      const execution = execute(prNumber).finally(() => {
        running.delete(execution);
        notifyCompletion?.();
      });
      running.add(execution);
      if (running.size >= options.concurrency) {
        await new Promise<void>((resolve) => { notifyCompletion = resolve; });
        notifyCompletion = undefined;
      }
    }
  } finally {
    await Promise.all(running);
  }
  return { processedCount, mergedCount, exitCode: mergedCount === processedCount ? 0 : 1 };
}

export async function runLinkedMergeSafely(
  projectCwd: string,
  prUrl: string,
  abortSignal?: AbortSignal,
  display?: MergeDisplayOptions,
): Promise<void> {
  try {
    const settings = resolveMergeSettings(resolveConfigValue(projectCwd, 'merge'));
    if (!settings.autoStart) return;
    const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/u.exec(prUrl);
    const prNumber = Number(match?.[1]);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('Invalid GitHub PR URL');
    const result = await runMerge({
      projectCwd, prNumber, settings, concurrency: settings.concurrency, abortSignal, display,
    });
    if (result.exitCode !== 0) log.error('Linked merge workflow left the PR unmerged', { prUrl });
  } catch (error) {
    log.error('Linked merge workflow failed', { prUrl, error: getErrorMessage(error) });
  }
}
