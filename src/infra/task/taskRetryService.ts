import type { WorkflowResumePoint } from '../../core/models/index.js';
import type { RunResumeSource } from '../../core/workflow/run/run-meta.js';
import type { TaskStatus } from './schema.js';
import type { TaskInfo } from './types.js';
import type { TaskRecord } from './schema.js';
import { toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { buildAutoRequeueNote } from './retryNote.js';
import { buildRetryTaskRecord, normalizeTaskRef } from './taskRecordMutations.js';

interface AutoRequeueOptions {
  maxAttempts: number;
}

export type AutoRequeueSkipReason =
  | 'disabled'
  | 'task_not_failed'
  | 'max_attempts_reached'
  | 'failure_not_retryable'
  | 'missing_failed_step'
  | 'missing_failure_detail';

export type AutoRequeueResult =
  | {
      requeued: true;
      attempt: number;
      maxAttempts: number;
      reason: 'requeued';
    }
  | {
      requeued: false;
      attempt: number;
      maxAttempts: number;
      reason: AutoRequeueSkipReason;
    };

function replaceTaskAtIndex(
  tasks: readonly TaskRecord[],
  index: number,
  updated: TaskRecord,
): TaskRecord[] {
  return tasks.map((task, taskIndex) => (taskIndex === index ? updated : task));
}

function findTaskIndex(tasks: readonly TaskRecord[], taskName: string, taskRef: string): number {
  const index = tasks.findIndex((task) => task.name === taskName);
  if (index === -1) {
    throw new Error(`Task not found for auto requeue: ${taskRef}`);
  }
  return index;
}

function getAutoRequeueSkipResult(
  target: TaskRecord,
  maxAttempts: number,
): AutoRequeueResult | undefined {
  const currentAttempts = target.auto_requeue_count ?? 0;

  if (target.status !== 'failed') {
    return {
      requeued: false,
      attempt: currentAttempts,
      maxAttempts,
      reason: 'task_not_failed',
    };
  }
  if (currentAttempts >= maxAttempts) {
    return {
      requeued: false,
      attempt: currentAttempts,
      maxAttempts,
      reason: 'max_attempts_reached',
    };
  }
  if (target.failure?.retryable === false) {
    return {
      requeued: false,
      attempt: currentAttempts,
      maxAttempts,
      reason: 'failure_not_retryable',
    };
  }
  if (!target.failure?.step?.trim()) {
    return {
      requeued: false,
      attempt: currentAttempts,
      maxAttempts,
      reason: 'missing_failed_step',
    };
  }
  if (!target.failure.error.trim()) {
    return {
      requeued: false,
      attempt: currentAttempts,
      maxAttempts,
      reason: 'missing_failure_detail',
    };
  }

  return undefined;
}

function resolveResumeSource(
  explicitSourceRunSlug: string | undefined,
  task: TaskRecord,
  resumeMode: RunResumeSource['resumeMode'],
): RunResumeSource {
  const sourceRunSlug = explicitSourceRunSlug ?? task.run_slug ?? task.source_run_slug;
  return {
    ...(sourceRunSlug ? { sourceRunSlug } : {}),
    resumeMode,
  };
}

export class TaskRetryService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
  ) {}

  requeueFailedTask(taskRef: string, startStep?: string, retryNote?: string): string {
    return this.requeueTask(taskRef, ['failed'], startStep, retryNote);
  }

  autoRequeueFailedTask(taskRef: string, options: AutoRequeueOptions): AutoRequeueResult {
    if (options.maxAttempts <= 0) {
      return {
        requeued: false,
        attempt: 0,
        maxAttempts: options.maxAttempts,
        reason: 'disabled',
      };
    }

    const taskName = normalizeTaskRef(taskRef);
    let result: AutoRequeueResult | undefined;

    const current = this.store.read();
    const currentIndex = findTaskIndex(current.tasks, taskName, taskRef);
    const currentTarget = current.tasks[currentIndex]!;
    const skipResult = getAutoRequeueSkipResult(currentTarget, options.maxAttempts);
    if (skipResult) {
      return skipResult;
    }

    this.store.update((current) => {
      const index = findTaskIndex(current.tasks, taskName, taskRef);

      const target = current.tasks[index]!;
      const recheckSkipResult = getAutoRequeueSkipResult(target, options.maxAttempts);
      if (recheckSkipResult) {
        result = recheckSkipResult;
        return current;
      }
      const currentAttempts = target.auto_requeue_count ?? 0;
      const failure = target.failure!;
      const failedStep = failure.step!.trim();

      const nextAttempt = currentAttempts + 1;
      const updated = {
        ...buildRetryTaskRecord(
          target,
          'pending',
          failedStep,
          buildAutoRequeueNote(failure, {
            attempt: nextAttempt,
            maxAttempts: options.maxAttempts,
          }),
          target.resume_point,
          target.workflow,
          target.task_dir,
          resolveResumeSource(undefined, target, 'requeue'),
        ),
        auto_requeue_count: nextAttempt,
      };

      result = {
        requeued: true,
        attempt: nextAttempt,
        maxAttempts: options.maxAttempts,
        reason: 'requeued',
      };
      return { tasks: replaceTaskAtIndex(current.tasks, index, updated) };
    });

    if (!result) {
      throw new Error(`Auto requeue did not produce a result: ${taskRef}`);
    }
    return result;
  }

  startReExecution(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    resumeMode: RunResumeSource['resumeMode'],
    startStep?: string,
    retryNote?: string,
    resumePoint?: WorkflowResumePoint,
    workflow?: string,
    taskDir?: string,
    sourceRunSlug?: string,
  ): TaskInfo {
    const taskName = normalizeTaskRef(taskRef);
    let found: TaskRecord | undefined;

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => (
        task.name === taskName
        && allowedStatuses.includes(task.status)
      ));
      if (index === -1) {
        const expectedStatuses = allowedStatuses.join(', ');
        throw new Error(`Task not found for re-execution: ${taskRef} (expected status: ${expectedStatuses})`);
      }

      const target = current.tasks[index]!;
      const updated = buildRetryTaskRecord(
        target,
        'running',
        startStep,
        retryNote,
        resumePoint,
        workflow,
        taskDir,
        resolveResumeSource(sourceRunSlug, target, resumeMode),
      );

      found = updated;
      return { tasks: replaceTaskAtIndex(current.tasks, index, updated) };
    });

    return toTaskInfo(this.projectDir, this.tasksFile, found!);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
    resumePoint?: WorkflowResumePoint,
    workflow?: string,
    taskDir?: string,
    sourceRunSlug?: string,
  ): string {
    const taskName = normalizeTaskRef(taskRef);

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => (
        task.name === taskName
        && allowedStatuses.includes(task.status)
      ));
      if (index === -1) {
        const expectedStatuses = allowedStatuses.join(', ');
        throw new Error(`Task not found for requeue: ${taskRef} (expected status: ${expectedStatuses})`);
      }

      const target = current.tasks[index]!;
      const updated = buildRetryTaskRecord(
        target,
        'pending',
        startStep,
        retryNote,
        resumePoint,
        workflow,
        taskDir,
        resolveResumeSource(sourceRunSlug, target, 'requeue'),
      );

      return { tasks: replaceTaskAtIndex(current.tasks, index, updated) };
    });

    return this.tasksFile;
  }
}
