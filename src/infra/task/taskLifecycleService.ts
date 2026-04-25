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
  buildRecoveredTaskRecordWithRetryMetadata,
  type ResolvedTaskRetryMetadata,
  buildTerminalTaskRecord,
  generateTaskName,
} from './taskRecordMutations.js';

export class TaskLifecycleService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
    private readonly onWarning?: (warning: string) => void,
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

    const claimed: TaskRecord[] = [];

    this.store.update((current) => {
      let remaining = count;
      const tasks = current.tasks.map((task) => {
        if (remaining > 0 && task.status === 'pending') {
          const next = buildClaimedTaskRecord(task);
          claimed.push(next);
          remaining--;
          return next;
        }
        return task;
      });
      return { tasks };
    });

    return claimed.map((task) => toTaskInfo(this.projectDir, this.tasksFile, task));
  }

  recoverInterruptedRunningTasks(): number {
    let recovered = 0;
    this.store.update((current) => {
      const tasks = current.tasks.map((task) => {
        if (task.status !== 'running' || !this.isRunningTaskStale(task)) {
          return task;
        }
        recovered++;
        return buildRecoveredTaskRecordWithRetryMetadata(
          task,
          this.readRecoveryRetryMetadata(task),
        );
      });
      return { tasks };
    });
    return recovered;
  }

  private readRecoveryRetryMetadata(task: TaskRecord): ResolvedTaskRetryMetadata {
    if (!task.run_slug) {
      return { preserveExisting: true };
    }

    const retryMetadata = this.readTerminalRetryMetadata(task);
    if (retryMetadata.preserveExisting) {
      return retryMetadata;
    }

    if (!retryMetadata.startStep) {
      return { preserveExisting: true };
    }

    return { startStep: retryMetadata.startStep };
  }

  private readTerminalRetryMetadata(task: TaskRecord): ResolvedTaskRetryMetadata {
    if (!task.run_slug) {
      return {};
    }

    const retryMetadata = readRetryMetadataByRunSlug(
      task.worktree_path ?? this.projectDir,
      task.run_slug,
      this.onWarning,
    );
    if (retryMetadata.preserveExisting) {
      return retryMetadata;
    }

    return retryMetadata.startStep
      ? { startStep: retryMetadata.startStep }
      : {};
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
      }, this.readTerminalRetryMetadata(target));
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  private findActiveTaskIndex(tasks: TaskRecord[], name: string): number {
    return tasks.findIndex((task) => task.name === name && (task.status === 'running' || task.status === 'pending'));
  }

  private isRunningTaskStale(task: TaskRecord): boolean {
    return isStaleRunningTask(task.owner_pid ?? undefined);
  }
}
