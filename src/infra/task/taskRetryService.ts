import type { WorkflowResumePoint } from '../../core/models/index.js';
import type { TaskStatus } from './schema.js';
import type { TaskInfo } from './types.js';
import type { TaskRecord } from './schema.js';
import { toTaskInfo } from './mapper.js';
import { TaskStore } from './store.js';
import { buildRetryTaskRecord, normalizeTaskRef } from './taskRecordMutations.js';

function replaceTaskAtIndex(
  tasks: readonly TaskRecord[],
  index: number,
  updated: TaskRecord,
): TaskRecord[] {
  return tasks.map((task, taskIndex) => (taskIndex === index ? updated : task));
}

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
    workflow?: string,
    taskDir?: string,
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
      const updated = buildRetryTaskRecord(target, 'running', startStep, retryNote, resumePoint, workflow, taskDir);

      found = updated;
      return { tasks: replaceTaskAtIndex(current.tasks, index, updated) };
    });

    return toTaskInfo(this.projectDir, this.tasksFile, found!);
  }

  requeueTask(
    taskRef: string,
    allowedStatuses: readonly TaskStatus[],
    startStep?: string,
    retryNote?: string,
    resumePoint?: WorkflowResumePoint,
    workflow?: string,
    taskDir?: string,
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
      const updated = buildRetryTaskRecord(target, 'pending', startStep, retryNote, resumePoint, workflow, taskDir);

      return { tasks: replaceTaskAtIndex(current.tasks, index, updated) };
    });

    return this.tasksFile;
  }
}
