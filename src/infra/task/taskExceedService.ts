import type { TaskRecord } from './schema.js';
import { TaskStore } from './store.js';
import { nowIso } from './naming.js';

export interface ExceedTaskOptions {
  currentMovement: string;
  newMaxMovements: number;
  currentIteration: number;
}

export class TaskExceedService {
  constructor(private readonly store: TaskStore) {}

  exceedTask(taskName: string, options: ExceedTaskOptions): void {
    this.store.update((current) => {
      const index = current.tasks.findIndex(
        (task) => task.name === taskName && task.status === 'running',
      );
      if (index === -1) {
        throw new Error(`Task not found: ${taskName} (running)`);
      }

      const target = current.tasks[index]!;
      const updated: TaskRecord = {
        ...target,
        status: 'exceeded',
        completed_at: nowIso(),
        owner_pid: null,
        failure: undefined,
        start_movement: options.currentMovement,
        exceeded_max_movements: options.newMaxMovements,
        exceeded_current_iteration: options.currentIteration,
      };

      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
  }

  requeueExceededTask(taskName: string): void {
    this.store.update((current) => {
      const index = current.tasks.findIndex(
        (task) => task.name === taskName && task.status === 'exceeded',
      );
      if (index === -1) {
        throw new Error(`Task not found: ${taskName} (exceeded)`);
      }

      const target = current.tasks[index]!;
      const updated: TaskRecord = {
        ...target,
        status: 'pending',
        started_at: null,
        completed_at: null,
        owner_pid: null,
        failure: undefined,
      };

      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
  }
}
