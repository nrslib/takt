import type { TaskListItem } from '../../../infra/task/types.js';
import { deleteTaskResources } from './taskDeleteActions.js';

export interface TaskDeletionResult {
  task: TaskListItem;
  success: boolean;
  error?: unknown;
}

export function executeTaskDeletion(tasks: readonly TaskListItem[]): TaskDeletionResult[] {
  return tasks.map((task) => {
    try {
      return { task, success: deleteTaskResources(task, { quiet: true }) };
    } catch (error) {
      return { task, success: false, error };
    }
  });
}
