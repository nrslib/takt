import type { WorkflowResumePoint } from '../../core/models/index.js';
import type { TaskRecord } from './schema.js';
import { buildExceededTaskRecord } from './taskRecordMutations.js';
import { TaskStore } from './store.js';

export interface ExceedTaskOptions {
  currentStep: string;
  newMaxSteps: number;
  currentIteration: number;
  resumePoint?: WorkflowResumePoint;
  worktreePath?: string;
  branch?: string;
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

      const updated = buildExceededTaskRecord(current.tasks[index]!, options);

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
        ...(target.run_slug ? { source_run_slug: target.run_slug } : {}),
        resume_mode: 'requeue',
      };

      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });
  }
}
