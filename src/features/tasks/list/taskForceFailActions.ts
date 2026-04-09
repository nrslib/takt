import { resolve } from 'node:path';
import { findRunningStepByRunSlug } from '../../../core/workflow/run/run-meta.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { resolveCloneBaseDir } from '../../../infra/task/clone.js';
import { TaskRunner, isStaleRunningTask } from '../../../infra/task/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage, isPathInside } from '../../../shared/utils/index.js';

const log = createLogger('list-tasks');
const FORCE_FAIL_ERROR = 'Manually marked as failed';

function resolveSafeWorktreePath(projectDir: string, worktreePath: string | undefined): string | undefined {
  if (!worktreePath) {
    return undefined;
  }

  const cloneBaseDir = resolveCloneBaseDir(projectDir);
  const fallbackCloneBaseDir = resolve(projectDir, '.takt', 'worktrees');
  if (isPathInside(cloneBaseDir, worktreePath) || isPathInside(fallbackCloneBaseDir, worktreePath)) {
    return worktreePath;
  }

  return undefined;
}

function resolveCurrentStep(projectDir: string, task: TaskListItem): string | undefined {
  const runSlug = task.runSlug;
  if (!runSlug) {
    return undefined;
  }

  const worktreePath = resolveSafeWorktreePath(projectDir, task.worktreePath);
  if (worktreePath) {
    const worktreeStep = findRunningStepByRunSlug(worktreePath, runSlug);
    if (worktreeStep) {
      return worktreeStep;
    }
  }

  return findRunningStepByRunSlug(projectDir, runSlug);
}

function buildConfirmationMessage(task: TaskListItem): string {
  if (isStaleRunningTask(task.ownerPid)) {
    return `Mark running task "${task.name}" as failed?`;
  }
  return `Process ${task.ownerPid} may still be running. Mark "${task.name}" as failed anyway?`;
}

export async function forceFailRunningTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  if (task.kind !== 'running') {
    throw new Error(`forceFailRunningTask requires running task. received: ${task.kind}`);
  }

  const confirmed = await confirm(buildConfirmationMessage(task), false);
  if (!confirmed) {
    return false;
  }

  try {
    const step = resolveCurrentStep(projectDir, task);
    const runner = new TaskRunner(projectDir);
    runner.forceFailRunningTask(task.name, {
      step,
      error: FORCE_FAIL_ERROR,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    logError(`Failed to mark running task "${task.name}" as failed: ${message}`);
    log.error('Failed to force-fail running task', { name: task.name, filePath: task.filePath, error: message });
    return false;
  }

  success(`Marked running task as failed: ${task.name}`);
  log.info('Force-failed running task', { name: task.name, filePath: task.filePath });
  return true;
}
