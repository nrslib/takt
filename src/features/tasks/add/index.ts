/**
 * add command implementation
 *
 * Appends a task record to .takt/tasks.yaml.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { promptInput, confirm, selectOption } from '../../../shared/prompt/index.js';
import { success, info, error, withProgress } from '../../../shared/ui/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import type { Language } from '../../../core/models/types.js';
import { TaskRunner, type TaskFileData, summarizeTaskName } from '../../../infra/task/index.js';
import { determinePiece } from '../execute/selectAndExecute.js';
import { createLogger, getErrorMessage, generateReportDir } from '../../../shared/utils/index.js';
import { isIssueReference, resolveIssueTask, parseIssueNumbers, formatPrReviewAsTask } from '../../../infra/github/index.js';
import { getGitProvider, type PrReviewData } from '../../../infra/git/index.js';
import { firstLine } from '../../../infra/task/naming.js';
import { extractTitle, createIssueFromTask } from './issueTask.js';
export { extractTitle, createIssueFromTask };

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
  options?: { piece?: string; issue?: number; worktree?: boolean | string; branch?: string; autoPr?: boolean; draftPr?: boolean },
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
    ...(options?.draftPr !== undefined && { draft_pr: options.draftPr }),
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

interface WorktreeSettings {
  worktree?: boolean | string;
  branch?: string;
  autoPr?: boolean;
  draftPr?: boolean;
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
  if (settings.draftPr) {
    info(`  Draft PR: yes`);
  }
  if (piece) info(`  Piece: ${piece}`);
}

/**
 * Prompt user to select a label for the GitHub Issue.
 *
 * Presents 4 fixed options: None, bug, enhancement, custom input.
 * Returns an array of selected labels (empty if none selected).
 */
export async function promptLabelSelection(lang: Language): Promise<string[]> {
  const selected = await selectOption<string>(
    getLabel('issue.labelSelection.prompt', lang),
    [
      { label: getLabel('issue.labelSelection.none', lang), value: 'none' },
      { label: 'bug', value: 'bug' },
      { label: 'enhancement', value: 'enhancement' },
      { label: getLabel('issue.labelSelection.custom', lang), value: 'custom' },
    ],
  );

  if (selected === null || selected === 'none') return [];
  if (selected === 'custom') {
    const customLabel = await promptInput(getLabel('issue.labelSelection.customPrompt', lang));
    return customLabel?.split(',').map((l) => l.trim()).filter((l) => l.length > 0) ?? [];
  }
  return [selected];
}

async function promptWorktreeSettings(): Promise<WorktreeSettings> {
  const customPath = await promptInput('Worktree path (Enter for auto)');
  const worktree: boolean | string = customPath || true;

  const customBranch = await promptInput('Branch name (Enter for auto)');
  const branch = customBranch || undefined;

  const autoPr = await confirm('Auto-create PR?', true);
  const draftPr = autoPr ? await confirm('Create as draft?', true) : false;

  return { worktree, branch, autoPr, draftPr };
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

export async function createIssueAndSaveTask(
  cwd: string,
  task: string,
  piece?: string,
  options?: { confirmAtEndMessage?: string; labels?: string[] },
): Promise<void> {
  const issueNumber = createIssueFromTask(task, { labels: options?.labels });
  if (issueNumber === undefined) {
    return;
  }
  await saveTaskFromInteractive(cwd, task, piece, {
    issue: issueNumber,
    confirmAtEndMessage: options?.confirmAtEndMessage,
  });
}

/**
 * add command handler
 */
export async function addTask(
  cwd: string,
  task?: string,
  opts?: { prNumber?: number },
): Promise<void> {
  const rawTask = task ?? '';
  const trimmedTask = rawTask.trim();
  const prNumber = opts?.prNumber;

  if (prNumber !== undefined) {
    const provider = getGitProvider();
    const ghStatus = provider.checkCliStatus();
    if (!ghStatus.available) {
      error(ghStatus.error ?? 'GitHub CLI is unavailable');
      return;
    }

    let prReview: PrReviewData;
    try {
      prReview = await withProgress(
        'Fetching PR review comments...',
        (fetchedPrReview: PrReviewData) => `PR fetched: #${fetchedPrReview.number} ${fetchedPrReview.title}`,
        async () => provider.fetchPrReviewComments(prNumber),
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      error(`Failed to fetch PR review comments #${prNumber}: ${msg}`);
      return;
    }

    if (prReview.reviews.length === 0 && prReview.comments.length === 0) {
      error(`PR #${prNumber} has no review comments`);
      return;
    }

    const taskContent = formatPrReviewAsTask(prReview);
    const piece = await determinePiece(cwd);
    if (piece === null) {
      info('Cancelled.');
      return;
    }

    const settings = {
      worktree: true,
      branch: prReview.headRefName,
      autoPr: false,
    };
    const created = await saveTaskFile(cwd, taskContent, { piece, ...settings });
    displayTaskCreationResult(created, settings, piece);
    return;
  }

  if (!trimmedTask) {
    info('Usage: takt add <task>');
    return;
  }

  let taskContent: string;
  let issueNumber: number | undefined;

  if (isIssueReference(trimmedTask)) {
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

  const settings = await promptWorktreeSettings();

  const created = await saveTaskFile(cwd, taskContent, {
    piece,
    issue: issueNumber,
    ...settings,
  });

  displayTaskCreationResult(created, settings, piece);
}
