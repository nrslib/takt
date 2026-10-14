import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskRunner } from '../infra/task/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));
import { claimTasksWithGoalCompletions, failInterruptedTasksWithGoalEvents } from '../features/tasks/execute/claimTasks.js';
beforeEach(() => save.mockReset());
it('publishes task setup failures once when claiming changes their state', () => {
  let status = 'pending';
  const record = () => ({ name: 'task-a', goalId: goalRecord().id, status, runSlug: 'setup-run', completion: { success: false, interrupted: false } });
  const runner = { listTaskStateItems: () => [record()], claimNextTasks: () => { status = 'failed'; return []; } } as unknown as TaskRunner;
  expect(claimTasksWithGoalCompletions(runner, 1, '/project', new AbortController().signal)).toEqual({ tasks: [] });
  expect(save).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'completion', goalId: goalRecord().id, taskName: 'task-a', runSlug: 'setup-run', result: { success: false, interrupted: false } });
  claimTasksWithGoalCompletions(runner, 1, '/project', new AbortController().signal); expect(save).toHaveBeenCalledOnce();
});
it('publishes newly interrupted goal tasks while leaving older results untouched', () => {
  let status = 'running';
  const completion = { success: false, interrupted: true };
  const runner = { listTaskStateItems: () => [{ name: 'task-a', goalId: goalRecord().id, status, runSlug: 'run-a', completion }, { name: 'old', goalId: goalRecord().id, status: 'failed', runSlug: 'old-run', completion }], failInterruptedRunningTasks: () => { const failed = status === 'running' ? 1 : 0; status = 'failed'; return failed; } } as unknown as TaskRunner;
  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(1);
  expect(save).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'completion', goalId: goalRecord().id, taskName: 'task-a', runSlug: 'run-a', result: completion });
  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(0); expect(save).toHaveBeenCalledOnce();
});
