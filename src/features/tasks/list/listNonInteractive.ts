/**
 * Non-interactive list mode.
 *
 * Handles --non-interactive output (text/JSON) and
 * non-interactive branch actions (--action, --branch).
 */

import {
  TaskRunner,
  serializeTaskListItemForJson,
  type TaskListItem,
} from '../../../infra/task/index.js';
import { info } from '../../../shared/ui/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { resolveConfigValue } from '../../../infra/config/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';
import { selectTasksForDeletion, type DeletableTaskStatus } from './taskDeleteSelection.js';
import { executeTaskDeletion } from './taskDeleteExecution.js';
import {
  type ListAction,
  tryMergeBranch,
  mergeBranch,
  showDiffStatForTask,
  syncBranchWithRoot,
} from './taskActions.js';
import { formatTaskStatusLabel, formatShortDate } from './taskStatusLabel.js';

export interface ListNonInteractiveOptions {
  enabled: boolean;
  action?: string;
  branch?: string;
  status?: DeletableTaskStatus[];
  goal?: string;
  format?: string;
  yes?: boolean;
}

function isValidAction(action: string): action is Exclude<ListAction, 'delete'> {
  return action === 'diff' || action === 'sync' || action === 'try' || action === 'merge';
}

function printNonInteractiveList(tasks: TaskListItem[], format?: string): void {
  const outputFormat = format ?? 'text';
  if (outputFormat === 'json') {
    // stdout に直接出力（JSON パース用途のため UI ヘルパーを経由しない）
    console.log(JSON.stringify({
      tasks: tasks.map(serializeTaskListItemForJson),
    }, null, 2));
    return;
  }

  for (const task of tasks) {
    info(`${formatTaskStatusLabel(task)} - ${task.summary ?? task.content} (${formatShortDate(task.createdAt)})`);
  }
}

function deleteFilteredTasks(tasks: TaskListItem[], options: ListNonInteractiveOptions, cwd: string): void {
  const language = resolveConfigValue(cwd, 'language');
  let targets: TaskListItem[];
  try {
    targets = selectTasksForDeletion(tasks, {
      status: options.status,
      goal: options.goal,
      branch: options.branch,
    });
  } catch {
    info(getLabel('taskDeletion.filtersRequired', language));
    process.exit(1);
  }

  if (!options.yes) {
    if (options.format === 'json') {
      printNonInteractiveList(targets, 'json');
      return;
    }
    if (targets.length === 0) {
      info(getLabel('taskDeletion.empty', language));
      return;
    }
    info(getLabel('taskDeletion.preview', language));
    for (const task of targets) {
      info(getLabel('taskDeletion.previewTask', language, {
        name: sanitizeTerminalText(task.name),
        status: task.kind,
        branch: sanitizeTerminalText(task.branch ?? '-'),
        goal: sanitizeTerminalText(task.goalId ?? '-'),
      }));
    }
    return;
  }

  if (targets.length === 0) {
    info(getLabel('taskDeletion.empty', language));
    return;
  }
  const results = executeTaskDeletion(targets);
  for (const result of results) {
    const name = sanitizeTerminalText(result.task.name);
    if (result.success) {
      info(getLabel('taskDeletion.deleted', language, { name }));
    } else if (result.error !== undefined) {
      info(getLabel('taskDeletion.failedWithError', language, {
        name, error: sanitizeTerminalText(getErrorMessage(result.error)),
      }));
    } else {
      info(getLabel('taskDeletion.failed', language, { name }));
    }
  }
  if (results.some((result) => !result.success)) process.exit(1);
}

/**
 * Run list-tasks in non-interactive mode.
 */
export async function listTasksNonInteractive(
  cwd: string,
  nonInteractive: ListNonInteractiveOptions,
): Promise<void> {
  const runner = new TaskRunner(cwd);
  const tasks = runner.listAllTaskItems();

  if (nonInteractive.action === 'delete') {
    deleteFilteredTasks(tasks, nonInteractive, cwd);
    return;
  }

  if (tasks.length === 0) {
    if (nonInteractive.format === 'json') {
      console.log(JSON.stringify({ tasks: [] }, null, 2));
      return;
    }
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
    info('Invalid --action. Use one of: diff, sync, try, merge, delete.');
    process.exit(1);
  }

  const task = tasks.find((entry) => entry.kind === 'completed' && entry.branch === nonInteractive.branch);
  if (!task) {
    info(`Branch not found: ${nonInteractive.branch}`);
    process.exit(1);
  }

  switch (nonInteractive.action) {
    case 'diff':
      showDiffStatForTask(cwd, task);
      return;
    case 'try':
      tryMergeBranch(cwd, task);
      return;
    case 'sync':
      if (!(await syncBranchWithRoot(cwd, task))) {
        process.exit(1);
      }
      return;
    case 'merge':
      if (mergeBranch(cwd, task)) {
        runner.deleteTask(task.name, 'completed');
      }
      return;
  }
}
