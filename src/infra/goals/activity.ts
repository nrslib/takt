import type { Goal } from './schema.js';
import type { TaskRecord } from '../task/schema.js';

type GoalActivity = Pick<Goal, 'id' | 'status' | 'executionStatus'>;
type MergeTaskActivity = Pick<TaskRecord, 'goal_id' | 'merge_task' | 'status'>;

export function isGoalAwaitingHumanMerge(goal: Pick<Goal, 'id' | 'status'>, tasks: readonly MergeTaskActivity[]): boolean {
  if (goal.status !== 'awaiting_merge') return false;
  const mergeTasks = tasks.filter((task) => task.goal_id === goal.id && task.merge_task === true);
  if (mergeTasks.some((task) => task.status === 'pending' || task.status === 'running')) return false;
  // 仕上げタスクは tasks.yaml の末尾へ追加されるため、配列順を使う。
  const lastStatus = mergeTasks.at(-1)?.status;
  return lastStatus !== 'failed' && lastStatus !== 'exceeded' && lastStatus !== 'pr_failed';
}

export function isGoalPatrolCandidate(goal: GoalActivity, tasks: readonly MergeTaskActivity[]): boolean {
  return goal.executionStatus === 'active' && goal.status !== 'completed' && !isGoalAwaitingHumanMerge(goal, tasks);
}
