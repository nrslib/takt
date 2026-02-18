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
  TaskRunner,
} from '../../../infra/task/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { info, header, blankLine } from '../../../shared/ui/index.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import {
  type ListAction,
  showFullDiff,
  showDiffAndPromptActionForTask,
  tryMergeBranch,
  mergeBranch,
  instructBranch,
} from './taskActions.js';
import { deletePendingTask, deleteFailedTask, deleteCompletedTask } from './taskDeleteActions.js';
import { retryFailedTask } from './taskRetryActions.js';
import { listTasksNonInteractive, type ListNonInteractiveOptions } from './listNonInteractive.js';
import { formatTaskStatusLabel, formatShortDate } from './taskStatusLabel.js';

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

export {
  type InstructModeAction,
  type InstructModeResult,
  runInstructMode,
} from './instructMode.js';

/** Task action type for pending task action selection menu */
type PendingTaskAction = 'delete';

/** Task action type for failed task action selection menu */
type FailedTaskAction = 'retry' | 'delete';
type CompletedTaskAction = ListAction;

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
  info(`  Created: ${task.createdAt}`);
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

async function showCompletedTaskAndPromptAction(cwd: string, task: TaskListItem): Promise<CompletedTaskAction | null> {
  header(formatTaskStatusLabel(task));
  info(`  Created: ${task.createdAt}`);
  if (task.content) {
    info(`  ${task.content}`);
  }
  blankLine();

  return await showDiffAndPromptActionForTask(cwd, task);
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

  const runner = new TaskRunner(cwd);

  // Interactive loop
  while (true) {
    const tasks = runner.listAllTaskItems();

    if (tasks.length === 0) {
      info('No tasks to list.');
      return;
    }

    const menuOptions = tasks.map((task, idx) => ({
      label: formatTaskStatusLabel(task),
      value: `${task.kind}:${idx}`,
      description: `${task.summary ?? task.content} | ${formatShortDate(task.createdAt)}`,
    }));

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

    if (type === 'pending') {
      const task = tasks[idx];
      if (!task) continue;
      const taskAction = await showPendingTaskAndPromptAction(task);
      if (taskAction === 'delete') {
        await deletePendingTask(task);
      }
    } else if (type === 'running') {
      const task = tasks[idx];
      if (!task) continue;
      header(formatTaskStatusLabel(task));
      info(`  Created: ${task.createdAt}`);
      if (task.content) {
        info(`  ${task.content}`);
      }
      blankLine();
      info('Running task is read-only.');
      blankLine();
    } else if (type === 'completed') {
      const task = tasks[idx];
      if (!task) continue;
      if (!task.branch) {
        info(`Branch is missing for completed task: ${task.name}`);
        continue;
      }
      const taskAction = await showCompletedTaskAndPromptAction(cwd, task);
      if (taskAction === null) continue;

      switch (taskAction) {
        case 'diff':
          showFullDiff(cwd, task.branch);
          break;
        case 'instruct':
          await instructBranch(cwd, task);
          break;
        case 'try':
          tryMergeBranch(cwd, task);
          break;
        case 'merge':
          if (mergeBranch(cwd, task)) {
            runner.deleteCompletedTask(task.name);
          }
          break;
        case 'delete':
          await deleteCompletedTask(task);
          break;
      }
    } else if (type === 'failed') {
      const task = tasks[idx];
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
