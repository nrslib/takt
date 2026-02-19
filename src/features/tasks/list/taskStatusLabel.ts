import type { TaskListItem } from '../../../infra/task/index.js';

const TASK_STATUS_BY_KIND: Record<TaskListItem['kind'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

export function formatTaskStatusLabel(task: TaskListItem): string {
  const status = `[${TASK_STATUS_BY_KIND[task.kind]}] ${task.name}`;
  if (task.branch) {
    return `${status} (${task.branch})`;
  }
  return status;
}

export function formatShortDate(isoString: string): string {
  const date = new Date(isoString);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}
