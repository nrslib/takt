/**
 * Delete actions for pending and failed tasks.
 *
 * Provides interactive deletion (with confirm prompt)
 * for pending/failed tasks in .takt/tasks.yaml.
 */

import { dirname } from 'node:path';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';

const log = createLogger('list-tasks');

function getProjectDir(task: TaskListItem): string {
  return dirname(dirname(task.filePath));
}

/**
 * Delete a pending task file.
 * Prompts user for confirmation first.
 */
export async function deletePendingTask(task: TaskListItem): Promise<boolean> {
  const confirmed = await confirm(`Delete pending task "${task.name}"?`, false);
  if (!confirmed) return false;
  try {
    const runner = new TaskRunner(getProjectDir(task));
    runner.deletePendingTask(task.name);
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to delete pending task "${task.name}": ${msg}`);
    log.error('Failed to delete pending task', { name: task.name, filePath: task.filePath, error: msg });
    return false;
  }
  success(`Deleted pending task: ${task.name}`);
  log.info('Deleted pending task', { name: task.name, filePath: task.filePath });
  return true;
}

/**
 * Delete a failed task directory.
 * Prompts user for confirmation first.
 */
export async function deleteFailedTask(task: TaskListItem): Promise<boolean> {
  const confirmed = await confirm(`Delete failed task "${task.name}"?`, false);
  if (!confirmed) return false;
  try {
    const runner = new TaskRunner(getProjectDir(task));
    runner.deleteFailedTask(task.name);
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to delete failed task "${task.name}": ${msg}`);
    log.error('Failed to delete failed task', { name: task.name, filePath: task.filePath, error: msg });
    return false;
  }
  success(`Deleted failed task: ${task.name}`);
  log.info('Deleted failed task', { name: task.name, filePath: task.filePath });
  return true;
}
