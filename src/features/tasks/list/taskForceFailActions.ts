import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner, isStaleRunningTask } from '../../../infra/task/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { success, warn, error as logError } from '../../../shared/ui/index.js';
import {
  createLogger,
  getErrorMessage,
  sanitizeTerminalText,
} from '../../../shared/utils/index.js';
import { createTaskRunForceFailStorage } from './taskRunForceFailStorage.js';

const log = createLogger('list-tasks');
const FORCE_FAIL_ERROR = 'Manually marked as failed';

function buildConfirmationMessage(task: TaskListItem): string {
  if (isStaleRunningTask(task.ownerPid)) {
    return `Mark running task "${task.name}" as failed?`;
  }
  return `Process ${task.ownerPid} may still be running. Mark "${task.name}" as failed anyway?`;
}

/**
 * Mark a running task as failed after user confirmation.
 *
 * @param task - Task that must have the running kind
 * @param projectDir - Project directory used to resolve the task and run state; run state may be located in the task worktree
 * @returns true when the task is marked as failed, or false when confirmation is declined or force-fail processing fails
 * @throws Error if task.kind is not 'running' or the confirmation prompt rejects
 */
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
    const runHandle = createTaskRunForceFailStorage({
      task,
      projectDir,
      onWarning: warn,
    });
    const finalization = await runHandle?.terminalize(FORCE_FAIL_ERROR);
    const runner = new TaskRunner(projectDir, { onWarning: warn });
    runner.forceFailRunningTask(task.name, {
      step: runHandle?.currentStep,
      error: FORCE_FAIL_ERROR,
    });
    for (const issue of finalization?.issues ?? []) {
      warn(
        `Run was force-failed, but post-commit finalization failed: `
        + getErrorMessage(issue),
      );
    }
  } catch (err) {
    const message = getErrorMessage(err);
    logError(sanitizeTerminalText(
      `Failed to mark running task "${task.name}" as failed: ${message}`,
    ));
    log.error('Failed to force-fail running task', { name: task.name, filePath: task.filePath, error: message });
    return false;
  }

  success(`Marked running task as failed: ${task.name}`);
  log.info('Force-failed running task', { name: task.name, filePath: task.filePath });
  return true;
}
