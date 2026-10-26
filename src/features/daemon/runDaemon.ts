import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerDaemonOwner, removeDaemonOwner } from '../../infra/daemon/owner.js';
import { getSelfProcessIdentity } from '../../infra/task/process.js';
import { TaskRunner } from '../../infra/task/runner.js';
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
import { failInterruptedTasksWithGoalEvents } from '../tasks/execute/claimTasks.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { createConversationService } from '../manager/conversationService.js';
import { createConversationRuntime } from '../manager/conversationRuntime.js';
import { createConversationIpcServer } from './conversationIpcServer.js';
import { createDaemonSlackPorts } from './slackPorts.js';

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
  const globalConfigDirectory = resolveDaemonConfigDirectory();
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Cannot identify daemon process');
  const { cliPath } = resolveCliInvocation('daemon');
  const owner = { pid: process.pid, identity, version: packageVersion, cliPath };
  if (!registerDaemonOwner(globalConfigDirectory, owner)) return;
  const appToken = process.env.TAKT_SLACK_APP_TOKEN;
  const botToken = process.env.TAKT_SLACK_BOT_TOKEN;
  // Slack credentials belong to the listener, not provider or tool subprocesses.
  delete process.env.TAKT_SLACK_APP_TOKEN;
  delete process.env.TAKT_SLACK_BOT_TOKEN;
  const controller = new AbortController();
  const managers = new Map<string, ReturnType<typeof createRunEventManager>>();
  const pollingFailures = new Map<string, PollingFailure>();
  const inFlight = new Map<string, Promise<void>>();
  const projectWork = new Map<string, boolean>();
  let domainGeneration = 0;
  const conversations = createConversationService({ configDirectory: globalConfigDirectory, owner,
    runtime: createConversationRuntime(globalConfigDirectory), onDomainChange: () => { domainGeneration++; projectWork.clear(); } });
  let ipc: Awaited<ReturnType<typeof createConversationIpcServer>> | undefined;
  let slack: Awaited<ReturnType<typeof createDaemonSlackPorts>> | undefined;
  const inspectProject = async (cwd: string): Promise<boolean> => {
    const errors: Array<{ error: unknown; failedAt: number }> = [];
    let hasWork = false;
    let patrolInterval: number | undefined;
    try {
      patrolInterval = resolveManagerConfig(cwd).patrolInterval;
      try {
        failInterruptedTasksWithGoalEvents(new TaskRunner(cwd, {
          onWarning: (warning) => log.warn('Daemon task recovery warning', { cwd, warning: sanitizeSensitiveText(warning) }),
        }), cwd);
      } catch (error) {
        errors.push({ error, failedAt: Date.now() });
        log.error('Cannot recover interrupted daemon project tasks', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
      }
      await enqueueDueGoalPatrols(cwd, patrolInterval);
      if (controller.signal.aborted) return false;
      let manager = managers.get(cwd);
      if (manager === undefined) {
        manager = createRunEventManager(cwd);
        managers.set(cwd, manager);
      }
      await manager.processPending(controller.signal, EVENTS_PER_PROJECT);
      if (controller.signal.aborted) return false;
      await ensureManagerRun(cwd, { notifyOnFailure: false });
    } catch (error) {
      errors.push({ error, failedAt: Date.now() });
      log.error('Cannot inspect daemon project', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
    }
    try {
      hasWork = await hasDaemonProjectWork(cwd, (error) => { errors.push({ error, failedAt: Date.now() }); });
    } catch (error) {
      errors.push({ error, failedAt: Date.now() });
      log.error('Cannot inspect daemon project work', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
    }
    if (errors.length === 0) {
      pollingFailures.delete(cwd);
      return hasWork;
    }
    const now = Date.now();
    const lastError = errors[errors.length - 1]!.error;
    const failure = pollingFailures.get(cwd) ?? { firstFailedAt: errors[0]!.failedAt, error: lastError };
    failure.error = lastError;
    pollingFailures.set(cwd, failure);
    if (patrolInterval !== undefined && now - (failure.lastNotifiedAt ?? failure.firstFailedAt) >= patrolInterval * 1000) {
      await notifyPollingFailure(cwd, failure);
    }
    return hasWork;
  };
  const stopAccepting = (): void => {
    conversations.stopAccepting();
    ipc?.stopAccepting();
    slack?.stopAccepting();
  };
  const stop = (): void => { stopAccepting(); controller.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    ipc = await createConversationIpcServer(globalConfigDirectory, owner, conversations);
    if (controller.signal.aborted) return;
    initDebugLogger({ enabled: true, logFile: join(globalConfigDirectory, 'logs', 'daemon.log') });
    log.info('Daemon started', { pid: process.pid, version: packageVersion, cliPath });
    while (!controller.signal.aborted) {
      // Leave the first polling interval for the launching manager to observe startup.
      try { await delay(POLL_INTERVAL_MS, undefined, { signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        break;
      }
      const projects = await listDaemonProjects(globalConfigDirectory);
      if (controller.signal.aborted) break;
      slack ??= await createDaemonSlackPorts({ projects, configDirectory: globalConfigDirectory, input: conversations,
        tokens: appToken && botToken ? { appToken, botToken } : undefined, signal: controller.signal });
      if (controller.signal.aborted) break;
      log.debug('Daemon projects', { projects });
      for (const cwd of projectWork.keys()) {
        if (!projects.includes(cwd)) projectWork.delete(cwd);
      }
      if (inFlight.size === 0 && projects.every((cwd) => projectWork.get(cwd) === false)
        && conversations.attachmentCount === 0 && conversations.activeOperationCount === 0 && !slack.listening) {
        if (ipc.initializingCount !== 0) continue;
        stopAccepting();
        break;
      }
      for (const cwd of projects) {
        if (controller.signal.aborted) break;
        if (inFlight.has(cwd)) continue;
        const inspectedGeneration = domainGeneration;
        const processing = inspectProject(cwd)
          .then((hasWork) => { if (domainGeneration === inspectedGeneration) projectWork.set(cwd, hasWork); })
          .catch((error: unknown) => {
            log.error('Cannot inspect daemon project', { cwd, error: sanitizeSensitiveText(getErrorMessage(error)) });
          })
          .finally(() => { inFlight.delete(cwd); });
        inFlight.set(cwd, processing);
      }
    }
  } finally {
    stop();
    try { await conversations.close(); }
    catch { log.error('Cannot close daemon conversations'); }
    await Promise.all(inFlight.values());
    for (const [cwd, failure] of pollingFailures) {
      if (failure.lastNotifiedAt === undefined) await notifyPollingFailure(cwd, failure);
    }
    for (const [cwd, manager] of managers) {
      try { await manager.close(); }
      catch (error) { log.error('Cannot close daemon project manager', { cwd, error: getErrorMessage(error) }); }
    }
    try { await slack?.close(); await ipc?.close(); }
    finally {
      removeDaemonOwner(globalConfigDirectory, owner);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      log.info('Daemon stopped', { pid: process.pid });
    }
  }
}
