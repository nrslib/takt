/**
 * List tasks command — main entry point.
 *
 * Interactive UI for reviewing branch-based task results,
 * pending tasks (.takt/tasks.yaml), and failed tasks.
 * Individual actions (merge, delete, instruct, diff) are in taskActions.ts.
 * Task delete actions are in taskDeleteActions.ts.
 * Non-interactive mode is in listNonInteractive.ts.
 */

import {
  listTaktBranches,
  buildListItems,
  detectDefaultBranch,
  TaskRunner,
} from '../../../infra/task/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { selectOption, confirm } from '../../../shared/prompt/index.js';
import { info, header, blankLine } from '../../../shared/ui/index.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import {
  type ListAction,
  showFullDiff,
  showDiffAndPromptAction,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
  instructBranch,
} from './taskActions.js';
import { deletePendingTask, deleteFailedTask } from './taskDeleteActions.js';
import { retryFailedTask } from './taskRetryActions.js';
import { listTasksNonInteractive, type ListNonInteractiveOptions } from './listNonInteractive.js';
import { formatTaskStatusLabel } from './taskStatusLabel.js';

export type { ListNonInteractiveOptions } from './listNonInteractive.js';

export {
  type ListAction,
  isBranchMerged,
  showFullDiff,
  tryMergeBranch,
  mergeBranch,
  deleteBranch,
  instructBranch,
} from './taskActions.js';

/** Task action type for pending task action selection menu */
type PendingTaskAction = 'delete';

/** Task action type for failed task action selection menu */
type FailedTaskAction = 'retry' | 'delete';

/**
 * Show pending task details and prompt for an action.
 * Returns the selected action, or null if cancelled.
 */
async function showPendingTaskAndPromptAction(task: TaskListItem): Promise<PendingTaskAction | null> {
  header(formatTaskStatusLabel(task));
  info(`  Created: ${task.createdAt}`);
  if (task.content) {
    info(`  ${task.content}`);
  }
  blankLine();

  return await selectOption<PendingTaskAction>(
    `Action for ${task.name}:`,
    [{ label: 'Delete', value: 'delete', description: 'Remove this task permanently' }],
  );
}

/**
 * Show failed task details and prompt for an action.
 * Returns the selected action, or null if cancelled.
 */
async function showFailedTaskAndPromptAction(task: TaskListItem): Promise<FailedTaskAction | null> {
  header(formatTaskStatusLabel(task));
  info(`  Failed at: ${task.createdAt}`);
  if (task.content) {
    info(`  ${task.content}`);
  }
  blankLine();

  return await selectOption<FailedTaskAction>(
    `Action for ${task.name}:`,
    [
      { label: 'Retry', value: 'retry', description: 'Requeue task and select start movement' },
      { label: 'Delete', value: 'delete', description: 'Remove this task permanently' },
    ],
  );
}

/**
 * Main entry point: list branch-based tasks interactively.
 */
export async function listTasks(
  cwd: string,
  options?: TaskExecutionOptions,
  nonInteractive?: ListNonInteractiveOptions,
): Promise<void> {
  if (nonInteractive?.enabled) {
    await listTasksNonInteractive(cwd, nonInteractive);
    return;
  }

  const defaultBranch = detectDefaultBranch(cwd);
  const runner = new TaskRunner(cwd);

  // Interactive loop
  while (true) {
    const branches = listTaktBranches(cwd);
    const items = buildListItems(cwd, branches, defaultBranch);
    const pendingTasks = runner.listPendingTaskItems();
    const failedTasks = runner.listFailedTasks();

    if (items.length === 0 && pendingTasks.length === 0 && failedTasks.length === 0) {
      info('No tasks to list.');
      return;
    }

    const menuOptions = [
      ...items.map((item, idx) => {
        const filesSummary = `${item.filesChanged} file${item.filesChanged !== 1 ? 's' : ''} changed`;
        const description = item.originalInstruction
          ? `${filesSummary} | ${item.originalInstruction}`
          : filesSummary;
        return {
          label: item.info.branch,
          value: `branch:${idx}`,
          description,
        };
      }),
      ...pendingTasks.map((task, idx) => ({
        label: formatTaskStatusLabel(task),
        value: `pending:${idx}`,
        description: task.content,
      })),
      ...failedTasks.map((task, idx) => ({
        label: formatTaskStatusLabel(task),
        value: `failed:${idx}`,
        description: task.content,
      })),
    ];

    const selected = await selectOption<string>(
      'List Tasks',
      menuOptions,
    );

    if (selected === null) {
      return;
    }

    const colonIdx = selected.indexOf(':');
    if (colonIdx === -1) continue;
    const type = selected.slice(0, colonIdx);
    const idx = parseInt(selected.slice(colonIdx + 1), 10);
    if (Number.isNaN(idx)) continue;

    if (type === 'branch') {
      const item = items[idx];
      if (!item) continue;

      // Action loop: re-show menu after viewing diff
      let action: ListAction | null;
      do {
        action = await showDiffAndPromptAction(cwd, defaultBranch, item);

        if (action === 'diff') {
          showFullDiff(cwd, defaultBranch, item.info.branch);
        }
      } while (action === 'diff');

      if (action === null) continue;

      switch (action) {
        case 'instruct':
          await instructBranch(cwd, item, options);
          break;
        case 'try':
          tryMergeBranch(cwd, item);
          break;
        case 'merge':
          mergeBranch(cwd, item);
          break;
        case 'delete': {
          const confirmed = await confirm(
            `Delete ${item.info.branch}? This will discard all changes.`,
            false,
          );
          if (confirmed) {
            deleteBranch(cwd, item);
          }
          break;
        }
      }
    } else if (type === 'pending') {
      const task = pendingTasks[idx];
      if (!task) continue;
      const taskAction = await showPendingTaskAndPromptAction(task);
      if (taskAction === 'delete') {
        await deletePendingTask(task);
      }
    } else if (type === 'failed') {
      const task = failedTasks[idx];
      if (!task) continue;
      const taskAction = await showFailedTaskAndPromptAction(task);
      if (taskAction === 'retry') {
        await retryFailedTask(task, cwd);
      } else if (taskAction === 'delete') {
        await deleteFailedTask(task);
      }
    }
  }
}
