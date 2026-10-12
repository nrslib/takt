import { confirmWithCancel } from '../../../shared/prompt/index.js';
import { error, info, success } from '../../../shared/ui/index.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../../shared/utils/gitBranchValidation.js';
import {
  detectDefaultBranch,
  getCurrentBranch,
  publishTaskBranch,
  resolveAutoCommitOptions,
  stageAndCommit,
  TaskRunner,
} from '../../../infra/task/index.js';
import type { StageAndCommitOptions } from '../../../infra/task/git.js';
import type { PrDetails } from '../../../core/workflow/system/pr-execution-context.js';
import { createPullRequestSafely, getGitProvider } from '../../../infra/git/index.js';
import { runGitCommandAbortable } from '../../../infra/task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../../infra/task/git-environment.js';
import { createPrCloneGitOperations } from '../../../infra/workflow/system/pr-clone-git.js';
import { checkForkThreats } from '../../merge/threat-check.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import {
  assertPrMergeCloneIdentity,
  assertSavedPrMergeIdentity,
  resolvePrMergeBaseRepositoryUrl,
} from '../../merge/pr-merge-identity.js';
import { findRunForTask, loadRunSessionContext } from '../../interactive/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { summarizeRunReports, formatRunReportSummary, type RunReportSummary } from './runReportSummary.js';
import { collectTaskWorktreeSummary, type TaskWorktreeSummary } from './taskWorktreeSummary.js';
import { validateWorktreeTarget } from './taskActionTarget.js';

interface TaskPullRequestBodyOptions {
  readonly taskKind: TaskListItem['kind'];
  readonly reportSummary: RunReportSummary | null;
  readonly worktreeSummary: string;
}

function resolveReportSummary(task: TaskListItem): RunReportSummary | null {
  if (!task.worktreePath) {
    return null;
  }
  const taskContent = task.data?.task;
  if (taskContent === undefined) {
    return null;
  }
  const runSlug = task.runSlug ?? findRunForTask(task.worktreePath, taskContent);
  if (!runSlug) {
    return null;
  }
  return summarizeRunReports(loadRunSessionContext(task.worktreePath, runSlug).reports);
}

export function buildTaskPullRequestBody(options: TaskPullRequestBodyOptions): string {
  const sections: string[] = [];
  if (options.reportSummary) {
    sections.push(formatRunReportSummary(options.reportSummary));
    if (options.taskKind === 'failed' && options.reportSummary.unverifiedGates.length > 0) {
      sections.push('後続ゲートは PR CI で実行します。');
    }
  }
  if (options.worktreeSummary.length > 0) {
    sections.push('## 作業ツリー差分', options.worktreeSummary);
  }
  return sections.join('\n\n');
}

