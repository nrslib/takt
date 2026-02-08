/**
 * Parallel task execution strategy.
 *
 * Runs tasks in batches of up to `concurrency` tasks at a time.
 * Uses a single AbortController shared across all tasks in all batches.
 */

import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { info, blankLine } from '../../../shared/ui/index.js';
import { executeAndCompleteTask } from './taskExecution.js';
import { installSigIntHandler } from './sigintHandler.js';
import type { TaskExecutionOptions } from './types.js';

interface BatchResult {
  success: number;
  fail: number;
}

/**
 * Run tasks in parallel batches.
 *
 * @returns Aggregated success/fail counts across all batches
 */
export async function runParallel(
  taskRunner: TaskRunner,
  initialTasks: TaskInfo[],
  concurrency: number,
  cwd: string,
  pieceName: string,
  options?: TaskExecutionOptions,
): Promise<BatchResult> {
  const abortController = new AbortController();
  const { cleanup } = installSigIntHandler(() => abortController.abort());

  let successCount = 0;
  let failCount = 0;

  try {
    let batch = initialTasks;
    while (batch.length > 0) {
      blankLine();
      info(`=== Running batch of ${batch.length} task(s) ===`);
      for (const task of batch) {
        info(`  - ${task.name}`);
      }
      blankLine();

      const results = await Promise.all(
        batch.map((task) =>
          executeAndCompleteTask(task, taskRunner, cwd, pieceName, options, {
            abortSignal: abortController.signal,
          }),
        ),
      );

      for (const taskSuccess of results) {
        if (taskSuccess) {
          successCount++;
        } else {
          failCount++;
        }
      }

      if (abortController.signal.aborted) {
        break;
      }

      batch = taskRunner.getNextTasks(concurrency);
    }
  } finally {
    cleanup();
  }

  return { success: successCount, fail: failCount };
}
