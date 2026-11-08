import type { Goal } from './schema.js';
import type { TaskRecord } from '../task/schema.js';

type GoalActivity = Pick<Goal, 'id' | 'status' | 'executionStatus'>;
type MergeTaskActivity = Pick<TaskRecord, 'goal_id' | 'merge_task' | 'status'>;

export function isGoalAwaitingHumanMerge(goal: Pick<Goal, 'id' | 'status'>, tasks: readonly MergeTaskActivity[]): boolean {
  return goal.status === 'awaiting_merge' && !tasks.some((task) => task.goal_id === goal.id
    && task.merge_task === true && (task.status === 'pending' || task.status === 'running'));
}

export function isGoalPatrolCandidate(goal: GoalActivity, tasks: readonly MergeTaskActivity[]): boolean {
  return goal.executionStatus === 'active' && goal.status !== 'completed' && !isGoalAwaitingHumanMerge(goal, tasks);
}
