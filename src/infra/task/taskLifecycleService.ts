import { TaskRecordSchema, type TaskFileData, type TaskRecord, type TaskFailure } from './schema.js';
import type { TaskInfo, TaskResult } from './types.js';
import { toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { firstLine, nowIso } from './naming.js';
import { slugify } from '../../shared/utils/slug.js';
import { isStaleRunningTask } from './process.js';
import { readRetryMetadataByRunSlug } from '../../core/workflow/run/retry-metadata.js';
import {
  buildClaimedTaskRecord,
  type ResolvedTaskRetryMetadata,
  buildTerminalTaskRecord,
  generateTaskName,
} from './taskRecordMutations.js';
import { findActiveTaskTargetConflict } from './activeTaskTarget.js';
import { TASK_RESTART_POINT_KEY } from './taskExecutionSchemas.js';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GoalStore } from '../goals/store.js';
import { isGoalPaused } from '../goals/state.js';
import { withGoalExecutionLock } from '../goals/execution-lock.js';

export class TaskLifecycleService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
    private readonly onWarning?: (warning: string) => void,
    private readonly goalTasksOnly?: boolean,
  ) {}

  addTask(
    content: string,
    options?: Omit<TaskFileData, 'task'> & {
      content_file?: string;
      task_dir?: string;
      worktree_path?: string;
      slug?: string;
      summary?: string;
    },
  ): TaskInfo {
    const state = this.store.update((current) => {
      const slug = options?.slug ?? slugify(firstLine(content));
      const name = generateTaskName(slug, current.tasks.map((task) => task.name));
      const contentValue = options?.task_dir ? undefined : content;
      const record: TaskRecord = TaskRecordSchema.parse({
        name,
        slug,
        summary: options?.summary,
        status: 'pending',
        content: contentValue,
        created_at: nowIso(),
        started_at: null,
        completed_at: null,
        owner_pid: null,
        ...options,
      });
      const conflict = findActiveTaskTargetConflict(current.tasks, record);
      if (conflict) {
        throw conflict;
      }
      return { tasks: [...current.tasks, record] };
    });

    const created = state.tasks[state.tasks.length - 1];
    if (!created) {
      throw new Error('Failed to create task.');
    }
    return toTaskInfo(this.projectDir, this.tasksFile, created);
  }

  claimNextTasks(count: number): TaskInfo[] {
    if (count <= 0) {
      return [];
    }

    return withGoalExecutionLock(this.projectDir, () => {
      const claimed: TaskInfo[] = [];

      this.store.update((current) => {
        let remaining = count;
        const goalStore = new GoalStore(this.projectDir);
        const blockedByGoal = new Map<string, boolean>();
        const tasks = current.tasks.map((task) => {
          if (remaining > 0 && task.status === 'pending' && (this.goalTasksOnly !== true || task.goal_id !== undefined)) {
            if (task.goal_id !== undefined) {
              try {
                let blocked = blockedByGoal.get(task.goal_id);
                if (blocked === undefined) {
                  const goal = goalStore.getSync(task.goal_id);
                  blocked = isGoalPaused(goal) || goal.executionStatus === 'aborted';
                  blockedByGoal.set(task.goal_id, blocked);
                }
                if (blocked) return task;
              } catch (error) {
                this.onWarning?.(`Cannot read goal for task ${task.name}: ${sanitizeSensitiveText(getErrorMessage(error))}`);
                return task;
              }
            }
            const next = buildClaimedTaskRecord(task);
            let info: TaskInfo;
            try {
              info = toTaskInfo(this.projectDir, this.tasksFile, next);
            } catch (error) {
              if (task.goal_id === undefined) throw error;
              const reason = sanitizeSensitiveText(getErrorMessage(error));
              return buildTerminalTaskRecord(next, {
                status: 'failed', completed_at: nowIso(), owner_pid: null,
                failure: { error: reason },
                run_slug: `setup-${randomUUID()}`,
                completion: {
                  success: false, interrupted: false, workflowResult: 'error',
                  branch: task.branch, failureReason: reason,
                  shaUnavailableReason: 'Workflow execution did not start',
                },
              }, this.readTerminalRetryMetadata(task));
            }
            claimed.push(info);
            remaining--;
            return next;
          }
          return task;
        });
        return { tasks };
      });

      return claimed;
    });
  }

  invalidatePendingGoalTasks(goalId: string): void {
    withGoalExecutionLock(this.projectDir, () => {
      this.store.update((current) => ({
        tasks: current.tasks.map((task) => {
          if (task.status !== 'pending' || task.goal_id !== goalId) return task;
          return buildTerminalTaskRecord(task, {
            status: 'failed', owner_pid: null,
            failure: { error: `Goal ${goalId} was aborted`, retryable: false },
          });
        }),
      }));
    });
  }

  failInterruptedRunningTasks(goalId?: string): number {
    let failed = 0;
    this.store.update((current) => {
      const tasks = current.tasks.map((task) => {
        if (task.status !== 'running' || (this.goalTasksOnly === true && task.goal_id === undefined)
          || (goalId !== undefined && task.goal_id !== goalId) || !this.isRunningTaskStale(task)) {
          return task;
        }
        failed++;
        const reason = 'Task was interrupted before this TAKT run started. Requeue it explicitly to run again.';
        const completed = buildTerminalTaskRecord(task, {
          status: 'failed',
          completed_at: nowIso(),
          owner_pid: null,
          failure: {
            error: reason,
          },
          ...(task.goal_id === undefined ? {} : {
            run_slug: task.run_slug ?? `setup-${randomUUID()}`,
            completion: {
              success: false, interrupted: true, workflowResult: 'error',
              branch: task.branch, failureReason: reason,
              shaUnavailableReason: 'Execution process stopped before saving its result',
            },
          }),
        }, this.readTerminalRetryMetadata(task));
        return completed;
      });
      return { tasks };
    });
    return failed;
  }

  private readTerminalRetryMetadata(task: TaskRecord): ResolvedTaskRetryMetadata {
    if (!task.run_slug) {
      return hasInheritedRetryCheckpoint(task) ? { preserveExisting: true } : {};
    }

    const retryMetadata = readRetryMetadataByRunSlug(
      task.worktree_path ?? this.projectDir,
      task.run_slug,
      this.onWarning,
    );
    if (retryMetadata.preserveExisting) {
      return retryMetadata;
    }

    if (retryMetadata.resumePoint) {
      return retryMetadata;
    }

    if (retryMetadata.startStep) {
      return {
        startStep: retryMetadata.startStep,
        ...(retryMetadata.currentIteration !== undefined
          ? { currentIteration: retryMetadata.currentIteration }
          : {}),
      };
    }

    if (hasInheritedRetryCheckpoint(task)) {
      return { preserveExisting: true };
    }

    return {};
  }

  completeTask(result: TaskResult): string {
    if (!result.success) {
      throw new Error('Cannot complete a failed task. Use failTask() instead.');
    }

    this.store.update((current) => {
      const index = this.findActiveTaskIndex(current.tasks, result.task.name);
      if (index === -1) {
        throw new Error(`Task not found: ${result.task.name}`);
      }

      const target = current.tasks[index]!;
      const updated = buildTerminalTaskRecord(target, {
        status: 'completed',
        started_at: result.startedAt,
        completed_at: result.completedAt,
        owner_pid: null,
        failure: undefined,
        branch: result.branch ?? target.branch,
        worktree_path: result.worktreePath ?? target.worktree_path,
        pr_url: result.prUrl ?? target.pr_url,
        ...(result.completion === undefined ? {} : { completion: result.completion }),
      });
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
    return this.tasksFile;
  }

  failTask(result: TaskResult): string {
    const failure: TaskFailure = {
      step: result.failureStep,
      error: result.response,
      last_message: result.failureLastMessage ?? result.executionLog[result.executionLog.length - 1],
      retryable: result.failureRetryable,
    };

    this.store.update((current) => {
      const index = this.findActiveTaskIndex(current.tasks, result.task.name);
      if (index === -1) {
        throw new Error(`Task not found: ${result.task.name}`);
      }

      const target = current.tasks[index]!;
      const updated = buildTerminalTaskRecord(target, {
        status: 'failed',
        started_at: result.startedAt,
        completed_at: result.completedAt,
        owner_pid: null,
        failure,
        branch: result.branch ?? target.branch,
        worktree_path: result.worktreePath ?? target.worktree_path,
        ...(result.completion === undefined ? {} : { completion: result.completion }),
        ...(target.goal_id === undefined || result.completion === undefined ? {} : { run_slug: result.task.runSlug }),
      }, this.readTerminalRetryMetadata(target));
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
    return this.tasksFile;
  }

  forceFailRunningTask(taskName: string, failure: TaskFailure): string {
    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => task.name === taskName && task.status === 'running');
      if (index === -1) {
        throw new Error(`Running task not found for force-fail: ${taskName}`);
      }

      const target = current.tasks[index]!;
      const updated = buildTerminalTaskRecord(target, {
        status: 'failed',
        completed_at: nowIso(),
        owner_pid: null,
        failure,
      }, this.readTerminalRetryMetadata(target));
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  updateRunningTaskExecution(
    taskName: string,
    execution: {
      runSlug: string;
      worktreePath?: string;
      branch?: string;
    },
  ): TaskInfo {
    let found: TaskRecord | undefined;

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => task.name === taskName && task.status === 'running');
      if (index === -1) {
        throw new Error(`Running task not found for execution update: ${taskName}`);
      }

      const target = current.tasks[index]!;
      const updated: TaskRecord = {
        ...target,
        run_slug: execution.runSlug,
        worktree_path: execution.worktreePath ?? target.worktree_path,
        branch: execution.branch ?? target.branch,
      };

      found = updated;
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return toTaskInfo(this.projectDir, this.tasksFile, found!);
  }

  prFailTask(result: TaskResult, prError: string): string {
    const failure: TaskFailure = {
      error: `PR creation failed: ${prError}`,
    };

    this.store.update((current) => {
      const index = this.findActiveTaskIndex(current.tasks, result.task.name);
      if (index === -1) {
        throw new Error(`Task not found: ${result.task.name}`);
      }

      const target = current.tasks[index]!;
      const updated = buildTerminalTaskRecord(target, {
        status: 'pr_failed',
        started_at: result.startedAt,
        completed_at: result.completedAt,
        owner_pid: null,
        failure,
        branch: result.branch ?? target.branch,
        worktree_path: result.worktreePath ?? target.worktree_path,
        pr_url: result.prUrl ?? target.pr_url,
        ...(result.completion === undefined ? {} : { completion: result.completion }),
      }, this.readTerminalRetryMetadata(target));
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
    return this.tasksFile;
  }

  completePublishedTask(taskName: string, prUrl: string | undefined): void {
    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => task.name === taskName && task.status === 'pr_failed');
      if (index === -1) {
        throw new Error(`Publish-failed task not found: ${taskName}`);
      }

      const target = current.tasks[index]!;
      const tasks = [...current.tasks];
      tasks[index] = buildTerminalTaskRecord(target, {
        status: 'completed',
        failure: undefined,
        pr_url: prUrl ?? target.pr_url,
      });
      return { tasks };
    });
  }

  private findActiveTaskIndex(tasks: TaskRecord[], name: string): number {
    return tasks.findIndex((task) => task.name === name && (task.status === 'running' || task.status === 'pending'));
  }

  private isRunningTaskStale(task: TaskRecord): boolean {
    return isStaleRunningTask(task.owner_pid ?? undefined, task.owner_start_time ?? undefined);
  }
}

function hasInheritedRetryCheckpoint(task: TaskRecord): boolean {
  return task.resume_mode !== undefined
    && (
      task.start_step !== undefined
      || task.resume_point !== undefined
      || task[TASK_RESTART_POINT_KEY] !== undefined
    );
}
