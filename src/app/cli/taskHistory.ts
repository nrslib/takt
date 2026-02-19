import { isStaleRunningTask, TaskRunner } from '../../infra/task/index.js';
import {
  type TaskHistorySummaryItem,
  normalizeTaskHistorySummary,
} from '../../features/interactive/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { error as logError } from '../../shared/ui/index.js';

/**
 * Load and normalize task history for interactive context.
 */
function toTaskHistoryItems(cwd: string): TaskHistorySummaryItem[] {
  const runner = new TaskRunner(cwd);
  const tasks = runner.listAllTaskItems();

  const historyItems: TaskHistorySummaryItem[] = [];
  for (const task of tasks) {
    if (task.kind === 'failed' || task.kind === 'completed') {
      historyItems.push({
        worktreeId: task.worktreePath ?? task.name,
        status: task.kind,
        startedAt: task.startedAt ?? '',
        completedAt: task.completedAt ?? '',
        finalResult: task.kind,
        failureSummary: task.failure?.error,
        logKey: task.branch ?? task.worktreePath ?? task.name,
      });
      continue;
    }

    if (task.kind === 'running' && isStaleRunningTask(task.ownerPid)) {
      historyItems.push({
        worktreeId: task.worktreePath ?? task.name,
        status: 'interrupted',
        startedAt: task.startedAt ?? '',
        completedAt: task.completedAt ?? '',
        finalResult: 'interrupted',
        failureSummary: undefined,
        logKey: task.branch ?? task.worktreePath ?? task.name,
      });
    }
  }

  return historyItems;
}

export function loadTaskHistory(cwd: string, lang: 'en' | 'ja'): TaskHistorySummaryItem[] {
  try {
    return normalizeTaskHistorySummary(toTaskHistoryItems(cwd), lang);
  } catch (err) {
    logError(getErrorMessage(err));
    return [];
  }
}

