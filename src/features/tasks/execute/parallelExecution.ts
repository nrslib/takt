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

import type { AutoRequeueResult, AutoRequeueSkipReason, TaskRunner, TaskInfo, TaskListItem } from '../../../infra/task/index.js';
import { ActiveTaskTargetConflictError } from '../../../infra/task/activeTaskTarget.js';
import { info, blankLine } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeRunTaskAndComplete, executeRunTaskAndCompleteWithDetails } from './runTaskExecution.js';
import { ShutdownManager } from './shutdownManager.js';
import { forceExitAfterOpenCodeCleanup } from './forceShutdown.js';
import { isInputWaiting } from './inputWait.js';
import type { TaskExecutionOptions } from './types.js';
import { claimTasksWithGoalCompletions } from './claimTasks.js';
import { checkQueuedTaskProviders, checkPendingTaskProviders } from './providerPreflight.js';

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

export interface WorkerPoolShutdownSignals {
  readonly schedulingSignal: AbortSignal;
  readonly taskAbortSignal: AbortSignal;
  onTasksClaimed?(): void;
}

type RaceResult =
  | { type: 'completion'; promise: Promise<boolean>; result: boolean }
  | { type: 'manager-recovery'; promise: Promise<void> }
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
  shutdownSignals?: WorkerPoolShutdownSignals,
  managerRecovery?: Promise<void>,
  goalTasksOnly = false,
): Promise<WorkerPoolResult> {
  const schedulingController = shutdownSignals === undefined ? new AbortController() : undefined;
  const taskAbortController = shutdownSignals === undefined ? new AbortController() : undefined;
  const schedulingSignal = shutdownSignals?.schedulingSignal ?? schedulingController!.signal;
  const taskAbortSignal = shutdownSignals?.taskAbortSignal ?? taskAbortController!.signal;
  const shutdownManager = shutdownSignals === undefined ? new ShutdownManager({
    callbacks: {
      onGraceful: () => {
        schedulingController!.abort();
        if (mode === 'run') taskAbortController!.abort();
      },
      onForceKill: () => { void forceExitAfterOpenCodeCleanup(); },
    },
  }) : undefined;
  shutdownManager?.install();
  const selfSigintOnce = process.env.TAKT_E2E_SELF_SIGINT_ONCE === '1';
  const selfSigintTwice = process.env.TAKT_E2E_SELF_SIGINT_TWICE === '1';
  let selfSigintInjected = false;

  let successCount = 0;
  let failCount = 0;
  const executedTaskNames: string[] = [];

  const queue = [...initialTasks];
  const active = new Map<Promise<boolean>, TaskInfo>();
  const colorCounter = { value: 0 };
  const managerTurns = new Set<Promise<void>>(managerRecovery === undefined ? [] : [managerRecovery]);
  let preparationFailure: { error: unknown } | undefined;

  const claimPreparedTasks = async (): Promise<void> => {
    if (preparationFailure !== undefined) return;
    try {
      await claimAvailableTasks(taskRunner, queue, active.size, concurrency, schedulingSignal,
        cwd, taskExecutionOptions, managerTurns, goalTasksOnly);
    } catch (error) {
      if (!schedulingSignal.aborted || error !== schedulingSignal.reason) preparationFailure = { error };
    }
  };

  try {
    if (mode === 'watch') {
      const maxAttempts = runOptions?.autoRequeueMaxAttempts ?? 0;
      const failedTasks = maxAttempts > 0 ? taskRunner.listFailedTasks() : [];
      for (const task of failedTasks) {
        if (!taskRunner.isAutoRequeueEligible(task.name, maxAttempts)) continue;
        await checkRequeueProviders(cwd, task, taskExecutionOptions, schedulingSignal);
      }
      requeueExistingFailedTasks(taskRunner, maxAttempts, schedulingSignal, failedTasks);
      await claimPreparedTasks();
    }
    while (mode === 'watch' || queue.length > 0 || active.size > 0 || managerTurns.size > 0) {
      if (!schedulingSignal.aborted && preparationFailure === undefined) {
        if (queue.length > 0) shutdownSignals?.onTasksClaimed?.();
        fillSlots(queue, active, concurrency, taskRunner, cwd, taskExecutionOptions, runOptions,
          schedulingSignal, taskAbortSignal, colorCounter);
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

      if (active.size === 0 && managerTurns.size === 0
        && (schedulingSignal.aborted || preparationFailure !== undefined || mode === 'run')) {
        break;
      }

      const completionPromises: Promise<RaceResult>[] = [...active.keys()].map((p) =>
        p.then(
          (result): RaceResult => ({ type: 'completion', promise: p, result }),
          (): RaceResult => ({ type: 'completion', promise: p, result: false }),
        ),
      );
      completionPromises.push(...[...managerTurns].map((promise) =>
        promise.then((): RaceResult => ({ type: 'manager-recovery', promise }))));

      let settled: RaceResult;
      if (schedulingSignal.aborted || preparationFailure !== undefined) {
        // Graceful shutdown: stop scheduling new work but wait for in-flight tasks to settle.
        settled = await Promise.race(completionPromises);
      } else {
        const pollTimer = createPollTimer(pollIntervalMs, schedulingSignal);
        try {
          settled = await Promise.race([...completionPromises, pollTimer.promise]);
        } finally {
          pollTimer.cancel();
        }
      }

      if (settled.type === 'manager-recovery') {
        managerTurns.delete(settled.promise);
      } else if (settled.type === 'completion') {
        const task = active.get(settled.promise);
        active.delete(settled.promise);

        if (task) {
          const maxAttempts = runOptions?.autoRequeueMaxAttempts ?? 0;
          if (!settled.result && !schedulingSignal.aborted && preparationFailure === undefined
            && maxAttempts > 0 && taskRunner.isAutoRequeueEligible(task.name, maxAttempts)) {
            try {
              const failedState = taskRunner.listTaskStateItems()
                .find((candidate) => candidate.name === task.name && candidate.kind === 'failed');
              const failedTask: TaskInfo = failedState === undefined ? task : {
                ...task,
                status: 'failed',
                worktreePath: failedState.worktreePath ?? task.worktreePath,
                data: task.data === null ? null : {
                  ...task.data,
                  worktree: failedState.worktree ?? task.data.worktree,
                  workflow: failedState.workflow ?? task.data.workflow,
                },
              };
              await checkRequeueProviders(cwd, failedTask, taskExecutionOptions, schedulingSignal);
            } catch (error) {
              preparationFailure = { error };
            }
          }
          const failed = !settled.result
            && (schedulingSignal.aborted || preparationFailure !== undefined
              || !tryAutoRequeueFailedTask(taskRunner, task, runOptions));
          if (mode === 'run') {
            executedTaskNames.push(task.name);
            if (settled.result) successCount++;
            else if (failed) failCount++;
          }
        }
      }

      await claimPreparedTasks();
    }
  } finally {
    // The caller owns the project lock until every task has finished saving.
    await Promise.allSettled([...active.keys(), ...managerTurns]);
    shutdownManager?.cleanup();
  }

  if (preparationFailure !== undefined) throw preparationFailure.error;
  return { success: successCount, fail: failCount, executedTaskNames };
}

async function checkRequeueProviders(
  cwd: string,
  task: TaskInfo | TaskListItem,
  options: TaskExecutionOptions | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  try {
    await checkQueuedTaskProviders(cwd, task, options ?? {}, undefined, signal);
  } catch (error) {
    if (!signal.aborted || error !== signal.reason) throw error;
  }
}

async function claimAvailableTasks(
  taskRunner: TaskRunner,
  queue: TaskInfo[],
  activeCount: number,
  concurrency: number,
  signal: AbortSignal,
  cwd: string,
  overrides: TaskExecutionOptions | undefined,
  managerTurns: Set<Promise<void>>,
  goalTasksOnly: boolean,
): Promise<void> {
  if (signal.aborted || isInputWaiting()) return;
  const freeSlots = concurrency - activeCount - queue.length;
  if (freeSlots <= 0) return;
  await checkPendingTaskProviders(taskRunner, cwd, overrides ?? {}, undefined, [], signal, goalTasksOnly);
  if (signal.aborted || isInputWaiting()) return;
  const { tasks: newTasks, managerCompletion } = await claimTasksWithGoalCompletions(taskRunner, freeSlots, cwd, overrides, signal);
  if (managerCompletion !== undefined) managerTurns.add(managerCompletion);
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
  failedTasks?: readonly Pick<TaskInfo, 'name'>[],
): number {
  if (maxAttempts === undefined || maxAttempts <= 0 || signal?.aborted) return 0;
  let requeuedCount = 0;
  for (const task of failedTasks ?? taskRunner.listFailedTasks()) {
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
  let result: AutoRequeueResult;
  try {
    result = taskRunner.autoRequeueFailedTask(taskName, { maxAttempts });
  } catch (error) {
    if (error instanceof ActiveTaskTargetConflictError) return false;
    throw error;
  }
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
    case 'goal_owned':
      return 'goal tasks are managed by the manager';
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

    const executionOptions = {
      abortSignal: taskAbortSignal,
      taskPrefix: isParallel ? taskPrefix : undefined,
      taskColorIndex: isParallel ? colorIndex : undefined,
      taskDisplayLabel: isParallel ? taskDisplayLabel : undefined,
    };
    const context = runOptions?.ignoreIterationLimit === true ? { ignoreIterationLimit: true } : undefined;
    const goalId = task.data?.goal_id;
    const promise = goalId === undefined
      ? executeRunTaskAndComplete(task, taskRunner, cwd, taskExecutionOptions, executionOptions, context)
      : executeRunTaskAndCompleteWithDetails(task, taskRunner, cwd, taskExecutionOptions, executionOptions, context)
        .then(async (result) => {
          if (result.completion === undefined || result.runSlug === undefined) {
            log.error('Goal task completion is missing its saved result or run identifier', { goalId, task: task.name });
            return result.success;
          }
          const { processGoalCompletions } = await import('../../manager/completionTurn.js');
          await processGoalCompletions(cwd, goalId, taskExecutionOptions, {
            taskName: task.name, runSlug: result.runSlug, result: result.completion,
          });
          return result.success;
        });
    active.set(promise, task);
  }
}
