import type { TaskFileData } from './schema.js';
import type { TaskInfo, TaskResult, TaskListItem } from './types.js';
import type { TaskStatus } from './schema.js';
import { TaskStore } from './store.js';
import { TaskLifecycleService } from './taskLifecycleService.js';
import { TaskQueryService } from './taskQueryService.js';
import { TaskDeletionService } from './taskDeletionService.js';

export type { TaskInfo, TaskResult, TaskListItem };

export class TaskRunner {
  private readonly store: TaskStore;
  private readonly tasksFile: string;
  private readonly lifecycle: TaskLifecycleService;
  private readonly query: TaskQueryService;
  private readonly deletion: TaskDeletionService;

  constructor(private readonly projectDir: string) {
    this.store = new TaskStore(projectDir);
    this.tasksFile = this.store.getTasksFilePath();
    this.lifecycle = new TaskLifecycleService(projectDir, this.tasksFile, this.store);
    this.query = new TaskQueryService(projectDir, this.tasksFile, this.store);
    this.deletion = new TaskDeletionService(this.store);
  }

  ensureDirs(): void {
    this.store.ensureDirs();
  }

  getTasksDir(): string {
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

  listPendingTaskItems(): TaskListItem[] {
    return this.query.listPendingTaskItems();
  }

  listAllTaskItems(): TaskListItem[] {
    return this.query.listAllTaskItems();
  }

  listFailedTasks(): TaskListItem[] {
    return this.query.listFailedTasks();
  }

  requeueFailedTask(taskRef: string, startMovement?: string, retryNote?: string): string {
    return this.lifecycle.requeueFailedTask(taskRef, startMovement, retryNote);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startMovement?: string,
    retryNote?: string,
  ): string {
    return this.lifecycle.requeueTask(taskRef, allowedStatuses, startMovement, retryNote);
  }

  startReExecution(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startMovement?: string,
    retryNote?: string,
  ): TaskInfo {
    return this.lifecycle.startReExecution(taskRef, allowedStatuses, startMovement, retryNote);
  }

  deletePendingTask(name: string): void {
    this.deletion.deletePendingTask(name);
  }

  deleteFailedTask(name: string): void {
    this.deletion.deleteFailedTask(name);
  }

  deleteCompletedTask(name: string): void {
    this.deletion.deleteCompletedTask(name);
  }
}
