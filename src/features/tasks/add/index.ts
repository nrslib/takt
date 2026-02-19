/**
 * add command implementation
 *
 * Appends a task record to .takt/tasks.yaml.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { promptInput, confirm } from '../../../shared/prompt/index.js';
import { success, info, error, withProgress } from '../../../shared/ui/index.js';
import { TaskRunner, type TaskFileData, summarizeTaskName } from '../../../infra/task/index.js';
import { determinePiece } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage, generateReportDir } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers, createIssue } from '../../../infra/github/index.js';
import { firstLine } from '../../../infra/task/naming.js';

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
  const slug = await summarizeTaskName(taskContent, { cwd });
  const summary = firstLine(taskContent);
  const taskDirSlug = resolveUniqueTaskSlug(cwd, generateReportDir(taskContent));
  const taskDir = path.join(cwd, '.takt', 'tasks', taskDirSlug);
  const taskDirRelative = `.takt/tasks/${taskDirSlug}`;
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
    slug,
    summary,
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
  const titleLine = task.split('\n')[0] || task;
  const title = titleLine.length > 100 ? `${titleLine.slice(0, 97)}...` : titleLine;
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
  options?: { issue?: number; confirmAtEndMessage?: string },
): Promise<void> {
  if (options?.confirmAtEndMessage) {
    const approved = await confirm(options.confirmAtEndMessage, true);
    if (!approved) {
      return;
    }
  }
  const settings = await promptWorktreeSettings();
  const created = await saveTaskFile(cwd, task, { piece, issue: options?.issue, ...settings });
  displayTaskCreationResult(created, settings, piece);
}

/**
 * add command handler
 *
 * Flow:
 *   A) 引数なし: Usage表示して終了
 *   B) Issue参照の場合: issue取得 → ピース選択 → ワークツリー設定 → YAML作成
 *   C) 通常入力: 引数をそのまま保存
 */
export async function addTask(cwd: string, task?: string): Promise<void> {
  const rawTask = task ?? '';
  const trimmedTask = rawTask.trim();
  if (!trimmedTask) {
    info('Usage: takt add <task>');
    return;
  }

  let taskContent: string;
  let issueNumber: number | undefined;

  if (isIssueReference(trimmedTask)) {
    // Issue reference: fetch issue and use directly as task content
    try {
      const numbers = parseIssueNumbers([trimmedTask]);
      const primaryIssueNumber = numbers[0];
      taskContent = await withProgress(
        'Fetching GitHub Issue...',
        primaryIssueNumber ? `GitHub Issue fetched: #${primaryIssueNumber}` : 'GitHub Issue fetched',
        async () => resolveIssueTask(trimmedTask),
      );
      if (numbers.length > 0) {
        issueNumber = numbers[0];
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('Failed to fetch GitHub Issue', { task: trimmedTask, error: msg });
      info(`Failed to fetch issue ${trimmedTask}: ${msg}`);
      return;
    }
  } else {
    taskContent = rawTask;
  }

  const piece = await determinePiece(cwd);
  if (piece === null) {
    info('Cancelled.');
    return;
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
