import * as path from 'node:path';
import {
  TaskRecordSchema,
  type TaskFileData,
  type TaskRecord,
  type TaskFailure,
} from './schema.js';
import type { TaskInfo, TaskResult, TaskListItem } from './types.js';
import { toFailedTaskItem, toPendingTaskItem, toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { firstLine, nowIso, sanitizeTaskName } from './naming.js';

export type { TaskInfo, TaskResult, TaskListItem };

export class TaskRunner {
  private readonly store: TaskStore;
  private readonly tasksFile: string;

  constructor(private readonly projectDir: string) {
    this.store = new TaskStore(projectDir);
    this.tasksFile = this.store.getTasksFilePath();
  }

  ensureDirs(): void {
    this.store.ensureDirs();
  }

  getTasksDir(): string {
    return this.tasksFile;
  }

  addTask(
    content: string,
    options?: Omit<TaskFileData, 'task'> & { content_file?: string; task_dir?: string },
  ): TaskInfo {
    const state = this.store.update((current) => {
      const name = this.generateTaskName(content, current.tasks.map((task) => task.name));
      const contentValue = options?.task_dir ? undefined : content;
      const record: TaskRecord = TaskRecordSchema.parse({
        name,
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

  listTasks(): TaskInfo[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'pending')
      .map((task) => toTaskInfo(this.projectDir, this.tasksFile, task));
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

      return {
        tasks: current.tasks.filter((_, i) => i !== index),
      };
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
        completed_at: result.completedAt,
        owner_pid: null,
        failure,
      };
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }

  listPendingTaskItems(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'pending')
      .map((task) => toPendingTaskItem(this.projectDir, this.tasksFile, task));
  }

  listFailedTasks(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'failed')
      .map((task) => toFailedTaskItem(this.projectDir, this.tasksFile, task));
  }

  requeueFailedTask(taskRef: string, startMovement?: string, retryNote?: string): string {
    const taskName = this.normalizeTaskRef(taskRef);

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => task.name === taskName && task.status === 'failed');
      if (index === -1) {
        throw new Error(`Failed task not found: ${taskRef}`);
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

  deletePendingTask(name: string): void {
    this.deleteTaskByNameAndStatus(name, 'pending');
  }

  deleteFailedTask(name: string): void {
    this.deleteTaskByNameAndStatus(name, 'failed');
  }

  private deleteTaskByNameAndStatus(name: string, status: 'pending' | 'failed'): void {
    this.store.update((current) => {
      const exists = current.tasks.some((task) => task.name === name && task.status === status);
      if (!exists) {
        throw new Error(`Task not found: ${name} (${status})`);
      }
      return {
        tasks: current.tasks.filter((task) => !(task.name === name && task.status === status)),
      };
    });
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
    if (task.owner_pid == null) {
      return true;
    }
    return !this.isProcessAlive(task.owner_pid);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ESRCH') {
        return false;
      }
      if (nodeErr.code === 'EPERM') {
        return true;
      }
      throw err;
    }
  }

  private generateTaskName(content: string, existingNames: string[]): string {
    const base = sanitizeTaskName(firstLine(content));
    let candidate = base;
    let counter = 1;
    while (existingNames.includes(candidate)) {
      candidate = `${base}-${counter}`;
      counter++;
    }
    return candidate;
  }

}
