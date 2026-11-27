import type { GoalTaskResult } from '../goals/schema.js';
import type { TaskRecord } from './schema.js';

export class TaskStoppedError extends Error {
  constructor(taskName: string, executionId: string) {
    super(`Task ${taskName} execution ${executionId} was stopped by manager`);
    this.name = 'TaskStoppedError';
  }
}

// A request can arrive after the monitor's last check but before the terminal write.
// Let the worker's error path persist and return the same stopped result.
export function assertTaskStopHandled(task: TaskRecord, completion?: GoalTaskResult): void {
  if (task.execution_id === undefined || task.stop_request?.execution_id !== task.execution_id) return;
  const error = new TaskStoppedError(task.name, task.execution_id);
  if (completion?.success === false && completion.interrupted && completion.failureReason === error.message) return;
  throw error;
}
