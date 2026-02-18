import * as path from 'node:path';
import { TaskRecordSchema, type TaskFileData, type TaskRecord, type TaskFailure } from './schema.js';
import type { TaskInfo, TaskResult } from './types.js';
import { toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { firstLine, nowIso } from './naming.js';
import { slugify } from '../../shared/utils/slug.js';
import { isStaleRunningTask } from './process.js';
import type { TaskStatus } from './schema.js';

export class TaskLifecycleService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
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
      const name = this.generateTaskName(slug, current.tasks.map((task) => task.name));
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
          const next: TaskRecord = {
            ...task,
            status: 'running',
            started_at: nowIso(),
            owner_pid: process.pid,
          };
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
        return {
          ...task,
          status: 'pending',
          started_at: null,
          owner_pid: null,
        } as TaskRecord;
      });
      return { tasks };
    });
    return recovered;
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
      const updated: TaskRecord = {
        ...target,
        status: 'completed',
        started_at: result.startedAt,
        completed_at: result.completedAt,
        owner_pid: null,
        failure: undefined,
        branch: result.branch ?? target.branch,
        worktree_path: result.worktreePath ?? target.worktree_path,
      };
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  failTask(result: TaskResult): string {
    const failure: TaskFailure = {
      movement: result.failureMovement,
      error: result.response,
      last_message: result.failureLastMessage ?? result.executionLog[result.executionLog.length - 1],
    };

    this.store.update((current) => {
      const index = this.findActiveTaskIndex(current.tasks, result.task.name);
      if (index === -1) {
        throw new Error(`Task not found: ${result.task.name}`);
      }

      const target = current.tasks[index]!;
      const updated: TaskRecord = {
        ...target,
        status: 'failed',
        started_at: result.startedAt,
        completed_at: result.completedAt,
        owner_pid: null,
        failure,
        branch: result.branch ?? target.branch,
        worktree_path: result.worktreePath ?? target.worktree_path,
      };
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  requeueFailedTask(taskRef: string, startMovement?: string, retryNote?: string): string {
    return this.requeueTask(taskRef, ['failed'], startMovement, retryNote);
  }

  /**
   * Atomically transition a completed/failed task to running for re-execution.
   * Avoids the race condition of requeueTask(→ pending) + claimNextTasks(→ running).
   */
  startReExecution(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startMovement?: string,
    retryNote?: string,
  ): TaskInfo {
    const taskName = this.normalizeTaskRef(taskRef);
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
      const updated: TaskRecord = {
        ...target,
        status: 'running',
        started_at: nowIso(),
        owner_pid: process.pid,
        failure: undefined,
        start_movement: startMovement,
        retry_note: retryNote,
      };

      found = updated;
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return toTaskInfo(this.projectDir, this.tasksFile, found!);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startMovement?: string,
    retryNote?: string,
  ): string {
    const taskName = this.normalizeTaskRef(taskRef);

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
      const updated: TaskRecord = {
        ...target,
        status: 'pending',
        started_at: null,
        completed_at: null,
        owner_pid: null,
        failure: undefined,
        start_movement: startMovement,
        retry_note: retryNote,
      };

      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  private normalizeTaskRef(taskRef: string): string {
    if (!taskRef.includes(path.sep)) {
      return taskRef;
    }

    const base = path.basename(taskRef);
    if (base.includes('_')) {
      return base.slice(base.indexOf('_') + 1);
    }

    return base;
  }

  private findActiveTaskIndex(tasks: TaskRecord[], name: string): number {
    return tasks.findIndex((task) => task.name === name && (task.status === 'running' || task.status === 'pending'));
  }

  private isRunningTaskStale(task: TaskRecord): boolean {
    return isStaleRunningTask(task.owner_pid ?? undefined);
  }

  private generateTaskName(slug: string, existingNames: string[]): string {
    const base = slug || `task-${Date.now()}`;
    let candidate = base;
    let counter = 1;
    while (existingNames.includes(candidate)) {
      candidate = `${base}-${counter}`;
      counter++;
    }
    return candidate;
  }
}
