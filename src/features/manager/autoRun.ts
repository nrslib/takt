import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TaskStore } from '../../infra/task/store.js';
import { GoalStore } from '../../infra/goals/store.js';
import { readManagerEvents } from '../../infra/goals/events.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { resolveTaskContent } from '../../infra/task/mapper.js';
import { getProjectExecutionOwner } from '../../infra/task/project-execution-lock.js';
import { notifyManagerTurnFailure } from './turnFailureNotification.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { createLogger } from '../../shared/utils/debug.js';
import { MANAGER_GOAL_TASKS_ENV } from '../../shared/constants.js';
import { resolveCliInvocation } from '../../shared/utils/cli-invocation.js';

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

function hasManagerWork(cwd: string): boolean {
  return hasRunnablePending(cwd) || readManagerEvents(cwd).some(({ event }) =>
    !isGoalPaused(new GoalStore(cwd).getSync(event.goalId)));
}

export async function ensureManagerRun(cwd: string): Promise<void> {
  let descriptor: number | undefined;
  try {
    if (!resolveManagerConfig(cwd).autoRun || !hasManagerWork(cwd)) return;
    if (getProjectExecutionOwner(cwd) !== undefined) return;
    const logs = join(cwd, '.takt', 'manager-logs');
    ensurePrivateDirectory(logs);
    descriptor = openSync(join(logs, `run-${randomUUID()}.log`), 'wx', 0o600);
    const { args } = resolveCliInvocation('run');
    const env = buildChildProcessEnv();
    env[MANAGER_GOAL_TASKS_ENV] = '1';
    if (!hasManagerWork(cwd) || getProjectExecutionOwner(cwd) !== undefined) return;
    const child = spawn(process.execPath, args, {
      cwd, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor], env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch (error) {
    log.error('Cannot start manager run', { error: sanitizeSensitiveText(getErrorMessage(error)) });
    const notification = await notifyManagerTurnFailure(cwd, undefined, error);
    if (notification !== undefined) process.stderr.write(`${notification}\n`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
