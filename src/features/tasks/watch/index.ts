/**
 * Watches .takt/tasks.yaml using the shared queue worker pool.
 * Stays resident until Ctrl+C (SIGINT).
 */

import { TaskRunner } from '../../../infra/task/index.js';
import { header, info, success, blankLine, warn } from '../../../shared/ui/index.js';
import { runWithWorkerPool } from '../execute/parallelExecution.js';
import type { RunAllTasksOptions, TaskExecutionOptions } from '../execute/types.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';

export async function watchTasks(cwd: string, options?: RunAllTasksOptions): Promise<void> {
  const config = resolveWorkflowConfigValues(cwd, [
    'concurrency', 'taskPollIntervalMs', 'autoRequeueMaxAttempts', 'ignoreExceed',
  ]);
  const agentOverrides: TaskExecutionOptions | undefined = options
    ? {
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.providerSource !== undefined ? { providerSource: options.providerSource } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
        ...(options.autoStrategy !== undefined ? { autoStrategy: options.autoStrategy } : {}),
      }
    : undefined;
  const runOptions = {
    ...(options?.ignoreExceed === true || config.ignoreExceed === true
      ? { ignoreIterationLimit: true }
      : {}),
    autoRequeueMaxAttempts: config.autoRequeueMaxAttempts,
  };
  const taskRunner = new TaskRunner(cwd, { onWarning: warn });
  const failedInterrupted = taskRunner.failInterruptedRunningTasks();

  header('TAKT Watch Mode');
  info(`Watching: ${taskRunner.getTasksFilePath()}`);
  if (failedInterrupted > 0) {
    info(`Marked ${failedInterrupted} interrupted running task(s) as failed.`);
  }
  info('Waiting for tasks... (Ctrl+C to stop)');
  blankLine();

  await runWithWorkerPool(
    taskRunner,
    [],
    config.concurrency,
    cwd,
    agentOverrides,
    runOptions,
    config.taskPollIntervalMs,
    'watch',
  );

  success('Watch stopped.');
}
