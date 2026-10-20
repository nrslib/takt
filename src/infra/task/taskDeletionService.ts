import { TaskStore } from './store.js';

/** Must finish synchronously without acquiring task or goal locks. Throw to keep the record. */
export type TaskDeletionCleanup = () => void;

export class TaskDeletionService {
  constructor(private readonly store: TaskStore) {}

  deleteTaskByNameAndStatus(
    name: string,
    status: 'pending' | 'failed' | 'completed' | 'exceeded' | 'pr_failed',
    cleanup?: TaskDeletionCleanup,
  ): void {
    this.store.update((current) => {
      const exists = current.tasks.some((task) => task.name === name && task.status === status);
      if (!exists) {
        throw new Error(`Task not found: ${name} (${status})`);
      }
      cleanup?.();
      return {
        tasks: current.tasks.filter((task) => !(task.name === name && task.status === status)),
      };
    });
  }
}
