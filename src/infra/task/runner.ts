import type { TaskFileData } from './schema.js';
import type { TaskInfo, TaskResult, TaskListItem } from './types.js';
import type { TaskStatus } from './schema.js';
import { TaskStore } from './store.js';
import { TaskLifecycleService } from './taskLifecycleService.js';
import { TaskQueryService } from './taskQueryService.js';
import { TaskDeletionService } from './taskDeletionService.js';
import { TaskExceedService, type ExceedTaskOptions } from './taskExceedService.js';

export type { TaskInfo, TaskResult, TaskListItem };

export class TaskRunner {
  private readonly store: TaskStore;
  private readonly tasksFile: string;
  private readonly lifecycle: TaskLifecycleService;
  private readonly query: TaskQueryService;
  private readonly deletion: TaskDeletionService;
  private readonly exceed: TaskExceedService;

  constructor(private readonly projectDir: string) {
    this.store = new TaskStore(projectDir);
    this.tasksFile = this.store.getTasksFilePath();
    this.lifecycle = new TaskLifecycleService(projectDir, this.tasksFile, this.store);
    this.query = new TaskQueryService(projectDir, this.tasksFile, this.store);
    this.deletion = new TaskDeletionService(this.store);
    this.exceed = new TaskExceedService(this.store);
  }

  ensureDirs(): void {
    this.store.ensureDirs();
  }

  getTasksFilePath(): string {
    return this.tasksFile;
  }

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
    return this.lifecycle.addTask(content, options);
  }

  listTasks(): TaskInfo[] {
    return this.query.listTasks();
  }

  claimNextTasks(count: number): TaskInfo[] {
    return this.lifecycle.claimNextTasks(count);
  }

  recoverInterruptedRunningTasks(): number {
    return this.lifecycle.recoverInterruptedRunningTasks();
  }

  completeTask(result: TaskResult): string {
    return this.lifecycle.completeTask(result);
  }

  failTask(result: TaskResult): string {
    return this.lifecycle.failTask(result);
  }

  prFailTask(result: TaskResult, prError: string): string {
    return this.lifecycle.prFailTask(result, prError);
  }

  listPendingTaskItems(): TaskListItem[] {
    return this.query.listPendingTaskItems();
  }

  listAllTaskItems(): TaskListItem[] {
    return this.query.listAllTaskItems();
  }

  listFailedTasks(): TaskListItem[] {
    return this.query.listFailedTasks();
  }

  listExceededTasks(): TaskListItem[] {
    return this.query.listExceededTasks();
  }

  requeueFailedTask(taskRef: string, startStep?: string, retryNote?: string): string {
    return this.lifecycle.requeueFailedTask(taskRef, startStep, retryNote);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
  ): string {
    return this.lifecycle.requeueTask(taskRef, allowedStatuses, startStep, retryNote);
  }

  startReExecution(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
  ): TaskInfo {
    return this.lifecycle.startReExecution(taskRef, allowedStatuses, startStep, retryNote);
  }

  deleteTask(name: string, kind: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed'): void {
    this.deletion.deleteTaskByNameAndStatus(name, kind);
  }

  exceedTask(taskName: string, options: ExceedTaskOptions): void {
    this.exceed.exceedTask(taskName, options);
  }

  requeueExceededTask(taskName: string): void {
    this.exceed.requeueExceededTask(taskName);
  }
}
