import { describe, expect, it } from 'vitest';
import { isGoalAwaitingHumanMerge, isGoalPatrolCandidate } from '../infra/goals/activity.js';
import type { TaskRecord } from '../infra/task/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const goal = { ...goalRecord(), status: 'awaiting_merge' as const };
type Task = Pick<TaskRecord, 'goal_id' | 'merge_task' | 'status'>;

describe('goal activity', () => {
  it.each(['pending', 'running'] as const)('patrols awaiting_merge with a linked %s merge task', (status) => {
    const tasks: Task[] = [{ goal_id: goal.id, merge_task: true, status }];
    expect(isGoalAwaitingHumanMerge(goal, tasks)).toBe(false);
    expect(isGoalPatrolCandidate(goal, tasks)).toBe(true);
  });

  it.each(['completed', 'failed', 'exceeded', 'pr_failed'] as const)('waits for a human when the merge task is %s', (status) => {
    const tasks: Task[] = [{ goal_id: goal.id, merge_task: true, status }];
    expect(isGoalAwaitingHumanMerge(goal, tasks)).toBe(true);
    expect(isGoalPatrolCandidate(goal, tasks)).toBe(false);
  });

  it.each<{ tasks: Task[] }>([
    { tasks: [] },
    { tasks: [{ goal_id: 'another-goal', merge_task: true, status: 'running' }] },
    { tasks: [{ merge_task: true, status: 'pending' }] },
    { tasks: [{ goal_id: goal.id, status: 'running' }] },
    { tasks: [{ goal_id: goal.id, merge_task: false, status: 'pending' }] },
  ])('requires both the goal link and the merge marker ($tasks)', ({ tasks }) => {
    expect(isGoalAwaitingHumanMerge(goal, tasks)).toBe(true);
    expect(isGoalPatrolCandidate(goal, tasks)).toBe(false);
  });

  it('keeps patrolling while any linked merge task is active', () => {
    expect(isGoalPatrolCandidate(goal, [
      { goal_id: goal.id, merge_task: true, status: 'completed' },
      { goal_id: goal.id, merge_task: true, status: 'pending' },
    ])).toBe(true);
  });

  it.each(['paused', 'aborted'] as const)('excludes a %s goal even with running merge work', (executionStatus) => {
    const tasks: Task[] = [{ goal_id: goal.id, merge_task: true, status: 'running' }];
    expect(isGoalPatrolCandidate({ ...goal, executionStatus }, tasks)).toBe(false);
    expect(isGoalAwaitingHumanMerge(goal, tasks)).toBe(false);
  });

  it('patrols ordinary active goals and excludes completed goals', () => {
    expect(isGoalPatrolCandidate(goalRecord(), [])).toBe(true);
    expect(isGoalAwaitingHumanMerge(goalRecord(), [])).toBe(false);
    expect(isGoalPatrolCandidate({ ...goal, status: 'completed' }, [
      { goal_id: goal.id, merge_task: true, status: 'running' },
    ])).toBe(false);
  });
});
