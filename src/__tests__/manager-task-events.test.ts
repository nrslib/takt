import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRunner } from '../infra/task/index.js';
import type { TaskState } from '../infra/task/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));
import { claimTasksWithGoalCompletions, failInterruptedTasksWithGoalEvents, TaskClaimLockUnavailableError } from '../features/tasks/execute/claimTasks.js';
import { PrivateFileLockAcquisitionError } from '../shared/utils/private-file-lock.js';
import { TaskClaimLockAcquisitionError } from '../infra/task/taskLifecycleService.js';
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
  let status: TaskState['status'] = 'running';
  const completion = { success: false, interrupted: true };
  const record = (): TaskState => ({ name: 'task-a', goalId: goalRecord().id, status, kind: status,
    runSlug: 'run-a', completion, createdAt: '2026-10-06T00:00:00Z', filePath: '/project/.takt/tasks.yaml' });
  const runner = {
    listTaskStateItems: () => [record(), { ...record(), name: 'old', status: 'failed', kind: 'failed', runSlug: 'old-run' }],
    failInterruptedRunningTasks: (_goalId?: string, onRecovered?: (task: TaskState) => void) => {
      if (status !== 'running') return 0;
      status = 'failed';
      onRecovered?.(record());
      return 1;
    },
  } as unknown as TaskRunner;
  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(1);
  expect(save).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'completion', goalId: goalRecord().id, taskName: 'task-a', runSlug: 'run-a', result: completion });
  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(0); expect(save).toHaveBeenCalledOnce();
});

it.each([false, true])('publishes only its own saved recovery when another caller commits first (own task: %s)', (hasOwnTask) => {
  const completion = { success: false, interrupted: true };
  const record = (name: string, status: TaskState['status']): TaskState => ({
    name, kind: status, status, goalId: goalRecord().id, runSlug: `run-${name}`, completion,
    createdAt: '2026-10-06T00:00:00Z', filePath: '/project/.takt/tasks.yaml',
  });
  let tasks = [record('other-caller', 'running'), ...(hasOwnTask ? [record('own', 'running')] : [])];
  const runner = {
    listTaskStateItems: () => tasks,
    failInterruptedRunningTasks: (_goalId?: string, onRecovered?: (task: TaskState) => void) => {
      const own = tasks.find((task) => task.name === 'own' && task.status === 'running');
      // 一覧取得と更新の間に、競合相手が other-caller を保存した状態を再現する。
      tasks = tasks.map((task) => record(task.name, 'failed'));
      if (own === undefined) return 0;
      onRecovered?.(record(own.name, 'failed'));
      return 1;
    },
  } as unknown as TaskRunner;

  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(hasOwnTask ? 1 : 0);

  expect(save.mock.calls).toEqual(hasOwnTask ? [[
    '/project', { kind: 'completion', goalId: goalRecord().id, taskName: 'own', runSlug: 'run-own', result: completion },
  ]] : []);
  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(0);
  expect(save).toHaveBeenCalledTimes(hasOwnTask ? 1 : 0);
});

it.each(['goalId', 'completion', 'runSlug'] as const)('does not publish a recovered task without %s', (missing) => {
  const task: TaskState = { name: 'task-a', kind: 'failed', status: 'failed', goalId: goalRecord().id,
    runSlug: 'run-a', completion: { success: false, interrupted: true },
    createdAt: '2026-10-06T00:00:00Z', filePath: '/project/.takt/tasks.yaml' };
  delete task[missing];
  let recovered = false;
  const runner = {
    listTaskStateItems: () => [{ ...task, status: recovered ? 'failed' : 'running' }],
    failInterruptedRunningTasks: (_goalId?: string, onRecovered?: (task: TaskState) => void) => {
      recovered = true;
      onRecovered?.(task);
      return 1;
    },
  } as unknown as TaskRunner;

  expect(failInterruptedTasksWithGoalEvents(runner, '/project')).toBe(1);

  expect(save).not.toHaveBeenCalled();
});

describe.each(['private', 'task-store'] as const)('eligible pending tasks for %s acquisition failures', (source) => {
  it.each([
    { goalTasksOnly: false, goalId: undefined, status: 'pending', retry: true },
    { goalTasksOnly: true, goalId: undefined, status: 'pending', retry: false },
    { goalTasksOnly: true, goalId: goalRecord().id, status: 'pending', retry: true },
    { goalTasksOnly: false, goalId: goalRecord().id, status: 'failed', retry: false },
  ])('wraps claim ENOSPC only for eligible pending tasks: %j', ({ goalTasksOnly, goalId, status, retry }) => {
    const failure = source === 'private'
      ? new PrivateFileLockAcquisitionError('disk full', 'ENOSPC', undefined, {})
      : new TaskClaimLockAcquisitionError('disk full', { cause: new Error('disk full') });
    const runner = {
      listTaskStateItems: () => [{ name: 'task-a', goalId, status }],
      claimNextTasks: () => { throw failure; },
    } as unknown as TaskRunner;
    const claim = () => claimTasksWithGoalCompletions(runner, 1, '/project', new AbortController().signal, goalTasksOnly);
    if (retry) {
      expect(claim).toThrow(TaskClaimLockUnavailableError);
      expect(claim).toThrow(expect.objectContaining({ cause: failure }));
    } else expect(claim).toThrow(failure);
    expect(save).not.toHaveBeenCalled();
  });
});
