/**
 * add command implementation
 *
 * Starts an AI conversation to refine task requirements,
 * then appends a task record to .takt/tasks.yaml.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { promptInput, confirm } from '../../../shared/prompt/index.js';
import { success, info, error } from '../../../shared/ui/index.js';
import { TaskRunner, type TaskFileData } from '../../../infra/task/index.js';
import { getPieceDescription, loadGlobalConfig } from '../../../infra/config/index.js';
import { determinePiece } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage, generateReportDir } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers, createIssue } from '../../../infra/github/index.js';
import { interactiveMode } from '../../interactive/index.js';

const log = createLogger('add-task');

function resolveUniqueTaskSlug(cwd: string, baseSlug: string): string {
  let sequence = 1;
  let slug = baseSlug;
  let taskDir = path.join(cwd, '.takt', 'tasks', slug);
  while (fs.existsSync(taskDir)) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
    taskDir = path.join(cwd, '.takt', 'tasks', slug);
  }
  return slug;
}

/**
 * Save a task entry to .takt/tasks.yaml.
 *
 * Common logic extracted from addTask(). Used by both addTask()
 * and saveTaskFromInteractive().
 */
export async function saveTaskFile(
  cwd: string,
  taskContent: string,
  options?: { piece?: string; issue?: number; worktree?: boolean | string; branch?: string; autoPr?: boolean },
): Promise<{ taskName: string; tasksFile: string }> {
  const runner = new TaskRunner(cwd);
  const taskSlug = resolveUniqueTaskSlug(cwd, generateReportDir(taskContent));
  const taskDir = path.join(cwd, '.takt', 'tasks', taskSlug);
  const taskDirRelative = `.takt/tasks/${taskSlug}`;
  const orderPath = path.join(taskDir, 'order.md');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(orderPath, taskContent, 'utf-8');
  const config: Omit<TaskFileData, 'task'> = {
    ...(options?.worktree !== undefined && { worktree: options.worktree }),
    ...(options?.branch && { branch: options.branch }),
    ...(options?.piece && { piece: options.piece }),
    ...(options?.issue !== undefined && { issue: options.issue }),
    ...(options?.autoPr !== undefined && { auto_pr: options.autoPr }),
  };
  const created = runner.addTask(taskContent, {
    ...config,
    task_dir: taskDirRelative,
  });
  const tasksFile = path.join(cwd, '.takt', 'tasks.yaml');
  log.info('Task created', { taskName: created.name, tasksFile, config });
  return { taskName: created.name, tasksFile };
}

/**
 * Create a GitHub Issue from a task description.
 *
 * Extracts the first line as the issue title (truncated to 100 chars),
 * uses the full task as the body, and displays success/error messages.
 */
export function createIssueFromTask(task: string): number | undefined {
  info('Creating GitHub Issue...');
  const firstLine = task.split('\n')[0] || task;
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
  const issueResult = createIssue({ title, body: task });
  if (issueResult.success) {
    success(`Issue created: ${issueResult.url}`);
    const num = Number(issueResult.url!.split('/').pop());
    if (Number.isNaN(num)) {
      error('Failed to extract issue number from URL');
      return undefined;
    }
    return num;
  } else {
    error(`Failed to create issue: ${issueResult.error}`);
    return undefined;
  }
}

interface WorktreeSettings {
  worktree?: boolean | string;
  branch?: string;
  autoPr?: boolean;
}

function displayTaskCreationResult(
  created: { taskName: string; tasksFile: string },
  settings: WorktreeSettings,
  piece?: string,
): void {
  success(`Task created: ${created.taskName}`);
  info(`  File: ${created.tasksFile}`);
  if (settings.worktree) {
    info(`  Worktree: ${typeof settings.worktree === 'string' ? settings.worktree : 'auto'}`);
  }
  if (settings.branch) {
    info(`  Branch: ${settings.branch}`);
  }
  if (settings.autoPr) {
    info(`  Auto-PR: yes`);
  }
  if (piece) info(`  Piece: ${piece}`);
}

