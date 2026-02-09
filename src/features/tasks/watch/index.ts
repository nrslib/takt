/**
 * /watch command implementation
 *
 * Watches .takt/tasks.yaml for pending tasks and executes them automatically.
 * Stays resident until Ctrl+C (SIGINT).
 */

import { TaskRunner, type TaskInfo, TaskWatcher } from '../../../infra/task/index.js';
import { getCurrentPiece } from '../../../infra/config/index.js';
import {
  header,
  info,
  success,
  status,
  blankLine,
} from '../../../shared/ui/index.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import type { TaskExecutionOptions } from '../execute/types.js';

/**
 * Watch for tasks and execute them as they appear.
 * Runs until Ctrl+C.
 */
export async function watchTasks(cwd: string, options?: TaskExecutionOptions): Promise<void> {
  const pieceName = getCurrentPiece(cwd) || DEFAULT_PIECE_NAME;
  const taskRunner = new TaskRunner(cwd);
  const watcher = new TaskWatcher(cwd);
  const recovered = taskRunner.recoverInterruptedRunningTasks();

  let taskCount = 0;
  let successCount = 0;
  let failCount = 0;

  header('TAKT Watch Mode');
  info(`Piece: ${pieceName}`);
  info(`Watching: ${taskRunner.getTasksDir()}`);
  if (recovered > 0) {
    info(`Recovered ${recovered} interrupted running task(s) to pending.`);
  }
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

      const taskSuccess = await executeAndCompleteTask(task, taskRunner, cwd, pieceName, options);

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
