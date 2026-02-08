/**
 * Worker pool task execution strategy.
 *
 * Runs tasks using a fixed-size worker pool. Each worker picks up the next
 * available task as soon as it finishes the current one, maximizing slot
 * utilization. Works for both sequential (concurrency=1) and parallel
 * (concurrency>1) execution through the same code path.
 */

import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { info, blankLine } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { executeAndCompleteTask } from './taskExecution.js';
import { installSigIntHandler } from './sigintHandler.js';
import type { TaskExecutionOptions } from './types.js';

export interface WorkerPoolResult {
  success: number;
  fail: number;
}

/**
 * Run tasks using a worker pool with the given concurrency.
 *
 * Algorithm:
 * 1. Create a shared AbortController
 * 2. Maintain a queue of pending tasks and a set of active promises
 * 3. Fill available slots from the queue
 * 4. Wait for any active task to complete (Promise.race)
 * 5. Record result, fill freed slot from queue
 * 6. Repeat until queue is empty and all active tasks complete
 */
export async function runWithWorkerPool(
  taskRunner: TaskRunner,
  initialTasks: TaskInfo[],
  concurrency: number,
  cwd: string,
  pieceName: string,
  options?: TaskExecutionOptions,
): Promise<WorkerPoolResult> {
  const abortController = new AbortController();
  const { cleanup } = installSigIntHandler(() => abortController.abort());

  let successCount = 0;
  let failCount = 0;

  const queue = [...initialTasks];
  const active = new Map<Promise<boolean>, TaskInfo>();
  const colorCounter = { value: 0 };

  try {
    while (queue.length > 0 || active.size > 0) {
      if (abortController.signal.aborted) {
        break;
      }

      fillSlots(queue, active, concurrency, taskRunner, cwd, pieceName, options, abortController, colorCounter);

      if (active.size === 0) {
        break;
      }

      const settled = await Promise.race(
        [...active.keys()].map((p) => p.then(
          (result) => ({ promise: p, result }),
          () => ({ promise: p, result: false }),
        )),
      );

      const task = active.get(settled.promise);
      active.delete(settled.promise);

      if (task) {
        if (settled.result) {
          successCount++;
        } else {
          failCount++;
        }
      }

      if (!abortController.signal.aborted && queue.length === 0) {
        const nextTasks = taskRunner.claimNextTasks(concurrency - active.size);
        queue.push(...nextTasks);
      }
    }
  } finally {
    cleanup();
  }

  return { success: successCount, fail: failCount };
}

function fillSlots(
  queue: TaskInfo[],
  active: Map<Promise<boolean>, TaskInfo>,
  concurrency: number,
  taskRunner: TaskRunner,
  cwd: string,
  pieceName: string,
  options: TaskExecutionOptions | undefined,
  abortController: AbortController,
  colorCounter: { value: number },
): void {
  while (active.size < concurrency && queue.length > 0) {
    const task = queue.shift()!;
    const isParallel = concurrency > 1;
    const colorIndex = colorCounter.value++;

    if (isParallel) {
      const writer = new TaskPrefixWriter({ taskName: task.name, colorIndex });
      writer.writeLine(`=== Task: ${task.name} ===`);
    } else {
      blankLine();
      info(`=== Task: ${task.name} ===`);
    }

    const promise = executeAndCompleteTask(task, taskRunner, cwd, pieceName, options, {
      abortSignal: isParallel ? abortController.signal : undefined,
      taskPrefix: isParallel ? task.name : undefined,
      taskColorIndex: isParallel ? colorIndex : undefined,
    });
    active.set(promise, task);
  }
}
