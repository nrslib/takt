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

import type { AutoRequeueSkipReason, TaskRunner, TaskInfo } from '../../../infra/task/index.js';
import { info, blankLine } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeRunTaskAndComplete } from './runTaskExecution.js';
import { ShutdownManager } from './shutdownManager.js';
import { forceExitAfterOpenCodeCleanup } from './forceShutdown.js';
import { isInputWaiting } from './inputWait.js';
import type { TaskExecutionOptions } from './types.js';

const log = createLogger('worker-pool');

export interface WorkerPoolResult {
  success: number;
  fail: number;
  executedTaskNames: string[];
}

interface RunWorkerOptions {
  ignoreIterationLimit?: boolean;
  autoRequeueMaxAttempts?: number;
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
 * 1. Separate scheduling shutdown from task interruption
 * 2. Maintain a queue of pending tasks and a set of active promises
 * 3. Fill available slots from the queue
 * 4. Wait for any active task to complete OR a poll timer to fire (Promise.race)
 * 5. On task completion: record result
 * 6. On poll tick or completion: claim new tasks and fill freed slots
 * 7. Run drains the queue; watch stays resident until interrupted
 */
export async function runWithWorkerPool(
  taskRunner: TaskRunner,
  initialTasks: TaskInfo[],
  concurrency: number,
  cwd: string,
  taskExecutionOptions: TaskExecutionOptions | undefined,
  runOptions: RunWorkerOptions | undefined,
  pollIntervalMs: number,
  mode: 'run' | 'watch' = 'run',
): Promise<WorkerPoolResult> {
  const schedulingController = new AbortController();
  const taskAbortController = new AbortController();
  const shutdownManager = new ShutdownManager({
    callbacks: {
      onGraceful: () => {
        schedulingController.abort();
        if (mode === 'run') taskAbortController.abort();
      },
      onForceKill: () => { void forceExitAfterOpenCodeCleanup(); },
    },
  });
  shutdownManager.install();
  const selfSigintOnce = process.env.TAKT_E2E_SELF_SIGINT_ONCE === '1';
  const selfSigintTwice = process.env.TAKT_E2E_SELF_SIGINT_TWICE === '1';
  let selfSigintInjected = false;

  let successCount = 0;
  let failCount = 0;
  const executedTaskNames: string[] = [];

  const queue = [...initialTasks];
  const active = new Map<Promise<boolean>, TaskInfo>();
  const colorCounter = { value: 0 };

  try {
    if (mode === 'watch') {
      requeueExistingFailedTasks(taskRunner, runOptions?.autoRequeueMaxAttempts, schedulingController.signal);
      claimAvailableTasks(taskRunner, queue, active.size, concurrency, schedulingController.signal);
    }
    while (mode === 'watch' || queue.length > 0 || active.size > 0) {
      if (!schedulingController.signal.aborted) {
        fillSlots(queue, active, concurrency, taskRunner, cwd, taskExecutionOptions, runOptions,
          schedulingController.signal, taskAbortController.signal, colorCounter);
        if ((selfSigintOnce || selfSigintTwice) && !selfSigintInjected && active.size > 0) {
          selfSigintInjected = true;
          process.emit('SIGINT');
          if (selfSigintTwice) {
            // E2E deterministic path: force-exit shortly after graceful SIGINT.
            // Avoids intermittent hangs caused by listener ordering/races.
            setTimeout(() => { void forceExitAfterOpenCodeCleanup(); }, 25);
          }
        }
      }

      if (active.size === 0 && (schedulingController.signal.aborted || mode === 'run')) {
        break;
      }

      const completionPromises: Promise<RaceResult>[] = [...active.keys()].map((p) =>
        p.then(
          (result): RaceResult => ({ type: 'completion', promise: p, result }),
          (): RaceResult => ({ type: 'completion', promise: p, result: false }),
        ),
      );

      let settled: RaceResult;
      if (schedulingController.signal.aborted) {
        // Graceful shutdown: stop scheduling new work but wait for in-flight tasks to settle.
        settled = await Promise.race(completionPromises);
      } else {
        const pollTimer = createPollTimer(pollIntervalMs, schedulingController.signal);
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
          const failed = !settled.result
            && (schedulingController.signal.aborted || !tryAutoRequeueFailedTask(taskRunner, task, runOptions));
          if (mode === 'run') {
            executedTaskNames.push(task.name);
            if (settled.result) successCount++;
            else if (failed) failCount++;
          }
        }
      }

      claimAvailableTasks(taskRunner, queue, active.size, concurrency, schedulingController.signal);
    }
  } finally {
    shutdownManager.cleanup();
  }

  return { success: successCount, fail: failCount, executedTaskNames };
}

