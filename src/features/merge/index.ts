import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { resolveCacciaSettings, runCaccia } from '../caccia/index.js';
import { checkForkThreats } from './threat-check.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../shared/utils/gitBranchValidation.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { runWorkflowExecution } from '../tasks/execute/workflowExecutionApi.js';
import type { ExecuteTaskOptions } from '../tasks/execute/types.js';
import { TaskRunner, resolveCloneBaseDir } from '../../infra/task/index.js';
import { createTaskClonePath } from '../../infra/task/clone-path.js';
import type { TaskInfo } from '../../infra/task/index.js';
import { assertReusableWorktreePath } from '../tasks/execute/reusedWorktree.js';
import { generateReportDir } from '../../shared/utils/reportDir.js';

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
  readonly parentTaskName?: string;
}

interface PrWorkflowRequest {
  readonly projectCwd: string;
  readonly prNumber: number;
  readonly workflow: string;
  readonly settings: MergeSettings;
  readonly abortSignal?: AbortSignal;
  readonly display?: MergeDisplayOptions;
  readonly parentTaskName?: string;
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
  const cacciaRequired = resolveCacciaSettings(resolveConfigValue(request.projectCwd, 'caccia')).enabled;
  const cloneBase = resolveCloneBaseDir(request.projectCwd);
  mkdirSync(cloneBase, { recursive: true });
  const worktreePath = createTaskClonePath(cloneBase, new Date().toISOString().replace(/[-:.]/gu, '').slice(0, 13),
    undefined, `merge-pr-${request.prNumber}`);
  const runner = new TaskRunner(request.projectCwd);
  const task = runner.startPrMergeTask({
    prNumber: request.prNumber, headBranch: details.headBranch, baseBranch: details.baseBranch,
    headSha: details.headSha, headRepositoryUrl: details.headRepositoryUrl,
    headRepositoryPushUrls: details.headRepositoryPushUrls,
    workflow: request.workflow, method: request.settings.method, worktreePath,
    threatCheckMaxDiffBytes: request.settings.threatCheckMaxDiffBytes,
    cacciaRequired,
    parentTaskName: request.parentTaskName,
  });
  return executePersistedPrMergeTask(task, runner, request.projectCwd, request.abortSignal, request.display);
}

export async function executePersistedPrMergeTask(
  task: TaskInfo, runner: TaskRunner, projectCwd: string,
  abortSignal?: AbortSignal, display?: MergeDisplayOptions,
): Promise<{ merged: boolean }> {
  const data = task.data;
  if (data?.merge_task !== true || data.pr_number === undefined || data.workflow === undefined
    || data.merge_method === undefined || task.worktreePath === undefined) {
    throw new Error(`Task ${task.name} is not a saved PR merge task`);
  }
  const startedAt = new Date().toISOString();
  const runSlug = generateReportDir(task.content);
  const runningTask = runner.updateRunningTaskExecution(task.name, {
    runSlug, worktreePath: task.worktreePath, branch: data.branch,
  });
  try {
    const settings = resolveMergeSettings(resolveConfigValue(projectCwd, 'merge'));
    const result = await runPrMergeWorkflow({
      projectCwd, prNumber: data.pr_number, workflow: data.workflow,
      settings: { ...settings, method: data.merge_method,
        threatCheckMaxDiffBytes: data.merge_threat_check_max_diff_bytes ?? settings.threatCheckMaxDiffBytes },
      abortSignal, display,
    }, runningTask, runner, runSlug);
    if (!result.merged) {
      runner.failTask({ task: runningTask, success: false,
        response: `PR #${data.pr_number} remains unmerged; inspect ${task.name} with takt list`,
        executionLog: [], startedAt, completedAt: new Date().toISOString(),
        branch: data.branch, worktreePath: task.worktreePath });
      return result;
    }
    runner.completeTask({ task: runningTask, success: true, response: 'PR merged',
      executionLog: [], startedAt, completedAt: new Date().toISOString(),
      branch: data.branch, worktreePath: task.worktreePath });
    try {
      assertReusableWorktreePath(projectCwd, task.worktreePath);
      rmSync(task.worktreePath, { recursive: true, force: true });
      runner.clearCompletedPrMergeWorktree(task.name);
    } catch (cleanupError) {
      log.error('Merged PR clone cleanup failed; the completed task retains its clone path', {
        prNumber: data.pr_number, taskName: task.name, error: getErrorMessage(cleanupError),
      });
    }
    return { merged: true };
  } catch (error) {
    const current = runner.listAllTaskItems().find((item) => item.name === task.name);
    if (current?.kind === 'running') {
      runner.failTask({ task: runningTask, success: false, response: getErrorMessage(error),
        executionLog: [], startedAt, completedAt: new Date().toISOString(),
        branch: data.branch, worktreePath: task.worktreePath });
    }
    throw error;
  }
}

