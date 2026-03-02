import { dirname } from 'node:path';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { deleteBranch } from './taskActions.js';

const log = createLogger('list-tasks');

function getProjectDir(task: TaskListItem): string {
  return dirname(dirname(task.filePath));
}

function cleanupBranchIfPresent(task: TaskListItem, projectDir: string): boolean {
  if (!task.branch) {
    return true;
  }

  return deleteBranch(projectDir, task);
}

export async function deleteTaskByKind(task: TaskListItem): Promise<boolean> {
  if (task.kind === 'running') throw new Error(`Cannot delete running task "${task.name}"`);
  const confirmed = await confirm(`Delete ${task.kind} task "${task.name}"?`, false);
  if (!confirmed) return false;
  const projectDir = getProjectDir(task);
  try {
    if (!cleanupBranchIfPresent(task, projectDir)) return false;
    const runner = new TaskRunner(projectDir);
    runner.deleteTask(task.name, task.kind);
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to delete ${task.kind} task "${task.name}": ${msg}`);
    log.error('Failed to delete task', { name: task.name, kind: task.kind, filePath: task.filePath, error: msg });
    return false;
  }
  success(`Deleted ${task.kind} task: ${task.name}`);
  log.info('Deleted task', { name: task.name, kind: task.kind, filePath: task.filePath });
  return true;
}

type DeletableTask = TaskListItem & { kind: 'pending' | 'failed' | 'completed' | 'exceeded' };

export async function deleteAllTasks(tasks: TaskListItem[]): Promise<boolean> {
  const deletable = tasks.filter((t): t is DeletableTask => t.kind !== 'running');
  if (deletable.length === 0) return false;

  const confirmed = await confirm(`Delete all ${deletable.length} tasks?`, false);
  if (!confirmed) return false;

  let deletedCount = 0;
  for (const task of deletable) {
    const projectDir = getProjectDir(task);
    try {
      if (!cleanupBranchIfPresent(task, projectDir)) {
        logError(`Failed to cleanup branch for task "${task.name}", skipping`);
        log.error('Branch cleanup failed, skipping task', { name: task.name, kind: task.kind });
        continue;
      }
      const runner = new TaskRunner(projectDir);
      runner.deleteTask(task.name, task.kind);
      deletedCount++;
      log.info('Deleted task in bulk delete', { name: task.name, kind: task.kind });
    } catch (err) {
      const msg = getErrorMessage(err);
      logError(`Failed to delete task "${task.name}": ${msg}`);
      log.error('Failed to delete task in bulk delete', { name: task.name, kind: task.kind, error: msg });
    }
  }

  if (deletedCount > 0) {
    success(`Deleted ${deletedCount} of ${deletable.length} tasks.`);
  }
  return deletedCount > 0;
}
