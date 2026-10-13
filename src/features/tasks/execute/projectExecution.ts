import {
  acquireProjectExecutionLock, ProjectExecutionAlreadyRunningError, type ProjectExecutionKind, type ProjectExecutionLock,
} from '../../../infra/task/project-execution-lock.js';
import { forceExitAfterOpenCodeCleanup } from './forceShutdown.js';
import { ShutdownManager } from './shutdownManager.js';
import type { WorkerPoolShutdownSignals } from './parallelExecution.js';
import { createLogger } from '../../../shared/utils/debug.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';

const log = createLogger('project-execution');

interface ProjectExecutionContext extends WorkerPoolShutdownSignals {
  onTasksClaimed(): void;
}

export async function withProjectExecution<Result>(
  cwd: string,
  kind: ProjectExecutionKind,
  execute: (signals: ProjectExecutionContext) => Promise<Result>,
  automaticRun?: boolean,
): Promise<Result | undefined> {
  let lock: ProjectExecutionLock;
  try { lock = acquireProjectExecutionLock(cwd, kind); }
  catch (error) {
    if (automaticRun === true && kind === 'run' && error instanceof ProjectExecutionAlreadyRunningError) return undefined;
    throw error;
  }
  const scheduling = new AbortController();
  const task = new AbortController();
  let shutdownManager: ShutdownManager | undefined;
  let forceShutdownStarted = false;
  let tasksClaimed = false;
  let executionCompleted = false;
  const onExit = (): void => {
    try {
      lock.release();
    } finally {
      shutdownManager?.cleanup();
      process.removeListener('exit', onExit);
    }
  };
  try {
    // process.exit bypasses finally, including forced SIGINT shutdown.
    process.on('exit', onExit);
    shutdownManager = new ShutdownManager({
      callbacks: {
        onGraceful: () => {
          try {
            lock.updateState('stopping');
          } catch (error: unknown) {
            // A failed state write must not interrupt shutdown timer registration.
            log.error('Failed to update project execution lock while stopping', {
              error: sanitizeSensitiveText(getErrorMessage(error)),
            });
          } finally {
            scheduling.abort();
            if (kind === 'run') task.abort();
          }
        },
        onForceKill: () => {
          forceShutdownStarted = true;
          void forceExitAfterOpenCodeCleanup();
        },
      },
    });
    shutdownManager.install();
    lock.updateState('running');
    const result = await execute({
      schedulingSignal: scheduling.signal, taskAbortSignal: task.signal,
      onTasksClaimed: () => { tasksClaimed = true; },
    });
    executionCompleted = true;
    return result;
  } finally {
    // Tasks may settle while forced cleanup is pending; retain ownership until exit.
    if (!forceShutdownStarted) {
      try {
        lock.updateState('stopping');
      } finally {
        onExit();
        // Retry normal empty-queue exits, but do not loop on failures before claiming tasks.
        if (!scheduling.signal.aborted && (automaticRun !== true || tasksClaimed || executionCompleted)) {
          try {
            const { ensureManagerRun } = await import('../../manager/autoRun.js');
            await ensureManagerRun(cwd);
          } catch (error) {
            log.error('Cannot start manager run after releasing execution ownership', { error: sanitizeSensitiveText(getErrorMessage(error)) });
          }
        }
      }
    }
  }
}
