import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TaskStore } from '../../infra/task/store.js';
import { resolveTaskContent } from '../../infra/task/mapper.js';
import { getProjectExecutionOwner } from '../../infra/task/project-execution-lock.js';
import { getProcessIdentity, getSelfProcessIdentity } from '../../infra/task/process.js';
import {
  MANAGER_RUN_TOKEN_ENV, processRecord, readManagerRunState, recoverManagerReservation, recordManagerRunFailure,
  withProjectRunCoordination, writeManagerRunState,
} from '../../infra/task/manager-run-state.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GOAL_TURN_OWNERS_ENV } from '../../infra/goals/turn-lock.js';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('manager-auto-run');

function hasRunnablePending(cwd: string): boolean {
  let runnable = false;
  for (const task of new TaskStore(cwd).read().tasks) {
    if (task.status !== 'pending') continue;
    try {
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

export async function ensureManagerRun(cwd: string, trigger: 'turn-ended' | 'recovery'): Promise<void> {
  let token: string | undefined;
  let descriptor: number | undefined;
  let exited = false;
  try {
    const autoRun = resolveManagerConfig(cwd).autoRun;
    token = withProjectRunCoordination(cwd, () => {
      let state = recoverManagerReservation(cwd);
      if (trigger === 'recovery' && !state.requested) return undefined;
      const runnable = hasRunnablePending(cwd);
      if (trigger === 'turn-ended' && runnable && !state.requested) {
        state = { ...state, requested: true };
        writeManagerRunState(cwd, state);
      }
      if (!autoRun) return undefined;
      if (getProjectExecutionOwner(cwd) !== undefined) return undefined;
      if (state.reservation !== undefined && state.reservation.adoptedOwnerId === undefined) return undefined;
      if (!runnable) {
        if (state.requested) writeManagerRunState(cwd, { ...state, requested: false });
        return undefined;
      }
      const identity = getSelfProcessIdentity();
      if (identity === undefined) throw new Error('Cannot reserve manager run: process identity unavailable');
      const token = randomUUID();
      writeManagerRunState(cwd, {
        ...state,
        reservation: { token, launcher: processRecord(process.pid, identity) },
      });
      return token;
    });
    if (token === undefined) return;
    const logs = join(cwd, '.takt', 'manager-logs');
    ensurePrivateDirectory(logs);
    descriptor = openSync(join(logs, `run-${token}.log`), 'wx', 0o600);
    const built = fileURLToPath(new URL('../../app/cli/index.js', import.meta.url));
    const args = existsSync(built) ? [built, 'run'] : [
      '--import', createRequire(import.meta.url).resolve('tsx/esm'),
      fileURLToPath(new URL('../../app/cli/index.ts', import.meta.url)), 'run',
    ];
    const env = buildChildProcessEnv();
    delete env[GOAL_TURN_OWNERS_ENV];
    const child = spawn(process.execPath, args, {
      cwd, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor],
      env: { ...env, [MANAGER_RUN_TOKEN_ENV]: token },
    });
    let startupError: Error | undefined;
    child.once('error', (error) => { startupError = error; });
    child.once('exit', () => { exited = true; });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        if (child.pid === undefined) reject(new Error('Manager run started without a PID'));
        else { child.unref(); resolve(child.pid); }
      });
    });
    let identity = getProcessIdentity(pid);
    withProjectRunCoordination(cwd, () => {
      const state = readManagerRunState(cwd);
      const reservation = state.reservation;
      if (reservation !== undefined && reservation.token === token) writeManagerRunState(cwd, {
        ...state, reservation: { ...reservation, child: { pid, startTime: identity?.startTime } },
      });
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      if (identity === undefined && !exited) {
        identity = getProcessIdentity(pid);
        const childIdentity = identity;
        if (childIdentity !== undefined) withProjectRunCoordination(cwd, () => {
          const state = readManagerRunState(cwd);
          const reservation = state.reservation;
          if (reservation !== undefined && reservation.token === token) writeManagerRunState(cwd, {
            ...state, reservation: { ...reservation, child: processRecord(pid, childIdentity) },
          });
        });
      }
      const reservation = readManagerRunState(cwd).reservation;
      if (reservation?.token === token && reservation.adoptedOwnerId !== undefined) break;
      if (startupError !== undefined) throw startupError;
      if (exited) throw new Error('Manager run exited before adopting startup reservation');
      if (Date.now() >= deadline) throw new Error('Manager run did not acknowledge startup reservation');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    try {
      if (token !== undefined) withProjectRunCoordination(cwd, () => {
        const state = readManagerRunState(cwd);
        const reservation = state.reservation !== undefined && state.reservation.token === token
          && (state.reservation.child === undefined || exited)
          ? undefined : state.reservation;
        writeManagerRunState(cwd, { ...state, reservation });
      });
    } catch (cleanupError) {
      recordManagerRunFailure(cwd, cleanupError);
    }
    recordManagerRunFailure(cwd, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
