import { TaskStore } from './store.js';

export class TaskDeletionService {
  constructor(private readonly store: TaskStore) {}

  deletePendingTask(name: string): void {
    this.deleteTaskByNameAndStatus(name, 'pending');
  }

  deleteFailedTask(name: string): void {
    this.deleteTaskByNameAndStatus(name, 'failed');
  }

  deleteCompletedTask(name: string): void {
    this.deleteTaskByNameAndStatus(name, 'completed');
  }

  private deleteTaskByNameAndStatus(name: string, status: 'pending' | 'failed' | 'completed'): void {
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
}
