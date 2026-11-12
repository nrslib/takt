import { TaskStore } from '../../infra/task/store.js';
import { GoalStore } from '../../infra/goals/store.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { resolveTaskContent } from '../../infra/task/mapper.js';
import { getProjectExecutionOwner } from '../../infra/task/project-execution-lock.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { registerProject } from '../../infra/config/global/projectRegistry.js';
import { ensureDaemon } from '../daemon/lifecycle.js';

const log = createLogger('manager-auto-run');

function hasRunnablePending(cwd: string): boolean {
  let runnable = false;
  for (const task of new TaskStore(cwd).read().tasks) {
    if (task.status !== 'pending' || task.goal_id === undefined) continue;
    try {
      const goal = new GoalStore(cwd).getSync(task.goal_id);
      if (isGoalPaused(goal) || goal.executionStatus === 'aborted') continue;
      resolveTaskContent(cwd, task);
      runnable = true;
    } catch (error) {
      log.error('Cannot resolve pending task for manager run', {
        taskName: task.name, error: sanitizeSensitiveText(getErrorMessage(error)),
      });
    }
  }
  return runnable;
}

export async function ensureManagerRun(cwd: string, options?: { notifyOnFailure: boolean }): Promise<void> {
  try {
    if (!resolveManagerConfig(cwd).autoRun || !hasRunnablePending(cwd)) return;
    if (getProjectExecutionOwner(cwd) !== undefined) return;
    await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd, command: 'manager', managerUsed: true });
    await ensureDaemon();
  } catch (error) {
    log.error('Cannot start manager run', { error: sanitizeSensitiveText(getErrorMessage(error)) });
    if (options?.notifyOnFailure === false) throw error;
    const notification = await notifyManagerTurnFailure(cwd, undefined, error);
    if (notification !== undefined) process.stderr.write(`${notification}\n`);
  }
}
