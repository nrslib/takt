/**
 * Non-interactive list mode.
 *
 * Handles --non-interactive output (text/JSON) and
 * non-interactive branch actions (--action, --branch).
 */

import { execFileSync } from 'node:child_process';
import type { TaskListItem } from '../../../infra/task/index.js';
import {
  detectDefaultBranch,
  TaskRunner,
} from '../../../infra/task/index.js';
import { info } from '../../../shared/ui/index.js';
import {
  type ListAction,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
} from './taskActions.js';
import { formatTaskStatusLabel, formatShortDate } from './taskStatusLabel.js';

export interface ListNonInteractiveOptions {
  enabled: boolean;
  action?: string;
  branch?: string;
  format?: string;
  yes?: boolean;
}

function isValidAction(action: string): action is ListAction {
  return action === 'diff' || action === 'try' || action === 'merge' || action === 'delete';
}

function printNonInteractiveList(tasks: TaskListItem[], format?: string): void {
  const outputFormat = format ?? 'text';
  if (outputFormat === 'json') {
    // stdout に直接出力（JSON パース用途のため UI ヘルパーを経由しない）
    console.log(JSON.stringify({
      tasks,
    }, null, 2));
    return;
  }

  for (const task of tasks) {
    info(`${formatTaskStatusLabel(task)} - ${task.summary ?? task.content} (${formatShortDate(task.createdAt)})`);
  }
}

function showDiffStat(projectDir: string, defaultBranch: string, branch: string): void {
  try {
    const stat = execFileSync(
      'git', ['diff', '--stat', `${defaultBranch}...${branch}`],
      { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
    );
    info(stat);
  } catch {
    info('Could not generate diff stat');
  }
}

/**
 * Run list-tasks in non-interactive mode.
 */
export async function listTasksNonInteractive(
  cwd: string,
  nonInteractive: ListNonInteractiveOptions,
): Promise<void> {
  const defaultBranch = detectDefaultBranch(cwd);
  const runner = new TaskRunner(cwd);
  const tasks = runner.listAllTaskItems();

  if (tasks.length === 0) {
    info('No tasks to list.');
    return;
  }

  if (!nonInteractive.action) {
    printNonInteractiveList(tasks, nonInteractive.format);
    return;
  }

  // Completed-task branch-targeted action (--branch)
  if (!nonInteractive.branch) {
    info('Missing --branch for non-interactive action.');
    process.exit(1);
  }

  if (!isValidAction(nonInteractive.action)) {
    info('Invalid --action. Use one of: diff, try, merge, delete.');
    process.exit(1);
  }

  const task = tasks.find((entry) => entry.kind === 'completed' && entry.branch === nonInteractive.branch);
  if (!task) {
    info(`Branch not found: ${nonInteractive.branch}`);
    process.exit(1);
  }

  switch (nonInteractive.action) {
    case 'diff':
      showDiffStat(cwd, defaultBranch, nonInteractive.branch);
      return;
    case 'try':
      tryMergeBranch(cwd, task);
      return;
    case 'merge':
      if (mergeBranch(cwd, task)) {
        runner.deleteCompletedTask(task.name);
      }
      return;
    case 'delete':
      if (!nonInteractive.yes) {
        info('Delete requires --yes in non-interactive mode.');
        process.exit(1);
      }
      if (deleteBranch(cwd, task)) {
        runner.deleteCompletedTask(task.name);
      }
      return;
  }
}
