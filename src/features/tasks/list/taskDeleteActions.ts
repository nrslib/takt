import { dirname } from 'node:path';
import { lstatSync, rmSync } from 'node:fs';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { confirm, selectMultipleOptions } from '../../../shared/prompt/index.js';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';
import { deleteBranch } from './taskActions.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import { formatTaskStatusLabel } from './taskStatusLabel.js';

const log = createLogger('list-tasks');

class TaskCleanupAbortedError extends Error {}

function getProjectDir(task: TaskListItem): string {
  return dirname(dirname(task.filePath));
}

function cleanupBranchIfPresent(task: TaskListItem, projectDir: string): void {
  if (task.data?.merge_task === true) {
    if (task.worktreePath !== undefined) {
      let exists = true;
      try {
        lstatSync(task.worktreePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exists = false;
      }
      if (exists) {
        assertReusableWorktreePath(projectDir, task.worktreePath);
        rmSync(task.worktreePath, { recursive: true, force: true });
      }
    }
    return;
  }
  if (!task.branch) {
    return;
  }

  if (!deleteBranch(projectDir, task)) {
    throw new TaskCleanupAbortedError('Branch cleanup failed');
  }
}

export async function deleteTaskByKind(task: TaskListItem): Promise<boolean> {
  if (task.kind === 'running') throw new Error(`Cannot delete running task "${task.name}"`);
  const confirmed = await confirm(`Delete ${task.kind} task "${sanitizeTerminalText(task.name)}"?`, false);
  if (!confirmed) return false;
  const projectDir = getProjectDir(task);
  try {
    const runner = new TaskRunner(projectDir);
    runner.deleteTask(task.name, task.kind, () => cleanupBranchIfPresent(task, projectDir));
  } catch (err) {
    if (err instanceof TaskCleanupAbortedError) return false;
    const msg = getErrorMessage(err);
    logError(`Failed to delete ${task.kind} task "${sanitizeTerminalText(task.name)}": ${sanitizeTerminalText(msg)}`);
    log.error('Failed to delete task', { name: task.name, kind: task.kind, filePath: task.filePath, error: msg });
    return false;
  }
  success(`Deleted ${task.kind} task: ${sanitizeTerminalText(task.name)}`);
  log.info('Deleted task', { name: task.name, kind: task.kind, filePath: task.filePath });
  return true;
}

type DeletableTask = TaskListItem & { kind: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed' };

export async function deleteAllTasks(tasks: TaskListItem[]): Promise<boolean> {
  const deletable = tasks.filter((t): t is DeletableTask => t.kind !== 'running');
  if (deletable.length === 0) return false;

  const confirmed = await confirm(`Delete all ${deletable.length} tasks?`, false);
  if (!confirmed) return false;

  const deletedCount = deleteConfirmedTasks(deletable);
  if (deletedCount > 0) {
    success(`Deleted ${deletedCount} of ${deletable.length} tasks.`);
  }
  return deletedCount > 0;
}

export async function deleteSelectedTasks(tasks: TaskListItem[]): Promise<boolean> {
  const deletable = tasks.filter((task): task is DeletableTask => task.kind !== 'running');
  if (deletable.length === 0) return false;

  const candidates = deletable.map((task, index) => ({ task, value: String(index) }));
  const selectedValues = await selectMultipleOptions(
    'Select tasks to delete',
    candidates.map(({ task, value }) => ({ label: formatTaskStatusLabel(task), value })),
    [],
  );
  if (selectedValues === null || selectedValues.length === 0) return false;

  const selected = candidates.filter(({ value }) => selectedValues.includes(value)).map(({ task }) => task);
  const confirmed = await confirm(`Delete ${selected.length} selected tasks?`, false);
  if (!confirmed) return false;

  const deletedCount = deleteConfirmedTasks(selected);
  success(`Deleted ${deletedCount} of ${selected.length} tasks.`);
  return deletedCount > 0;
}

function deleteConfirmedTasks(tasks: DeletableTask[]): number {
  let deletedCount = 0;
  for (const task of tasks) {
    const projectDir = getProjectDir(task);
    try {
      const runner = new TaskRunner(projectDir);
      runner.deleteTask(task.name, task.kind, () => cleanupBranchIfPresent(task, projectDir));
      deletedCount++;
      log.info('Deleted task in bulk delete', { name: task.name, kind: task.kind });
    } catch (err) {
      if (err instanceof TaskCleanupAbortedError) {
        logError(`Failed to cleanup branch for task "${sanitizeTerminalText(task.name)}", skipping`);
        log.error('Branch cleanup failed, skipping task', { name: task.name, kind: task.kind });
        continue;
      }
      const msg = getErrorMessage(err);
      logError(`Failed to delete task "${sanitizeTerminalText(task.name)}": ${sanitizeTerminalText(msg)}`);
      log.error('Failed to delete task in bulk delete', { name: task.name, kind: task.kind, error: msg });
    }
  }

  return deletedCount;
}