async function runPrMergeWorkflow(
  request: PrWorkflowRequest, task: TaskInfo, runner: TaskRunner, runSlug: string,
): Promise<{ merged: boolean }> {
  const provider = getGitProvider();
  if (!provider.fetchPrDetails || !provider.fetchPrStatus) throw new Error('The VCS provider does not support PR merge workflow execution');
  const details = await provider.fetchPrDetails(request.prNumber, request.projectCwd, request.abortSignal);
  const data = task.data;
  if (data?.merge_head_repository_url !== details.headRepositoryUrl
    || JSON.stringify(data.merge_head_repository_push_urls) !== JSON.stringify(details.headRepositoryPushUrls)
    || data.merge_initial_head_sha === undefined
    || details.number !== request.prNumber || data.branch !== details.headBranch || data.base_branch !== details.baseBranch) {
    throw new Error('Pull request identity changed since the merge task was created');
  }
  const prContext = createPullRequestContext({
    source: 'pr_review', prNumber: request.prNumber, baseBranch: details.baseBranch,
    headBranch: details.headBranch, baseBranchSource: 'pull_request',
    baseDiffRef: toPullRequestBaseRef(details.baseBranch), headDiffRef: toLocalBranchRef(details.headBranch),
  });
  const cwd = task.worktreePath!;
  const isRetry = data.merge_clone_prepared === true;
  if (isRetry) {
    assertReusableWorktreePath(request.projectCwd, cwd);
  } else if (existsSync(cwd)) {
    assertReusableWorktreePath(request.projectCwd, cwd);
    const gitDirectory = join(cwd, '.git');
    if (existsSync(gitDirectory)) {
      if (!lstatSync(gitDirectory).isDirectory()) {
        throw new Error('Incomplete PR merge clone has an invalid Git directory');
      }
      const preparationEnv = await buildSafeGitEnvironment(cwd, {
        allowGitHooks: resolveConfigValue(request.projectCwd, 'allowGitHooks'), allowGitFilters: false,
      });
      const preparationGit = (args: string[]) => runGitCommandAbortable(cwd, args, request.abortSignal, preparationEnv);
      const status = await preparationGit(['status', '--porcelain=v1', '--untracked-files=all']);
      const ignoredFiles = await preparationGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
      const mergeHeadPath = (await preparationGit(['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim();
      if (status.stdout !== '' || ignoredFiles.stdout !== '' || existsSync(resolve(cwd, mergeHeadPath))) {
        throw new Error('Incomplete PR merge clone has local changes or an unfinished merge');
      }
      const cloneHead = (await preparationGit(['rev-parse', 'HEAD'])).stdout.trim();
      const projectHead = (await runGitCommandAbortable(request.projectCwd,
        ['rev-parse', 'HEAD'], request.abortSignal)).stdout.trim();
      if (cloneHead !== projectHead && cloneHead !== data.merge_initial_head_sha) {
        throw new Error('Incomplete PR merge clone has local commits');
      }
    } else if (readdirSync(cwd).length > 0) {
      throw new Error('Incomplete PR merge clone contains files outside Git');
    }
    rmSync(cwd, { recursive: true, force: true });
  }
  if (!isRetry) {
    mkdirSync(dirname(cwd), { recursive: true });
    await cloneAndIsolateAbortable(request.projectCwd, cwd, undefined, request.abortSignal);
  }
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
  const headRef = toLocalBranchRef(details.headBranch);
  if (!isRetry) {
    await git(['remote', 'add', 'origin', cloneGit.headRepositoryUrl]);
    for (const url of cloneGit.headRepositoryPushUrls) {
      await git(['remote', 'set-url', '--add', '--push', 'origin', url]);
    }
    await cloneGit.operations.fetch('origin', headRef);
    await git(['checkout', '-B', details.headBranch, 'FETCH_HEAD']);
    await git(['remote', 'add', 'base', cloneGit.baseRepositoryUrl]);
    await cloneGit.operations.fetch('base', `${toLocalBranchRef(details.baseBranch)}:${prContext.baseDiffRef}`);
  } else {
    const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    const originUrl = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
    const baseRemoteUrl = (await git(['remote', 'get-url', 'base'])).stdout.trim();
    if (branch !== details.headBranch || originUrl !== cloneGit.headRepositoryUrl
      || baseRemoteUrl !== cloneGit.baseRepositoryUrl) {
      throw new Error('Saved PR merge clone identity or remotes changed');
    }
  }
  const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const configuredCacciaSettings = resolveCacciaSettings(resolveConfigValue(request.projectCwd, 'caccia'));
  const cacciaRequired = data.merge_caccia_required === true || configuredCacciaSettings.enabled;
  const cacciaSettings = { ...configuredCacciaSettings, enabled: cacciaRequired };
  if (isRetry ? details.headSha !== data.merge_initial_head_sha
      && details.headSha !== data.merge_push_base_head_sha
      && details.headSha !== data.merge_pushed_head_sha
      && (cacciaRequired || details.headSha !== headSha)
    : headSha !== details.headSha) throw new Error('PR head changed since clone preparation');
  if (!isRetry) runner.recordPrMergeClonePrepared(task.name);
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
  let pushedHeadRequiresCaccia = data.merge_pushed_head_sha !== undefined;
  let approvedHeadSha = data.merge_caccia_approved_head_sha;
  let remoteHeadSha = details.headSha;
  const completeCacciaHandoff = async (pushedHeadSha: string): Promise<void> => {
    const result = await runCaccia({
      entry: 'linked', prNumber: request.prNumber, projectCwd: request.projectCwd,
      settings: cacciaSettings, abortSignal: request.abortSignal,
      expectedInitialHeadSha: pushedHeadSha, ...request.display,
      onPushedHead: (cacciaHeadSha) => {
        runner.recordPrMergePushedHead(task.name, cacciaHeadSha, remoteHeadSha);
        remoteHeadSha = cacciaHeadSha;
      },
    });
    if (result.outcome !== 'success') {
      throw new Error(`Caccia did not complete for pull request #${request.prNumber}: ${result.reason ?? result.outcome}`);
    }
    const latest = await provider.fetchPrDetails!(request.prNumber, request.projectCwd, request.abortSignal);
    if (latest.number !== details.number || latest.headBranch !== details.headBranch
      || latest.baseBranch !== details.baseBranch || latest.headRepositoryUrl !== details.headRepositoryUrl
      || JSON.stringify(latest.headRepositoryPushUrls) !== JSON.stringify(details.headRepositoryPushUrls)) {
      throw new Error('Pull request identity changed during Caccia execution');
    }
    if (result.headSha === undefined || latest.headSha !== result.headSha) {
      throw new Error('Pull request head changed after Caccia review');
    }
    await cloneGit.operations.fetch('origin', headRef);
    if ((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== latest.headSha) {
      throw new Error('Pull request head changed during Caccia synchronization');
    }
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
    runner.recordPrMergeCacciaApproval(task.name, updatedHeadSha);
    approvedHeadSha = updatedHeadSha;
    remoteHeadSha = updatedHeadSha;
  };
  if (cacciaRequired && pushedHeadRequiresCaccia && approvedHeadSha === undefined) {
    const pendingHeadSha = data.merge_pushed_head_sha!;
    if (details.headSha === pendingHeadSha && headSha !== pendingHeadSha) {
      await cloneGit.operations.fetch('origin', headRef);
      if ((await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim() !== pendingHeadSha) {
        throw new Error('Pull request head changed during pending Caccia synchronization');
      }
      await git(['merge', '--ff-only', 'FETCH_HEAD']);
      if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== pendingHeadSha) {
        throw new Error('Pull request head changed during pending Caccia synchronization');
      }
    } else if (details.headSha !== pendingHeadSha) {
      if (details.headSha !== (data.merge_push_base_head_sha ?? data.merge_initial_head_sha)
        || headSha !== pendingHeadSha) {
        throw new Error('Pull request head changed before Caccia retry');
      }
      await cloneGit.operations.push(`HEAD:${headRef}`);
      const latest = await provider.fetchPrDetails(request.prNumber, request.projectCwd, request.abortSignal);
      if (latest.number !== details.number || latest.headBranch !== details.headBranch
        || latest.baseBranch !== details.baseBranch || latest.headRepositoryUrl !== details.headRepositoryUrl
        || JSON.stringify(latest.headRepositoryPushUrls) !== JSON.stringify(details.headRepositoryPushUrls)
        || latest.headSha !== pendingHeadSha) {
        throw new Error('Pull request head changed during pending push recovery');
      }
      remoteHeadSha = latest.headSha;
    }
    await completeCacciaHandoff(data.merge_pushed_head_sha!);
  }
  const prGitOperations = cacciaRequired ? {
    ...cloneGit.operations,
    push: async (refspec: string): Promise<void> => {
      const pushedHeadSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      runner.recordPrMergePushedHead(task.name, pushedHeadSha, remoteHeadSha);
      pushedHeadRequiresCaccia = true;
      approvedHeadSha = undefined;
      await cloneGit.operations.push(refspec);
      remoteHeadSha = pushedHeadSha;
      await completeCacciaHandoff(pushedHeadSha);
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
    task: task.content,
    reportDirName: runSlug,
    ...(data.start_step === undefined ? {} : { startStep: data.start_step }),
    ...(data.retry_note === undefined ? {} : { retryNote: data.retry_note }),
    ...(data.resume_point === undefined ? {} : { resumePoint: data.resume_point }),
    ...(data.restart_point === undefined ? {} : { restartPoint: data.restart_point }),
    ...(task.resumeMode === undefined ? {} : { resumeSource: {
      ...(task.sourceRunSlug === undefined ? {} : { sourceRunSlug: task.sourceRunSlug }),
      resumeMode: task.resumeMode,
    } }),
    prContext, prExecutionContext: {
      prNumber: request.prNumber, headBranch: details.headBranch, baseBranch: details.baseBranch,
      headSha: approvedHeadSha ?? headSha,
      headRepositoryUrl: cloneGit.headRepositoryUrl, headRepositoryPushUrls: cloneGit.headRepositoryPushUrls,
      preserveConflictState: true,
    },
    prGitOperations,
    mergeMethod: request.settings.method, abortSignal: request.abortSignal,
    runPathsDirectory: join(request.projectCwd, '.takt', 'runs'),
    skipWorktreeRuntimeProtection: true,
  });
  if (!result.success) log.error('PR workflow failed', { prNumber: request.prNumber });
  return { merged: (await provider.fetchPrStatus(request.prNumber, request.projectCwd,
    { signal: request.abortSignal })).merged };
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
        parentTaskName: options.parentTaskName,
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
  parentTaskName?: string,
): Promise<void> {
  try {
    const settings = resolveMergeSettings(resolveConfigValue(projectCwd, 'merge'));
    if (!settings.autoStart) return;
    const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/u.exec(prUrl);
    const prNumber = Number(match?.[1]);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('Invalid GitHub PR URL');
    const result = await runMerge({
      projectCwd, prNumber, settings, concurrency: settings.concurrency, abortSignal, display, parentTaskName,
    });
    if (result.exitCode !== 0) log.error('Linked merge workflow left the PR unmerged', { prUrl });
  } catch (error) {
    log.error('Linked merge workflow failed', { prUrl, error: getErrorMessage(error) });
  }
}
