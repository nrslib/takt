import { beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ tasks: vi.fn(), update: vi.fn(), get: vi.fn() }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
import { recordGoalCompletion, reconcileGoalTasks } from '../infra/goals/reconcile.js';
let goal: Goal;
const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'original-sha' } };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => goal);
  doubles.tasks.mockReturnValue([]);
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); });
});
it('recovers work and completion from saved task results exactly once', async () => {
  doubles.tasks.mockReturnValue([{ name: 'task-a', goalId: goal.id, goalPurpose: '検証する', runSlug: 'run-a', completion: completion.result },
    { name: 'unrelated', goalId: 'another-goal', runSlug: 'other-run', completion: completion.result }]);
  await reconcileGoalTasks('/project', goal.id);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.workUnits).toEqual([{ taskName: 'task-a', purpose: '検証する' }]);
  expect(goal.events).toEqual([expect.objectContaining({ ...completion, processed: false })]);
});
it('preserves saved summaries and processed state across notification, recovery and a next run', async () => {
  await recordGoalCompletion('/project', goal.id, completion);
  goal = { ...goal, events: goal.events?.map((event) => ({ ...event, processed: true, summary: 'saved summary' })) };
  await recordGoalCompletion('/project', goal.id, completion);
  doubles.tasks.mockReturnValue([{ name: 'task-a', goalId: goal.id, runSlug: 'run-a', completion: completion.result }]);
  await reconcileGoalTasks('/project', goal.id);
  doubles.tasks.mockReturnValue([{ name: 'task-a', goalId: goal.id, runSlug: 'run-b', completion: { ...completion.result, sha: 'next-sha' } }]);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.events).toEqual([expect.objectContaining({ ...completion, processed: true, summary: 'saved summary' }),
    expect.objectContaining({ ...completion, runSlug: 'run-b', result: { ...completion.result, sha: 'next-sha' }, processed: false })]);
});
it('does not write a goal without its tasks', async () => {
  await reconcileGoalTasks('/project', goal.id);
  expect(doubles.update).not.toHaveBeenCalled();
});
it('preserves a captured completion after retry clears the task result', async () => {
  doubles.tasks.mockReturnValue([{ name: 'task-a', goalId: goal.id }]);
  await recordGoalCompletion('/project', goal.id, completion);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.events).toEqual([expect.objectContaining({ ...completion, processed: false })]);
});

it('assigns a stable event ID when the same completion is recorded again', async () => {
  await recordGoalCompletion('/project', goal.id, completion);
  const first = structuredClone(goal.events![0]!);
  expect(first).toMatchObject({ id: expect.any(String), kind: 'completion', ...completion });
  await recordGoalCompletion('/project', goal.id, completion);
  expect(goal.events).toEqual([first]);
});

it('distinguishes completion references containing separators', async () => {
  await recordGoalCompletion('/project', goal.id, { ...completion, taskName: 'a:b', runSlug: 'c' });
  await recordGoalCompletion('/project', goal.id, { ...completion, taskName: 'a', runSlug: 'b:c' });
  expect(goal.events).toHaveLength(2);
  const ids = goal.events!.map((event) => Reflect.get(event, 'id'));
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(2);
});
