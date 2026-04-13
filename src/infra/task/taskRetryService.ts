import type { WorkflowResumePoint } from '../../core/models/index.js';
import type { TaskStatus } from './schema.js';
import type { TaskInfo } from './types.js';
import type { TaskRecord } from './schema.js';
import { toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { buildRetryTaskRecord, normalizeTaskRef } from './taskRecordMutations.js';

export class TaskRetryService {
  constructor(
    private readonly projectDir: string,
    private readonly tasksFile: string,
    private readonly store: TaskStore,
  ) {}

  requeueFailedTask(taskRef: string, startStep?: string, retryNote?: string): string {
    return this.requeueTask(taskRef, ['failed'], startStep, retryNote);
  }

  startReExecution(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
    resumePoint?: WorkflowResumePoint,
  ): TaskInfo {
    const taskName = normalizeTaskRef(taskRef);
    let found: TaskRecord | undefined;

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => (
        task.name === taskName
        && allowedStatuses.includes(task.status)
      ));
      if (index === -1) {
        const expectedStatuses = allowedStatuses.join(', ');
        throw new Error(`Task not found for re-execution: ${taskRef} (expected status: ${expectedStatuses})`);
      }

      const target = current.tasks[index]!;
      const updated = buildRetryTaskRecord(target, 'running', startStep, retryNote, resumePoint);

      found = updated;
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return toTaskInfo(this.projectDir, this.tasksFile, found!);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
    resumePoint?: WorkflowResumePoint,
  ): string {
    const taskName = normalizeTaskRef(taskRef);

    this.store.update((current) => {
      const index = current.tasks.findIndex((task) => (
        task.name === taskName
        && allowedStatuses.includes(task.status)
      ));
      if (index === -1) {
        const expectedStatuses = allowedStatuses.join(', ');
        throw new Error(`Task not found for requeue: ${taskRef} (expected status: ${expectedStatuses})`);
      }

      const target = current.tasks[index]!;
      const updated = buildRetryTaskRecord(target, 'pending', startStep, retryNote, resumePoint);

      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { tasks };
    });

    return this.tasksFile;
  }
}
