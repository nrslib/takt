import {
  acquireProjectExecutionLock, type ProjectExecutionKind,
} from '../../../infra/task/project-execution-lock.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { ShutdownManager } from './shutdownManager.js';
import type { WorkerPoolShutdownSignals } from './parallelExecution.js';

export async function withProjectExecution<Result>(
  cwd: string,
  kind: ProjectExecutionKind,
  execute: (signals: WorkerPoolShutdownSignals) => Promise<Result>,
): Promise<Result> {
  const lock = acquireProjectExecutionLock(cwd, kind);
  const scheduling = new AbortController();
  const task = new AbortController();
  let shutdownManager: ShutdownManager | undefined;
  const onExit = (): void => lock.release();
  try {
    // process.exit bypasses finally, including forced SIGINT shutdown.
    process.on('exit', onExit);
    shutdownManager = new ShutdownManager({
      callbacks: {
        onGraceful: () => {
          try {
            lock.updateState('stopping');
          } finally {
            scheduling.abort();
            if (kind === 'run') task.abort();
          }
        },
        onForceKill: () => process.exit(EXIT_SIGINT),
      },
    });
    shutdownManager.install();
    lock.updateState('running');
    return await execute({ schedulingSignal: scheduling.signal, taskAbortSignal: task.signal });
  } finally {
    try {
      lock.updateState('stopping');
    } finally {
      try {
        lock.release();
      } finally {
        shutdownManager?.cleanup();
        process.removeListener('exit', onExit);
      }
    }
  }
}
