import { confirm } from '../../../shared/prompt/index.js';
import { error, info, success } from '../../../shared/ui/index.js';
import {
  detectDefaultBranch,
  getCurrentBranch,
  publishTaskBranch,
  resolveAutoCommitOptions,
  stageAndCommit,
} from '../../../infra/task/index.js';
import { createPullRequestSafely, getGitProvider } from '../../../infra/git/index.js';
import { findRunForTask, loadRunSessionContext } from '../../interactive/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';
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
  const title = task.summary?.trim() || task.content.trim();
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function displayPreview(
  branch: string,
  worktreeSummary: TaskWorktreeSummary,
  body: string,
): void {
  const files = worktreeSummary.files.length > 0
    ? worktreeSummary.files.map(sanitizeTerminalText).join('\n')
    : '(コミット済み変更のみ)';
  const previewBody = body.split('\n').map(sanitizeTerminalText).join('\n');
  info(`PR 作成プレビュー\nブランチ: ${sanitizeTerminalText(branch)}\nコミット対象ファイル:\n${files}\n\n本文:\n${previewBody}`);
}

export async function createPullRequestForTask(
  projectDir: string,
  task: TaskListItem,
): Promise<boolean> {
  if (!task.branch) {
    error(`PR 作成を中止しました: タスク ${task.name} にブランチが設定されていません。`);
    return false;
  }
  if (!validateWorktreeTarget(task, 'PR creation')) {
    return false;
  }
  const worktreePath = task.worktreePath;
  const branch = task.branch;
  const currentBranch = getCurrentBranch(worktreePath);
  if (currentBranch === 'HEAD' || currentBranch !== branch) {
    error(`PR 作成を中止しました: worktree の現在ブランチ (${currentBranch}) と対象ブランチ (${branch}) が一致しません。`);
    return false;
  }
  const baseBranch = task.data?.base_branch ?? detectDefaultBranch(projectDir);
  const worktreeSummary = collectTaskWorktreeSummary(worktreePath, baseBranch, branch);
  const reportSummary = resolveReportSummary(task);
  const body = buildTaskPullRequestBody({
    taskKind: task.kind,
    reportSummary,
    worktreeSummary: worktreeSummary.text,
  });

  displayPreview(branch, worktreeSummary, body);
  if (!await confirm(`PR を作成しますか: ${task.name}?`, false)) {
    return false;
  }

  await stageAndCommit(
    worktreePath,
    `takt: ${task.name}`,
    resolveAutoCommitOptions(projectDir),
  );
  publishTaskBranch(worktreePath, projectDir, branch);

  const result = createPullRequestSafely(getGitProvider(), {
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

  success(`PR を作成しました: ${result.url}`);
  return true;
}