function buildPullRequestTitle(task: TaskListItem): string {
  const firstContentLine = task.content.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  const title = task.summary?.trim() || firstContentLine;
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function displayPreview(
  branch: string,
  worktreeSummary: TaskWorktreeSummary,
  body: string,
  existingPrNumber?: number,
): void {
  const files = worktreeSummary.files.length > 0
    ? worktreeSummary.files.map(sanitizeTerminalText).join('\n')
    : '(コミット済み変更のみ)';
  if (existingPrNumber !== undefined) {
    info(`PR #${existingPrNumber} 更新プレビュー\nブランチ: ${sanitizeTerminalText(branch)}\nコミット対象ファイル:\n${files}`);
    return;
  }
  const previewBody = body.split('\n').map(sanitizeTerminalText).join('\n');
  info(`PR 作成プレビュー\nブランチ: ${sanitizeTerminalText(branch)}\nコミット対象ファイル:\n${files}\n\n本文:\n${previewBody}`);
}

async function publishExistingPrMergeTask(
  projectDir: string,
  task: TaskListItem & { worktreePath: string; branch: string },
  expectedDetails: PrDetails,
  baseRepositoryUrl: string,
  autoCommitOptions: StageAndCommitOptions,
): Promise<boolean> {
  const data = task.data!;
  const prNumber = data.pr_number!;
  const provider = getGitProvider();
  if (!provider.fetchPrDetails) throw new Error('The VCS provider does not support PR merge task publication');
  if (!expectedDetails.sameRepository) {
    const check = await checkForkThreats({
      cwd: task.worktreePath, projectCwd: projectDir,
      baseRef: toPullRequestBaseRef(expectedDetails.baseBranch),
      maxDiffBytes: data.merge_threat_check_max_diff_bytes!,
    });
    if (!check.passed) {
      error(sanitizeTerminalText(check.comment));
      return false;
    }
  }

  const latestBeforePush = await provider.fetchPrDetails(prNumber, projectDir);
  assertSavedPrMergeIdentity(data, latestBeforePush, prNumber);
  if (latestBeforePush.headSha !== expectedDetails.headSha) throw new Error('Pull request head changed before publication');
  const cloneGit = await createPrCloneGitOperations({
    cwd: task.worktreePath,
    headRepositoryUrl: latestBeforePush.headRepositoryUrl,
    headRepositoryPushUrls: latestBeforePush.headRepositoryPushUrls,
    baseRepositoryUrl,
    ...autoCommitOptions,
  });
  const env = await buildSafeGitEnvironment(task.worktreePath, autoCommitOptions);
  const pushedHeadSha = (await runGitCommandAbortable(task.worktreePath, ['rev-parse', 'HEAD'], undefined, env)).stdout.trim();
  new TaskRunner(projectDir).recordPrMergePushedHead(task.name, pushedHeadSha, expectedDetails.headSha);
  await cloneGit.operations.push(`HEAD:${toLocalBranchRef(task.branch)}`);
  const latest = await provider.fetchPrDetails(prNumber, projectDir);
  assertSavedPrMergeIdentity(data, latest, prNumber);
  if (latest.headSha !== pushedHeadSha) throw new Error('Pull request head changed during publication');

  success(`既存の PR #${prNumber} を更新しました。`);
  return true;
}

export async function createPullRequestForTask(
  projectDir: string,
  task: TaskListItem,
): Promise<boolean> {
  if (!task.branch) {
    error(`PR 作成を中止しました: タスク ${sanitizeTerminalText(task.name)} にブランチが設定されていません。`);
    return false;
  }
  if (!validateWorktreeTarget(task, 'PR creation')) {
    return false;
  }
  const worktreePath = task.worktreePath;
  const branch = task.branch;
  const mergeTask = task.data?.merge_task === true;
  let baseBranch: string;
  let mergeDetails: PrDetails | undefined;
  let mergeBaseRepositoryUrl: string | undefined;
  let worktreeSummary: TaskWorktreeSummary;
  let body: string;

  try {
    const currentBranch = getCurrentBranch(worktreePath);
    if (currentBranch === 'HEAD' || currentBranch !== branch) {
      error(`PR 作成を中止しました: worktree の現在ブランチ (${currentBranch}) と対象ブランチ (${branch}) が一致しません。`);
      return false;
    }
    if (mergeTask) {
      assertReusableWorktreePath(projectDir, worktreePath);
      const data = task.data!;
      const prNumber = data.pr_number!;
      const provider = getGitProvider();
      if (!provider.fetchPrDetails) throw new Error('The VCS provider does not support PR merge task publication');
      const details = await provider.fetchPrDetails(prNumber, projectDir);
      assertSavedPrMergeIdentity(data, details, prNumber);
      mergeDetails = details;
      mergeBaseRepositoryUrl = await resolvePrMergeBaseRepositoryUrl(projectDir);
      const env = await buildSafeGitEnvironment(worktreePath, { allowGitHooks: false, allowGitFilters: false });
      const git = (args: string[]) => runGitCommandAbortable(worktreePath, args, undefined, env);
      const originUrl = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
      const cloneBaseUrl = (await git(['remote', 'get-url', 'base'])).stdout.trim();
      assertPrMergeCloneIdentity(
        { branch: currentBranch, originUrl, baseUrl: cloneBaseUrl },
        { branch: details.headBranch, originUrl: details.headRepositoryUrl, baseUrl: mergeBaseRepositoryUrl },
      );
    }
    baseBranch = task.data?.base_branch ?? detectDefaultBranch(projectDir);
    worktreeSummary = collectTaskWorktreeSummary(worktreePath, baseBranch, branch);
    body = mergeTask ? '' : buildTaskPullRequestBody({
      taskKind: task.kind,
      reportSummary: resolveReportSummary(task),
      worktreeSummary: worktreeSummary.text,
    });
  } catch (err) {
    error(`PR 作成を中止しました: 準備に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  displayPreview(branch, worktreeSummary, body, mergeTask ? task.data!.pr_number : undefined);
  const confirmed = await confirmWithCancel(
    `${mergeTask ? '既存の PR を更新しますか' : 'PR を作成しますか'}: ${sanitizeTerminalText(task.name)}?`, false);
  if (confirmed.kind === 'cancelled' || !confirmed.value) {
    return false;
  }

  let autoCommitOptions: StageAndCommitOptions;
  try {
    autoCommitOptions = resolveAutoCommitOptions(projectDir);
    await stageAndCommit(
      worktreePath,
      `takt: ${task.name}`,
      autoCommitOptions,
    );
  } catch (err) {
    error(`PR 作成を中止しました: コミットに失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  if (mergeTask) {
    try {
      return await publishExistingPrMergeTask(
        projectDir, { ...task, worktreePath, branch }, mergeDetails!, mergeBaseRepositoryUrl!, autoCommitOptions,
      );
    } catch (err) {
      error(`PR の更新に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
      return false;
    }
  }

  try {
    publishTaskBranch(worktreePath, projectDir, branch);
  } catch (err) {
    error(`PR 作成を中止しました: ブランチの公開に失敗しました: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return false;
  }

  const gitProvider = getGitProvider();
  const existingPr = task.kind === 'pr_failed'
    ? gitProvider.findExistingPr(branch, projectDir)
    : undefined;
  const result = existingPr ? { success: true, url: existingPr.url } : createPullRequestSafely(gitProvider, {
    branch,
    title: buildPullRequestTitle(task),
    body,
    base: baseBranch,
    draft: task.data?.draft_pr,
  }, projectDir);

  if (!result.success) {
    error(`PR 作成に失敗しました: ${result.error}`);
    return false;
  }

  success(existingPr ? `既存の PR を使用します: ${result.url}` : `PR を作成しました: ${result.url}`);

  if (task.kind === 'pr_failed') {
    try {
      new TaskRunner(projectDir).completePublishedTask(task.name, result.url);
    } catch (err) {
      error(`PR は公開済みですが、タスク ${sanitizeTerminalText(task.name)} を completed として保存できませんでした: ${sanitizeTerminalText(getErrorMessage(err))}\ntakt list で状態を確認し、pr_failed の場合は Create PR で再試行してください。既存の PR を再利用します。`);
      return false;
    }
  }

  return true;
}
