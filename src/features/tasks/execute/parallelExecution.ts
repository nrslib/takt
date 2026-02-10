/**
 * Worker pool task execution strategy.
 *
 * Runs tasks using a fixed-size worker pool. Each worker picks up the next
 * available task as soon as it finishes the current one, maximizing slot
 * utilization. Works for both sequential (concurrency=1) and parallel
 * (concurrency>1) execution through the same code path.
 *
 * Polls for newly added tasks at a configurable interval so that tasks
 * added to .takt/tasks.yaml during execution are picked up without waiting
 * for an active task to complete.
 */

import type { TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { info, blankLine } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { createLogger } from '../../../shared/utils/index.js';
import { executeAndCompleteTask } from './taskExecution.js';
import { installSigIntHandler } from './sigintHandler.js';
import type { TaskExecutionOptions } from './types.js';

const log = createLogger('worker-pool');

export interface WorkerPoolResult {
  success: number;
  fail: number;
}

type RaceResult =
  | { type: 'completion'; promise: Promise<boolean>; result: boolean }
  | { type: 'poll' };

interface PollTimer {
  promise: Promise<RaceResult>;
  cancel: () => void;
}

function createPollTimer(intervalMs: number, signal: AbortSignal): PollTimer {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const promise = new Promise<RaceResult>((resolve) => {
    if (signal.aborted) {
      resolve({ type: 'poll' });
      return;
    }

    onAbort = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve({ type: 'poll' });
    };

    timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort!);
      onAbort = undefined;
      resolve({ type: 'poll' });
    }, intervalMs);

    signal.addEventListener('abort', onAbort, { once: true });
  });

  return {
    promise,
    cancel: () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    },
  };
}

/**
 * Run tasks using a worker pool with the given concurrency.
 *
 * Algorithm:
 * 1. Create a shared AbortController
 * 2. Maintain a queue of pending tasks and a set of active promises
 * 3. Fill available slots from the queue
 * 4. Wait for any active task to complete OR a poll timer to fire (Promise.race)
 * 5. On task completion: record result
 * 6. On poll tick or completion: claim new tasks and fill freed slots
 * 7. Repeat until queue is empty and all active tasks complete
 */
export async function runWithWorkerPool(
  taskRunner: TaskRunner,
  initialTasks: TaskInfo[],
  concurrency: number,
  cwd: string,
  pieceName: string,
  options: TaskExecutionOptions | undefined,
  pollIntervalMs: number,
): Promise<WorkerPoolResult> {
  const abortController = new AbortController();
  const { cleanup } = installSigIntHandler(() => abortController.abort());
  const selfSigintOnce = process.env.TAKT_E2E_SELF_SIGINT_ONCE === '1';
  let selfSigintInjected = false;

  let successCount = 0;
  let failCount = 0;

  const queue = [...initialTasks];
  const active = new Map<Promise<boolean>, TaskInfo>();
  const colorCounter = { value: 0 };

  try {
    while (queue.length > 0 || active.size > 0) {
      if (!abortController.signal.aborted) {
        fillSlots(queue, active, concurrency, taskRunner, cwd, pieceName, options, abortController, colorCounter);
        if (selfSigintOnce && !selfSigintInjected && active.size > 0) {
          selfSigintInjected = true;
          process.emit('SIGINT');
        }
      }

      if (active.size === 0) {
        break;
      }

      const completionPromises: Promise<RaceResult>[] = [...active.keys()].map((p) =>
        p.then(
          (result): RaceResult => ({ type: 'completion', promise: p, result }),
          (): RaceResult => ({ type: 'completion', promise: p, result: false }),
        ),
      );

      let settled: RaceResult;
      if (abortController.signal.aborted) {
        // Graceful shutdown: stop scheduling new work but wait for in-flight tasks to settle.
        settled = await Promise.race(completionPromises);
      } else {
        const pollTimer = createPollTimer(pollIntervalMs, abortController.signal);
        try {
          settled = await Promise.race([...completionPromises, pollTimer.promise]);
        } finally {
          pollTimer.cancel();
        }
      }

      if (settled.type === 'completion') {
        const task = active.get(settled.promise);
        active.delete(settled.promise);

        if (task) {
          if (settled.result) {
            successCount++;
          } else {
            failCount++;
          }
        }
      }

      if (!abortController.signal.aborted) {
        const freeSlots = concurrency - active.size;
        if (freeSlots > 0) {
          const newTasks = taskRunner.claimNextTasks(freeSlots);
          log.debug('poll_tick', { active: active.size, queued: queue.length, freeSlots });
          if (newTasks.length > 0) {
            log.debug('poll_new_tasks', { count: newTasks.length });
            queue.push(...newTasks);
          } else {
            log.debug('no_new_tasks');
          }
        }
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
      abortSignal: abortController.signal,
      taskPrefix: isParallel ? task.name : undefined,
      taskColorIndex: isParallel ? colorIndex : undefined,
    });
    active.set(promise, task);
  }
}
