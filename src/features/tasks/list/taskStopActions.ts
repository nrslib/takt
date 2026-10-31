import type { Language } from '../../../core/models/types.js';
import { TaskRunner, isStaleRunningTask, type TaskListItem } from '../../../infra/task/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { info, warn, error as logError } from '../../../shared/ui/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';

export async function stopRunningTask(task: TaskListItem, projectDir: string, lang: Language): Promise<boolean> {
  if (task.kind !== 'running') {
    throw new Error(`stopRunningTask requires running task. received: ${task.kind}`);
  }
  if (isStaleRunningTask(task.ownerPid, task.ownerStartTime)) {
    warn(getLabel('taskStop.staleOwner', lang));
    return false;
  }
  if (task.executionId === undefined) {
    warn(getLabel('taskStop.missingExecutionId', lang));
    return false;
  }
  const confirmed = await confirm(getLabel('taskStop.confirm', lang, {
    name: sanitizeTerminalText(task.name),
  }), false);
  if (!confirmed) return false;

  try {
    const runner = new TaskRunner(projectDir);
    runner.requestTaskStop(task.goalId, task.name, task.executionId);
  } catch (error) {
    logError(getLabel('taskStop.rejected', lang, { reason: sanitizeTerminalText(getErrorMessage(error)) }));
    return false;
  }
  info(getLabel('taskStop.requested', lang, { name: sanitizeTerminalText(task.name) }));
  return true;
}