/**
 * Create a GitHub Issue and save the task to .takt/tasks.yaml.
 *
 * Combines issue creation and task saving into a single workflow.
 * If issue creation fails, no task is saved.
 */
export async function createIssueAndSaveTask(cwd: string, task: string, piece?: string): Promise<void> {
  const issueNumber = createIssueFromTask(task);
  if (issueNumber !== undefined) {
    await saveTaskFromInteractive(cwd, task, piece, { issue: issueNumber });
  }
}

async function promptWorktreeSettings(): Promise<WorktreeSettings> {
  const useWorktree = await confirm('Create worktree?', true);
  if (!useWorktree) {
    return {};
  }

  const customPath = await promptInput('Worktree path (Enter for auto)');
  const worktree: boolean | string = customPath || true;

  const customBranch = await promptInput('Branch name (Enter for auto)');
  const branch = customBranch || undefined;

  const autoPr = await confirm('Auto-create PR?', true);

  return { worktree, branch, autoPr };
}

/**
 * Save a task from interactive mode result.
 * Prompts for worktree/branch/auto_pr settings before saving.
 */
export async function saveTaskFromInteractive(
  cwd: string,
  task: string,
  piece?: string,
  options?: { issue?: number },
): Promise<void> {
  const settings = await promptWorktreeSettings();
  const created = await saveTaskFile(cwd, task, { piece, issue: options?.issue, ...settings });
  displayTaskCreationResult(created, settings, piece);
}

/**
 * add command handler
 *
 * Flow:
 *   A) Issue参照の場合: issue取得 → ピース選択 → ワークツリー設定 → YAML作成
 *   B) それ以外: ピース選択 → AI対話モード → ワークツリー設定 → YAML作成
 */
export async function addTask(cwd: string, task?: string): Promise<void> {
  // ピース選択とタスク内容の決定
  let taskContent: string;
  let issueNumber: number | undefined;
  let piece: string | undefined;

  if (task && isIssueReference(task)) {
    // Issue reference: fetch issue and use directly as task content
    info('Fetching GitHub Issue...');
    try {
      taskContent = resolveIssueTask(task);
      const numbers = parseIssueNumbers([task]);
      if (numbers.length > 0) {
        issueNumber = numbers[0];
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('Failed to fetch GitHub Issue', { task, error: msg });
      info(`Failed to fetch issue ${task}: ${msg}`);
      return;
    }

    // ピース選択（issue取得成功後）
    const pieceId = await determinePiece(cwd);
    if (pieceId === null) {
      info('Cancelled.');
      return;
    }
    piece = pieceId;
  } else {
    // ピース選択を先に行い、結果を対話モードに渡す
    const pieceId = await determinePiece(cwd);
    if (pieceId === null) {
      info('Cancelled.');
      return;
    }
    piece = pieceId;

    const globalConfig = loadGlobalConfig();
    const previewCount = globalConfig.interactivePreviewMovements;
    const pieceContext = getPieceDescription(pieceId, cwd, previewCount);

    // Interactive mode: AI conversation to refine task
    const result = await interactiveMode(cwd, undefined, pieceContext);

    if (result.action === 'create_issue') {
      await createIssueAndSaveTask(cwd, result.task, piece);
      return;
    }

    if (result.action !== 'execute' && result.action !== 'save_task') {
      info('Cancelled.');
      return;
    }

    // interactiveMode already returns a summarized task from conversation
    taskContent = result.task;
  }

  // 3. ワークツリー/ブランチ/PR設定
  const settings = await promptWorktreeSettings();

  // YAMLファイル作成
  const created = await saveTaskFile(cwd, taskContent, {
    piece,
    issue: issueNumber,
    ...settings,
  });

  displayTaskCreationResult(created, settings, piece);
}
