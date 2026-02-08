/**
 * add command implementation
 *
 * Starts an AI conversation to refine task requirements,
 * then creates a task file in .takt/tasks/ with YAML format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { promptInput, confirm } from '../../../shared/prompt/index.js';
import { success, info, error } from '../../../shared/ui/index.js';
import { summarizeTaskName, type TaskFileData } from '../../../infra/task/index.js';
import { getPieceDescription, loadGlobalConfig } from '../../../infra/config/index.js';
import { determinePiece } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers, createIssue } from '../../../infra/github/index.js';
import { interactiveMode } from '../../interactive/index.js';

const log = createLogger('add-task');

async function generateFilename(tasksDir: string, taskContent: string, cwd: string): Promise<string> {
  info('Generating task filename...');
  const slug = await summarizeTaskName(taskContent, { cwd });
  const base = slug || 'task';
  let filename = `${base}.yaml`;
  let counter = 1;

  while (fs.existsSync(path.join(tasksDir, filename))) {
    filename = `${base}-${counter}.yaml`;
    counter++;
  }

  return filename;
}

/**
 * Save a task file to .takt/tasks/ with YAML format.
 *
 * Common logic extracted from addTask(). Used by both addTask()
 * and saveTaskFromInteractive().
 */
export async function saveTaskFile(
  cwd: string,
  taskContent: string,
  options?: { piece?: string; issue?: number; worktree?: boolean | string; branch?: string; autoPr?: boolean },
): Promise<string> {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const firstLine = taskContent.split('\n')[0] || taskContent;
  const filename = await generateFilename(tasksDir, firstLine, cwd);

  const taskData: TaskFileData = {
    task: taskContent,
    ...(options?.worktree !== undefined && { worktree: options.worktree }),
    ...(options?.branch && { branch: options.branch }),
    ...(options?.piece && { piece: options.piece }),
    ...(options?.issue !== undefined && { issue: options.issue }),
    ...(options?.autoPr !== undefined && { auto_pr: options.autoPr }),
  };

  const filePath = path.join(tasksDir, filename);
  const yamlContent = stringifyYaml(taskData);
  fs.writeFileSync(filePath, yamlContent, 'utf-8');

  log.info('Task created', { filePath, taskData });

  return filePath;
}

/**
 * Create a GitHub Issue from a task description.
 *
 * Extracts the first line as the issue title (truncated to 100 chars),
 * uses the full task as the body, and displays success/error messages.
 */
export function createIssueFromTask(task: string): void {
  info('Creating GitHub Issue...');
  const firstLine = task.split('\n')[0] || task;
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
  const issueResult = createIssue({ title, body: task });
  if (issueResult.success) {
    success(`Issue created: ${issueResult.url}`);
  } else {
    error(`Failed to create issue: ${issueResult.error}`);
  }
}

/**
 * Save a task from interactive mode result.
 * Does not prompt for worktree/branch settings.
 */
export async function saveTaskFromInteractive(
  cwd: string,
  task: string,
  piece?: string,
): Promise<void> {
  const filePath = await saveTaskFile(cwd, task, { piece });
  const filename = path.basename(filePath);
  success(`Task created: ${filename}`);
  info(`  Path: ${filePath}`);
  if (piece) info(`  Piece: ${piece}`);
}

/**
 * add command handler
 *
 * Flow:
 *   A) Issue参照の場合: issue取得 → ピース選択 → ワークツリー設定 → YAML作成
 *   B) それ以外: ピース選択 → AI対話モード → ワークツリー設定 → YAML作成
 */
export async function addTask(cwd: string, task?: string): Promise<void> {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

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
      createIssueFromTask(result.task);
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
  let worktree: boolean | string | undefined;
  let branch: string | undefined;
  let autoPr: boolean | undefined;

  const useWorktree = await confirm('Create worktree?', true);
  if (useWorktree) {
    const customPath = await promptInput('Worktree path (Enter for auto)');
    worktree = customPath || true;

    const customBranch = await promptInput('Branch name (Enter for auto)');
    if (customBranch) {
      branch = customBranch;
    }

    // PR確認（worktreeが有効な場合のみ）
    autoPr = await confirm('Auto-create PR?', true);
  }

  // YAMLファイル作成
  const filePath = await saveTaskFile(cwd, taskContent, {
    piece,
    issue: issueNumber,
    worktree,
    branch,
    autoPr,
  });

  const filename = path.basename(filePath);
  success(`Task created: ${filename}`);
  info(`  Path: ${filePath}`);
  if (worktree) {
    info(`  Worktree: ${typeof worktree === 'string' ? worktree : 'auto'}`);
  }
  if (branch) {
    info(`  Branch: ${branch}`);
  }
  if (autoPr) {
    info(`  Auto-PR: yes`);
  }
  if (piece) {
    info(`  Piece: ${piece}`);
  }
}
