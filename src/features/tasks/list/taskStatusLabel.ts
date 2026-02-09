import type { TaskListItem } from '../../../infra/task/index.js';

const TASK_STATUS_BY_KIND: Record<TaskListItem['kind'], string> = {
  pending: 'running',
  failed: 'failed',
};

export function formatTaskStatusLabel(task: TaskListItem): string {
  return `[${TASK_STATUS_BY_KIND[task.kind]}] ${task.name}`;
}
