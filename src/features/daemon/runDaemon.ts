import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { registerDaemonOwner, removeDaemonOwner } from '../../infra/daemon/owner.js';
import { getSelfProcessIdentity } from '../../infra/task/process.js';
import { packageVersion } from '../../shared/package-info.js';
import { resolveCliInvocation } from '../../shared/utils/cli-invocation.js';
import { createLogger, initDebugLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { hasDaemonProjectWork, listDaemonProjects } from './projects.js';
import { createRunEventManager } from '../manager/runEventManager.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { enqueueDueGoalPatrols } from '../manager/patrol.js';
import { notifyManagerTurnFailure } from '../manager/turnFailureNotification.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

const POLL_INTERVAL_MS = 500;
const EVENTS_PER_PROJECT = 10;
const log = createLogger('daemon');

interface PollingFailure {
  firstFailedAt: number;
  lastNotifiedAt?: number;
  error: unknown;
}

async function notifyPollingFailure(cwd: string, failure: PollingFailure): Promise<void> {
  const notification = await notifyManagerTurnFailure(cwd, undefined, failure.error);
  if (notification !== undefined) process.stderr.write(`${notification}\n`);
  failure.lastNotifiedAt = Date.now();
}

export async function runDaemon(): Promise<void> {
  const globalConfigDirectory = resolve(getGlobalConfigDir());
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Cannot identify daemon process');
  const { cliPath } = resolveCliInvocation('daemon');
  if (!registerDaemonOwner(globalConfigDirectory, { pid: process.pid, identity, version: packageVersion, cliPath })) return;
  const controller = new AbortController();
  const managers = new Map<string, ReturnType<typeof createRunEventManager>>();
  const pollingFailures = new Map<string, PollingFailure>();
  const stop = (): void => { controller.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    initDebugLogger({ enabled: true, logFile: join(globalConfigDirectory, 'logs', 'daemon.log') });
    log.info('Daemon started', { pid: process.pid, version: packageVersion, cliPath });
    while (!controller.signal.aborted) {
      // Leave the first polling interval for the launching manager to observe startup.
      try { await delay(POLL_INTERVAL_MS, undefined, { signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        break;
      }
      let hasWork = false;
      const projects = await listDaemonProjects(globalConfigDirectory);
      log.debug('Daemon projects', { projects });
      for (const cwd of projects) {
        if (controller.signal.aborted) break;
        const errors: Array<{ error: unknown; failedAt: number }> = [];
        let patrolInterval: number | undefined;
        try {
          patrolInterval = resolveManagerConfig(cwd).patrolInterval;
          await enqueueDueGoalPatrols(cwd, patrolInterval);
          let manager = managers.get(cwd);
          if (manager === undefined) {
            manager = createRunEventManager(cwd);
            managers.set(cwd, manager);
          }
          await manager.processPending(controller.signal, EVENTS_PER_PROJECT);
          if (controller.signal.aborted) break;
          await ensureManagerRun(cwd, { notifyOnFailure: false });
        } catch (error) {
          errors.push({ error, failedAt: Date.now() });
          log.error('Cannot inspect daemon project', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
        }
        try {
          if (await hasDaemonProjectWork(cwd, (error) => { errors.push({ error, failedAt: Date.now() }); })) hasWork = true;
        } catch (error) {
          errors.push({ error, failedAt: Date.now() });
          log.error('Cannot inspect daemon project work', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
        }
        if (errors.length === 0) {
          pollingFailures.delete(cwd);
          continue;
        }
        const now = Date.now();
        const lastError = errors[errors.length - 1]!.error;
        const failure = pollingFailures.get(cwd) ?? { firstFailedAt: errors[0]!.failedAt, error: lastError };
        failure.error = lastError;
        pollingFailures.set(cwd, failure);
        if (patrolInterval !== undefined && now - (failure.lastNotifiedAt ?? failure.firstFailedAt) >= patrolInterval * 1000) {
          await notifyPollingFailure(cwd, failure);
        }
      }
      if (!hasWork) break;
    }
  } finally {
    for (const [cwd, failure] of pollingFailures) {
      if (failure.lastNotifiedAt === undefined) await notifyPollingFailure(cwd, failure);
    }
    for (const [cwd, manager] of managers) {
      try { await manager.close(); }
      catch (error) { log.error('Cannot close daemon project manager', { cwd, error: getErrorMessage(error) }); }
    }
    removeDaemonOwner(globalConfigDirectory, process.pid);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    log.info('Daemon stopped', { pid: process.pid });
  }
}