function claimAvailableTasks(
  taskRunner: TaskRunner,
  queue: TaskInfo[],
  activeCount: number,
  concurrency: number,
  signal: AbortSignal,
): void {
  if (signal.aborted || isInputWaiting()) return;
  const freeSlots = concurrency - activeCount - queue.length;
  if (freeSlots <= 0) return;
  const newTasks = taskRunner.claimNextTasks(freeSlots);
  log.trace('poll_tick', { active: activeCount, queued: queue.length, freeSlots });
  if (newTasks.length > 0) {
    log.debug('poll_new_tasks', { count: newTasks.length });
    queue.push(...newTasks);
  } else {
    log.trace('no_new_tasks');
  }
}

export function requeueExistingFailedTasks(
  taskRunner: TaskRunner,
  maxAttempts: number | undefined,
  signal?: AbortSignal,
): number {
  if (maxAttempts === undefined || maxAttempts <= 0 || signal?.aborted) return 0;
  let requeuedCount = 0;
  for (const task of taskRunner.listFailedTasks()) {
    if (signal?.aborted) break;
    if (attemptAutoRequeueTask(taskRunner, task.name, maxAttempts)) requeuedCount++;
  }
  return requeuedCount;
}

export function attemptAutoRequeueTask(
  taskRunner: TaskRunner,
  taskName: string,
  maxAttempts: number,
): boolean {
  if (maxAttempts <= 0) {
    return false;
  }
  const result = taskRunner.autoRequeueFailedTask(taskName, { maxAttempts });
  const displayName = sanitizeTerminalText(taskName);
  if (result.requeued) {
    info(`Task "${displayName}" auto-requeued (${result.attempt}/${result.maxAttempts})`);
    return true;
  }
  info(
    `Task "${displayName}" was not auto-requeued: ${formatAutoRequeueSkipReason(result.reason)} `
    + `(${result.attempt}/${result.maxAttempts})`,
  );
  return false;
}

function tryAutoRequeueFailedTask(
  taskRunner: TaskRunner,
  task: TaskInfo,
  runOptions: RunWorkerOptions | undefined,
): boolean {
  const maxAttempts = runOptions?.autoRequeueMaxAttempts;
  if (maxAttempts === undefined) {
    return false;
  }
  return attemptAutoRequeueTask(taskRunner, task.name, maxAttempts);
}

function formatAutoRequeueSkipReason(reason: AutoRequeueSkipReason): string {
  switch (reason) {
    case 'disabled':
      return 'auto requeue is disabled';
    case 'task_not_failed':
      return 'task is not failed';
    case 'max_attempts_reached':
      return 'max attempts reached';
    case 'failure_not_retryable':
      return 'failure is not retryable';
    case 'missing_failed_step':
      return 'failed step is missing';
    case 'missing_failure_detail':
      return 'failure detail is missing';
  }
}

function fillSlots(
  queue: TaskInfo[],
  active: Map<Promise<boolean>, TaskInfo>,
  concurrency: number,
  taskRunner: TaskRunner,
  cwd: string,
  taskExecutionOptions: TaskExecutionOptions | undefined,
  runOptions: RunWorkerOptions | undefined,
  schedulingSignal: AbortSignal,
  taskAbortSignal: AbortSignal,
  colorCounter: { value: number },
): void {
  while (!schedulingSignal.aborted && active.size < concurrency && queue.length > 0) {
    const task = queue.shift()!;
    const isParallel = concurrency > 1;
    const colorIndex = colorCounter.value++;
    const issueNumber = task.data?.issue;
    const taskPrefix = issueNumber === undefined ? task.name : `#${issueNumber}`;
    const taskDisplayLabel = issueNumber === undefined ? undefined : taskPrefix;
    const displayName = sanitizeTerminalText(task.name);

    if (isParallel) {
      const writer = new TaskPrefixWriter({
        taskName: task.name,
        colorIndex,
        issue: issueNumber,
        displayLabel: taskDisplayLabel,
      });
      writer.writeLine(`=== Task: ${displayName} ===`);
    } else {
      blankLine();
      info(`=== Task: ${displayName} ===`);
    }

    const promise = executeRunTaskAndComplete(task, taskRunner, cwd, taskExecutionOptions, {
      abortSignal: taskAbortSignal,
      taskPrefix: isParallel ? taskPrefix : undefined,
      taskColorIndex: isParallel ? colorIndex : undefined,
      taskDisplayLabel: isParallel ? taskDisplayLabel : undefined,
    }, runOptions?.ignoreIterationLimit === true ? { ignoreIterationLimit: true } : undefined);
    active.set(promise, task);
  }
}
