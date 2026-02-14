import type { TaskInfo, TaskListItem } from './types.js';
import { toFailedTaskItem, toPendingTaskItem, toTaskInfo, toTaskListItem } from './mapper.js';
import { TaskStore } from './store.js';

export class TaskQueryService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
  ) {}

  listTasks(): TaskInfo[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'pending')
      .map((task) => toTaskInfo(this.projectDir, this.tasksFile, task));
  }

  listPendingTaskItems(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'pending')
      .map((task) => toPendingTaskItem(this.projectDir, this.tasksFile, task));
  }

  listAllTaskItems(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks.map((task) => toTaskListItem(this.projectDir, this.tasksFile, task));
  }

  listFailedTasks(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'failed')
      .map((task) => toFailedTaskItem(this.projectDir, this.tasksFile, task));
  }
}
