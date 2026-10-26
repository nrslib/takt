import type { TaskListItem } from '../../../infra/task/types.js';

const DELETABLE_TASK_STATUSES = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const;

export type DeletableTaskStatus = typeof DELETABLE_TASK_STATUSES[number];

export interface TaskDeletionFilter {
  status?: readonly DeletableTaskStatus[];
  goal?: string;
  branch?: string;
}

export function isDeletableTaskStatus(status: string): status is DeletableTaskStatus {
  return DELETABLE_TASK_STATUSES.some((value) => value === status);
}

export function selectTasksForDeletion(tasks: readonly TaskListItem[], filter: TaskDeletionFilter): TaskListItem[] {
  const statuses = filter.status;
  const hasStatus = statuses !== undefined && statuses.length > 0;
  if (!hasStatus && !filter.goal && !filter.branch) {
    throw new Error('Task deletion requires at least one filter');
  }

  return tasks.filter((task) => {
    if (task.kind === 'running') return false;
    if (hasStatus && !statuses.includes(task.kind)) return false;
    if (!hasStatus && filter.branch && task.kind !== 'completed') return false;
    if (filter.goal && task.goalId !== filter.goal) return false;
    if (filter.branch && task.branch !== filter.branch) return false;
    return true;
  });
}
