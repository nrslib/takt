import { TaskStore } from './store.js';

export class TaskDeletionService {
  constructor(private readonly store: TaskStore) {}

  deleteTaskByNameAndStatus(name: string, status: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed'): void {
    this.deleteTaskWithCleanup(name, status, () => true);
  }

  deleteTaskWithCleanup(
    name: string,
    status: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed',
    cleanup: () => boolean,
  ): boolean {
    const updated = this.store.update((current) => {
      const exists = current.tasks.some((task) => task.name === name && task.status === status);
      if (!exists) {
        throw new Error(`Task not found: ${name} (${status})`);
      }
      if (!cleanup()) return current;
      return {
        tasks: current.tasks.filter((task) => !(task.name === name && task.status === status)),
      };
    });
    return !updated.tasks.some((task) => task.name === name && task.status === status);
  }
}
