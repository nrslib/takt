/**
 * /watch command implementation
 *
 * Watches .takt/tasks/ for new task files and executes them automatically.
 * Stays resident until Ctrl+C (SIGINT).
 */

import { TaskRunner, type TaskInfo } from '../task/index.js';
import { TaskWatcher } from '../task/watcher.js';
import { getCurrentWorkflow } from '../config/paths.js';
import {
  header,
  info,
  success,
  status,
  blankLine,
} from '../utils/ui.js';
import { executeAndCompleteTask } from './taskExecution.js';
import { DEFAULT_WORKFLOW_NAME } from '../constants.js';
import type { TaskExecutionOptions } from './taskExecution.js';

/**
 * Watch for tasks and execute them as they appear.
 * Runs until Ctrl+C.
 */
export async function watchTasks(cwd: string, options?: TaskExecutionOptions): Promise<void> {
  const workflowName = getCurrentWorkflow(cwd) || DEFAULT_WORKFLOW_NAME;
  const taskRunner = new TaskRunner(cwd);
  const watcher = new TaskWatcher(cwd);

  let taskCount = 0;
  let successCount = 0;
  let failCount = 0;

  header('TAKT Watch Mode');
  info(`Workflow: ${workflowName}`);
  info(`Watching: ${taskRunner.getTasksDir()}`);
  info('Waiting for tasks... (Ctrl+C to stop)');
  blankLine();

  // Graceful shutdown on SIGINT
  const onSigInt = () => {
    blankLine();
    info('Stopping watch...');
    watcher.stop();
  };
  process.on('SIGINT', onSigInt);

  try {
    await watcher.watch(async (task: TaskInfo) => {
      taskCount++;
      blankLine();
      info(`=== Task ${taskCount}: ${task.name} ===`);
      blankLine();

      const taskSuccess = await executeAndCompleteTask(task, taskRunner, cwd, workflowName, options);

      if (taskSuccess) {
        successCount++;
      } else {
        failCount++;
      }

      blankLine();
      info('Waiting for tasks... (Ctrl+C to stop)');
    });
  } finally {
    process.removeListener('SIGINT', onSigInt);
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
