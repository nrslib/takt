/**
 * Non-interactive list mode.
 *
 * Handles --non-interactive output (text/JSON) and
 * non-interactive branch actions (--action, --branch).
 */

import { execFileSync } from 'node:child_process';
import type { TaskListItem, BranchListItem } from '../../../infra/task/index.js';
import {
  detectDefaultBranch,
  listTaktBranches,
  buildListItems,
  TaskRunner,
} from '../../../infra/task/index.js';
import { info } from '../../../shared/ui/index.js';
import {
  type ListAction,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
} from './taskActions.js';
import { formatTaskStatusLabel } from './taskStatusLabel.js';

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

function printNonInteractiveList(
  items: BranchListItem[],
  pendingTasks: TaskListItem[],
  failedTasks: TaskListItem[],
  format?: string,
): void {
  const outputFormat = format ?? 'text';
  if (outputFormat === 'json') {
    // stdout に直接出力（JSON パース用途のため UI ヘルパーを経由しない）
    console.log(JSON.stringify({
      branches: items,
      pendingTasks,
      failedTasks,
    }, null, 2));
    return;
  }

  for (const item of items) {
    const instruction = item.originalInstruction ? ` - ${item.originalInstruction}` : '';
    info(`${item.info.branch} (${item.filesChanged} files)${instruction}`);
  }

  for (const task of pendingTasks) {
    info(`${formatTaskStatusLabel(task)} - ${task.content}`);
  }

  for (const task of failedTasks) {
    info(`${formatTaskStatusLabel(task)} - ${task.content}`);
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
  const branches = listTaktBranches(cwd);
  const runner = new TaskRunner(cwd);
  const pendingTasks = runner.listPendingTaskItems();
  const failedTasks = runner.listFailedTasks();

  const items = buildListItems(cwd, branches, defaultBranch);

  if (items.length === 0 && pendingTasks.length === 0 && failedTasks.length === 0) {
    info('No tasks to list.');
    return;
  }

  if (!nonInteractive.action) {
    printNonInteractiveList(items, pendingTasks, failedTasks, nonInteractive.format);
    return;
  }

  // Branch-targeted action (--branch)
  if (!nonInteractive.branch) {
    info('Missing --branch for non-interactive action.');
    process.exit(1);
  }

  if (!isValidAction(nonInteractive.action)) {
    info('Invalid --action. Use one of: diff, try, merge, delete.');
    process.exit(1);
  }

  const item = items.find((entry) => entry.info.branch === nonInteractive.branch);
  if (!item) {
    info(`Branch not found: ${nonInteractive.branch}`);
    process.exit(1);
  }

  switch (nonInteractive.action) {
    case 'diff':
      showDiffStat(cwd, defaultBranch, item.info.branch);
      return;
    case 'try':
      tryMergeBranch(cwd, item);
      return;
    case 'merge':
      mergeBranch(cwd, item);
      return;
    case 'delete':
      if (!nonInteractive.yes) {
        info('Delete requires --yes in non-interactive mode.');
        process.exit(1);
      }
      deleteBranch(cwd, item);
      return;
  }
}
