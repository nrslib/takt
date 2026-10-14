import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, removeDaemonOwner, writeDaemonOwner } from '../../infra/daemon/owner.js';
import { getSelfProcessIdentity } from '../../infra/task/process.js';
import { packageVersion } from '../../shared/package-info.js';
import { resolveCliInvocation } from '../../shared/utils/cli-invocation.js';
import { createLogger, initDebugLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { hasDaemonProjectWork, listDaemonProjects } from './projects.js';
import { createRunEventManager } from '../manager/runEventManager.js';
import { ensureManagerRun } from '../manager/autoRun.js';

const POLL_INTERVAL_MS = 500;
const EVENTS_PER_PROJECT = 10;
const log = createLogger('daemon');

export async function runDaemon(): Promise<void> {
  const globalConfigDirectory = resolve(getGlobalConfigDir());
  const existing = readDaemonOwner(globalConfigDirectory);
  if (existing !== undefined && isDaemonOwnerRunning(existing)) return;
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Cannot identify daemon process');
  const { cliPath } = resolveCliInvocation('daemon');
  const controller = new AbortController();
  const managers = new Map<string, ReturnType<typeof createRunEventManager>>();
  const stop = (): void => { controller.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    initDebugLogger({ enabled: true, logFile: join(globalConfigDirectory, 'logs', 'daemon.log') });
    writeDaemonOwner(globalConfigDirectory, { pid: process.pid, identity, version: packageVersion, cliPath });
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
        try {
          let manager = managers.get(cwd);
          if (manager === undefined) {
            manager = createRunEventManager(cwd);
            managers.set(cwd, manager);
          }
          await manager.processPending(controller.signal, EVENTS_PER_PROJECT);
          if (controller.signal.aborted) break;
          await ensureManagerRun(cwd);
          if (await hasDaemonProjectWork(cwd)) hasWork = true;
        } catch (error) {
          hasWork = true;
          log.error('Cannot inspect daemon project', { cwd, error: getErrorMessage(error) });
        }
      }
      if (!hasWork) break;
    }
  } finally {
    for (const [cwd, manager] of managers) {
      try { await manager.close(); }
      catch (error) { log.error('Cannot close daemon project manager', { cwd, error: getErrorMessage(error) }); }
    }
    removeDaemonOwner(globalConfigDirectory);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    log.info('Daemon stopped', { pid: process.pid });
  }
}
