import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';

const doubles = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({ deleteTaskResources: doubles.remove }));

import { isDeletableTaskStatus, selectTasksForDeletion } from '../features/tasks/list/taskDeleteSelection.js';
import { executeTaskDeletion } from '../features/tasks/list/taskDeleteExecution.js';

const goalId = '550e8400-e29b-41d4-a716-446655440000';
const statuses = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const;

function task(kind: TaskListItem['kind'], overrides: Partial<TaskListItem> = {}): TaskListItem {
  return { kind, name: `${kind}-task`, createdAt: '2026-02-09T00:00:00Z',
    filePath: '/owner/.takt/tasks.yaml', content: 'cleanup', branch: 'feature/shared',
    goalId, ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  doubles.remove.mockReturnValue(true);
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });
});
afterEach(() => vi.restoreAllMocks());

describe('selectTasksForDeletion', () => {
  it('accepts only the five deletion statuses', () => {
    for (const status of statuses) expect(isDeletableTaskStatus(status)).toBe(true);
    for (const status of ['running', 'unknown', '']) expect(isDeletableTaskStatus(status)).toBe(false);
  });

  it('selects the union of all five explicit statuses and excludes running', () => {
    const tasks = [...statuses.map((kind) => task(kind)), task('running')];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(selectTasksForDeletion(tasks, { status: [...statuses] })).toEqual(tasks.slice(0, 5));
    expect(doubles.remove).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('combines status, goal, and branch with exact matches', () => {
    const selected = task('failed');
    const tasks = [selected, task('completed'), task('failed', { goalId: '550e8400-e29b-41d4-a716-446655440001' }),
      task('failed', { goalId: undefined }), task('failed', { branch: 'feature/shared-extra' })];

    expect(selectTasksForDeletion(tasks, { status: ['failed'], goal: goalId, branch: 'feature/shared' }))
      .toEqual([selected]);
  });

  it('selects stopped tasks of one goal without requiring a status or branch', () => {
    const selected = statuses.map((kind) => task(kind));
    expect(selectTasksForDeletion([...selected, task('running'), task('failed', { goalId: undefined })],
      { goal: goalId })).toEqual(selected);
  });

  it('keeps branch-only selection completed-only while honoring an explicit failed status', () => {
    const completed = task('completed');
    const failed = task('failed');
    const tasks = [completed, failed, task('running')];

    expect(selectTasksForDeletion(tasks, { branch: 'feature/shared' })).toEqual([completed]);
    expect(selectTasksForDeletion(tasks, { branch: 'feature/shared', status: ['failed'] })).toEqual([failed]);
  });

  it.each([{}, { status: [] }])('rejects a deletion without an effective filter: %j', (filter) => {
    expect(() => selectTasksForDeletion([task('completed')], filter)).toThrow();
    expect(() => selectTasksForDeletion([], filter)).toThrow();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('returns an empty list when no task matches a valid condition', () => {
    expect(selectTasksForDeletion([task('pending')], { status: ['failed'] })).toEqual([]);
  });
});

describe('executeTaskDeletion', () => {
  it('delegates each selected task to deleteTaskResources and returns results without CLI effects', async () => {
    const targets = [task('pending'), task('failed')];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });

    const results = await executeTaskDeletion(targets);

    expect(results).toEqual(targets.map((target) => ({ task: target, success: true })));
    expect(doubles.remove.mock.calls).toEqual(targets.map((target) => [target, { quiet: true }]));
    expect(log).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('returns false and thrown failures per task and continues to subsequent tasks', async () => {
    const targets = [task('failed'), task('exceeded'), task('pending')];
    const failure = new Error('cleanup denied');
    doubles.remove.mockReturnValueOnce(false).mockImplementationOnce(() => { throw failure; });

    const results = await executeTaskDeletion(targets);

    expect(results).toEqual([
      { task: targets[0], success: false },
      { task: targets[1], success: false, error: failure },
      { task: targets[2], success: true },
    ]);
    expect(doubles.remove).toHaveBeenCalledTimes(3);
  });
});
