import type { TaskInfo, TaskListItem, TaskState } from './types.js';
import {
  toExceededTaskItem,
  toFailedTaskItem,
  toPendingTaskItem,
  toTaskInfo,
  toTaskListItem,
  toTaskState,
} from './mapper.js';
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

  listTasksForProviderPreflight(goalTasksOnly = false): TaskInfo[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'pending' && (!goalTasksOnly || task.goal_id !== undefined))
      .flatMap((task) => {
        try {
          return [toTaskInfo(this.projectDir, this.tasksFile, task)];
        } catch (error) {
          // The claim boundary records unreadable goal work as failed and notifies its manager.
          if (task.goal_id !== undefined) return [];
          throw error;
        }
      });
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

  listTaskStateItems(): TaskState[] {
    const state = this.store.read();
    return state.tasks.map((task) => toTaskState(this.tasksFile, task));
  }

  listFailedTasks(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'failed')
      .map((task) => toFailedTaskItem(this.projectDir, this.tasksFile, task));
  }

  listExceededTasks(): TaskListItem[] {
    const state = this.store.read();
    return state.tasks
      .filter((task) => task.status === 'exceeded')
      .map((task) => toExceededTaskItem(this.projectDir, this.tasksFile, task));
  }
}
