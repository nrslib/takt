import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TaskStore } from '../../infra/task/store.js';
import { GoalStore } from '../../infra/goals/store.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { withGoalExecutionLock } from '../../infra/goals/execution-lock.js';
import { resolveTaskContent } from '../../infra/task/mapper.js';
import { getProjectExecutionOwner } from '../../infra/task/project-execution-lock.js';
import { recordManagerRunFailure } from '../../infra/task/manager-run-state.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GOAL_TURN_OWNERS_ENV } from '../../infra/goals/turn-lock.js';
import { GOAL_EVENT_CONTEXT_ENV } from '../../infra/goals/operations.js';
import { createLogger } from '../../shared/utils/debug.js';
import { MANAGER_GOAL_TASKS_ENV } from '../../shared/constants.js';

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

export async function ensureManagerRun(cwd: string): Promise<void> {
  let descriptor: number | undefined;
  try {
    if (!resolveManagerConfig(cwd).autoRun || !hasRunnablePending(cwd)) return;
    if (getProjectExecutionOwner(cwd) !== undefined) return;
    const logs = join(cwd, '.takt', 'manager-logs');
    ensurePrivateDirectory(logs);
    descriptor = openSync(join(logs, `run-${randomUUID()}.log`), 'wx', 0o600);
    const built = fileURLToPath(new URL('../../app/cli/index.js', import.meta.url));
    const args = existsSync(built) ? [built, 'run'] : [
      '--import', createRequire(import.meta.url).resolve('tsx/esm'),
      fileURLToPath(new URL('../../app/cli/index.ts', import.meta.url)), 'run',
    ];
    const env = buildChildProcessEnv();
    delete env[GOAL_TURN_OWNERS_ENV];
    delete env[GOAL_EVENT_CONTEXT_ENV];
    env[MANAGER_GOAL_TASKS_ENV] = '1';
    const child = withGoalExecutionLock(cwd, () => {
      if (!hasRunnablePending(cwd) || getProjectExecutionOwner(cwd) !== undefined) return undefined;
      return spawn(process.execPath, args, {
        cwd, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor], env,
      });
    });
    if (child === undefined) return;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch (error) {
    recordManagerRunFailure(cwd, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
