/**
 * /watch command implementation
 *
 * Watches .takt/tasks.yaml for pending tasks and executes them automatically.
 * Stays resident until Ctrl+C (SIGINT).
 */

import { TaskRunner, type TaskInfo, TaskWatcher } from '../../../infra/task/index.js';
import {
  header,
  info,
  success,
  status,
  blankLine,
  warn,
} from '../../../shared/ui/index.js';
import { executeRunTaskAndComplete, type RunTaskExecutionContext } from '../execute/runTaskExecution.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { ShutdownManager } from '../execute/shutdownManager.js';
import type { RunAllTasksOptions, TaskExecutionOptions } from '../execute/types.js';

function resolveWatchExecutionOptions(options?: RunAllTasksOptions): {
  agentOverrides?: TaskExecutionOptions;
  runContext?: RunTaskExecutionContext;
} {
  const agentOverrides: TaskExecutionOptions | undefined = options
    ? {
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.providerSource !== undefined ? { providerSource: options.providerSource } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
      }
    : undefined;

  return {
    agentOverrides,
    runContext: options?.ignoreExceed === true
      ? { ignoreIterationLimit: true }
      : undefined,
  };
}

/**
 * Watch for tasks and execute them as they appear.
 * Runs until Ctrl+C.
 */
export async function watchTasks(cwd: string, options?: RunAllTasksOptions): Promise<void> {
  const taskRunner = new TaskRunner(cwd, { onWarning: warn });
  const watcher = new TaskWatcher(cwd);
  const recovered = taskRunner.recoverInterruptedRunningTasks();
  const { agentOverrides, runContext } = resolveWatchExecutionOptions(options);

  let taskCount = 0;
  let successCount = 0;
  let failCount = 0;

  header('TAKT Watch Mode');
  info(`Watching: ${taskRunner.getTasksFilePath()}`);
  if (recovered > 0) {
    info(`Recovered ${recovered} interrupted running task(s) to pending.`);
  }
  info('Waiting for tasks... (Ctrl+C to stop)');
  blankLine();

  const shutdownManager = new ShutdownManager({
    callbacks: {
      onGraceful: () => {
        blankLine();
        info('Stopping watch...');
        watcher.stop();
      },
      onForceKill: () => {
        watcher.stop();
        process.exit(EXIT_SIGINT);
      },
    },
  });
  shutdownManager.install();

  try {
    await watcher.watch(async (task: TaskInfo) => {
      taskCount++;
      blankLine();
      info(`=== Task ${taskCount}: ${task.name} ===`);
      blankLine();

      const taskSuccess = await executeRunTaskAndComplete(
        task,
        taskRunner,
        cwd,
        agentOverrides,
        undefined,
        runContext,
      );

      if (taskSuccess) {
        successCount++;
      } else {
        failCount++;
      }

      blankLine();
      info('Waiting for tasks... (Ctrl+C to stop)');
    });
  } finally {
    shutdownManager.cleanup();
  }

  // Summary on exit
  if (taskCount > 0) {
    blankLine();
    header('Watch Summary');
    status('Total', String(taskCount));
    status('Success', String(successCount), successCount === taskCount ? 'green' : undefined);
    if (failCount > 0) {
      status('Failed', String(failCount), 'red');
    }
  }

  success('Watch stopped.');
}
