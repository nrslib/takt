import { TaskStore } from './store.js';

export class TaskDeletionService {
  constructor(private readonly store: TaskStore) {}

  deleteTaskByNameAndStatus(name: string, status: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed'): void {
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

  deleteTaskWithCleanup(
    name: string,
    status: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed',
    cleanup: () => boolean,
  ): boolean {
    const exists = this.store.read().tasks.some((task) => task.name === name && task.status === status);
    if (!exists) {
      throw new Error(`Task not found: ${name} (${status})`);
    }
    if (!cleanup()) return false;
    this.deleteTaskByNameAndStatus(name, status);
    return true;
  }
}
