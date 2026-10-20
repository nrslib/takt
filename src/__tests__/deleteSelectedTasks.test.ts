import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';
import type { SelectOptionItem } from '../shared/prompt/index.js';
import type { TaskDeletionCleanup } from '../infra/task/taskDeletionService.js';

const {
  mockSelectMultipleOptions, mockConfirm, mockDeleteTask, mockValidateTask, mockRunner,
  mockDeleteBranch, mockLstatSync, mockRmSync, mockAssertReusableWorktreePath,
  mockSuccess, mockError,
} = vi.hoisted(() => ({
  mockSelectMultipleOptions: vi.fn(),
  mockConfirm: vi.fn(),
  mockDeleteTask: vi.fn(),
  mockValidateTask: vi.fn(),
  mockRunner: vi.fn(),
  mockDeleteBranch: vi.fn(),
  mockLstatSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockAssertReusableWorktreePath: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectMultipleOptions: mockSelectMultipleOptions,
  confirm: mockConfirm,
}));
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    constructor(projectDir: string) { mockRunner(projectDir); }
    deleteTask(name: string, kind: string, cleanup?: TaskDeletionCleanup) {
      mockValidateTask(name, kind);
      cleanup?.();
      mockDeleteTask(name, kind);
    }
  },
}));
vi.mock('../features/tasks/list/taskActions.js', () => ({ deleteBranch: mockDeleteBranch }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: mockLstatSync,
  rmSync: mockRmSync,
}));
vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: mockAssertReusableWorktreePath,
}));
vi.mock('../shared/ui/index.js', () => ({ success: mockSuccess, error: mockError }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { deleteAllTasks, deleteSelectedTasks } from '../features/tasks/list/taskDeleteActions.js';

function task(name: string, kind: TaskListItem['kind'], extra: Partial<TaskListItem> = {}): TaskListItem {
  return { name, kind, createdAt: '2026-10-20T00:00:00.000Z',
    filePath: '/project/.takt/tasks.yaml', content: 'instruction', ...extra };
}

function selectLabels(labels: string[]): void {
  mockSelectMultipleOptions.mockImplementationOnce(async (_message: string, options: SelectOptionItem<string>[]) => {
    const selected = options.filter((option) => labels.includes(option.label));
    expect(selected.map((option) => option.label).sort()).toEqual([...labels].sort());
    return selected.map((option) => option.value);
  });
}

function expectNoDeletion(): void {
  expect(mockDeleteBranch).not.toHaveBeenCalled();
  expect(mockLstatSync).not.toHaveBeenCalled();
  expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
  expect(mockRmSync).not.toHaveBeenCalled();
  expect(mockValidateTask).not.toHaveBeenCalled();
  expect(mockDeleteTask).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockDeleteBranch.mockReturnValue(true);
  mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
  mockSelectMultipleOptions.mockResolvedValue([]);
});

describe('deleteSelectedTasks', () => {
  it.each([false, true])('checks the current state before cleanup after selection: claimed=%s', async (claimed) => {
    const tasks = [task('first', 'pending', { branch: 'takt/first' }), task('second', 'completed')];
    const statuses = new Map(tasks.map(({ name, kind }) => [name, kind]));
    mockValidateTask.mockImplementation((name: string, kind: string) => {
      if (statuses.get(name) !== kind) throw new Error('Task status changed');
    });
    let select!: (values: string[]) => void;
    mockSelectMultipleOptions.mockReturnValueOnce(new Promise<string[]>((resolve) => { select = resolve; }));

    const operation = deleteSelectedTasks(tasks);
    expectNoDeletion();
    if (claimed) statuses.set('first', 'running');
    select(['0', '1']);
    expect(await operation).toBe(true);

    expect(mockDeleteBranch).toHaveBeenCalledTimes(claimed ? 0 : 1);
    expect(mockDeleteTask.mock.calls).toEqual(claimed
      ? [['second', 'completed']] : [['first', 'pending'], ['second', 'completed']]);
    expect(mockSuccess).toHaveBeenCalledWith(`Deleted ${claimed ? 1 : 2} of 2 tasks.`);
  });

  it('offers all five non-running kinds and never deletes the running task', async () => {
    const kinds = ['pending', 'running', 'failed', 'completed', 'exceeded', 'pr_failed'] as const;
    const tasks = kinds.map((kind) => task(`${kind}-task`, kind));
    mockSelectMultipleOptions.mockImplementationOnce(async (_message: string, options: SelectOptionItem<string>[]) => {
      expect(options.map((option) => option.label).sort()).toEqual([
        '[pending] pending-task', '[failed] failed-task', '[completed] completed-task',
        '[exceeded] exceeded-task', '[pr-failed] pr_failed-task',
      ].sort());
      return options.map((option) => option.value);
    });

    await deleteSelectedTasks(tasks);

    expect(mockSelectMultipleOptions).toHaveBeenCalledTimes(1);
    expect([...mockDeleteTask.mock.calls].sort()).toEqual([
      ['pending-task', 'pending'], ['failed-task', 'failed'], ['completed-task', 'completed'],
      ['exceeded-task', 'exceeded'], ['pr_failed-task', 'pr_failed'],
    ].sort());
  });

  it('waits for one count confirmation before cleaning up only the three selected tasks', async () => {
    const tasks = ['first', 'second', 'third', 'unselected'].map((name) =>
      task(name, 'completed', { branch: `takt/${name}` }));
    selectLabels(['[completed] first (takt/first)', '[completed] second (takt/second)', '[completed] third (takt/third)']);
    let approve!: (approved: boolean) => void;
    mockConfirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { approve = resolve; }));

    const operation = deleteSelectedTasks(tasks);
    try {
      await vi.waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(mockConfirm).toHaveBeenCalledWith(expect.stringMatching(/\b3\b/), false);
      expectNoDeletion();
    } finally {
      approve(true);
      await operation;
    }

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDeleteBranch).toHaveBeenCalledTimes(3);
    expect(mockDeleteBranch.mock.calls).toEqual(expect.arrayContaining(tasks.slice(0, 3).map((selected) => ['/project', selected])));
    expect([...mockDeleteTask.mock.calls].sort()).toEqual([['first', 'completed'], ['second', 'completed'], ['third', 'completed']]);
    expect(mockSuccess).toHaveBeenCalledWith('Deleted 3 of 3 tasks.');
  });

  it.each([{ selection: [] }, { selection: null }])('does not confirm or delete when selection is $selection', async ({ selection }) => {
    mockSelectMultipleOptions.mockResolvedValueOnce(selection);

    await deleteSelectedTasks([task('first', 'completed', { branch: 'takt/first' })]);

    expect(mockSelectMultipleOptions).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expectNoDeletion();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('does not delete either selected task when confirmation is declined', async () => {
    selectLabels(['[pending] first', '[failed] second']);
    mockConfirm.mockResolvedValueOnce(false);

    await deleteSelectedTasks([task('first', 'pending'), task('second', 'failed')]);

    expect(mockConfirm).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\b2\b/), false);
    expectNoDeletion();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it.each([0, 1])('deletes only selected original name %s when display labels collide', async (selectedIndex) => {
    const names = ['alpha', '\u001b[2Jalpha'];
    mockSelectMultipleOptions.mockImplementationOnce(async (_message: string, options: SelectOptionItem<string>[]) => {
      expect(options.map((option) => option.label)).toEqual(['[pending] alpha', '[pending] alpha']);
      expect(new Set(options.map((option) => option.value)).size).toBe(2);
      return [options[selectedIndex]!.value];
    });

    await deleteSelectedTasks(names.map((name) => task(name, 'pending')));

    expect(mockDeleteTask).toHaveBeenCalledExactlyOnceWith(names[selectedIndex], 'pending');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted 1 of 1 tasks.');
  });

  it('cleans the branch before deleting the original task in its own project', async () => {
    const selected = task('branch-task', 'failed', {
      filePath: '/other/.takt/tasks.yaml', branch: 'takt/branch-task', worktreePath: '/other/clone',
    });
    const effects: string[] = [];
    mockDeleteBranch.mockImplementation(() => { effects.push('cleanup'); return true; });
    mockDeleteTask.mockImplementation(() => { effects.push('record'); });
    selectLabels(['[failed] branch-task (takt/branch-task)']);

    await deleteSelectedTasks([selected]);

    expect(mockDeleteBranch).toHaveBeenCalledExactlyOnceWith('/other', selected);
    expect(mockRunner).toHaveBeenCalledExactlyOnceWith('/other');
    expect(mockDeleteTask).toHaveBeenCalledExactlyOnceWith('branch-task', 'failed');
    expect(effects).toEqual(['cleanup', 'record']);
  });

  it('validates and removes a merge clone before deleting its record without deleting main', async () => {
    const selected = task('merge-pr-123', 'failed', {
      branch: 'main', worktreePath: '/project/.takt/worktrees/merge-pr-123',
      data: { task: 'merge PR', workflow: 'merge-review-fix-simple', merge_task: true },
    });
    const effects: string[] = [];
    mockAssertReusableWorktreePath.mockImplementation(() => { effects.push('validate'); });
    mockRmSync.mockImplementation(() => { effects.push('clone'); });
    mockDeleteTask.mockImplementation(() => { effects.push('record'); });
    selectLabels(['[failed] merge-pr-123 (main)']);

    await deleteSelectedTasks([selected]);

    expect(mockLstatSync).toHaveBeenCalledWith(selected.worktreePath);
    expect(mockAssertReusableWorktreePath).toHaveBeenCalledExactlyOnceWith('/project', selected.worktreePath);
    expect(mockRmSync).toHaveBeenCalledExactlyOnceWith(selected.worktreePath, { recursive: true, force: true });
    expect(mockDeleteTask).toHaveBeenCalledExactlyOnceWith(selected.name, 'failed');
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(effects).toEqual(['validate', 'clone', 'record']);
  });

  it('keeps a cleanup failure and continues with the other two selected tasks', async () => {
    const failed = task('broken', 'failed', { branch: 'takt/broken' });
    const effects: string[] = [];
    selectLabels(['[failed] broken (takt/broken)', '[pending] second', '[completed] third']);
    mockDeleteBranch.mockReturnValueOnce(false);
    mockDeleteTask.mockImplementation((name: string) => { effects.push(name); });
    mockSuccess.mockImplementation((message: string) => { effects.push(message); });

    await deleteSelectedTasks([failed, task('second', 'pending'), task('third', 'completed'), task('unselected', 'pending')]);

    expect(mockDeleteBranch).toHaveBeenCalledExactlyOnceWith('/project', failed);
    expect([...mockDeleteTask.mock.calls].sort()).toEqual([['second', 'pending'], ['third', 'completed']]);
    expect(mockError).toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalledWith('Deleted 2 of 3 tasks.');
    expect(effects.slice(0, -1).sort()).toEqual(['second', 'third']);
    expect(effects.at(-1)).toBe('Deleted 2 of 3 tasks.');
  });

  it.each(['cleanup', 'record'] as const)('continues once per target after a %s exception', async (failure) => {
    selectLabels(['[failed] first (takt/first)', '[pending] second']);
    const failingOperation = failure === 'cleanup' ? mockDeleteBranch : mockDeleteTask;
    failingOperation.mockImplementationOnce(() => { throw new Error('operation failed'); });

    await deleteSelectedTasks([task('first', 'failed', { branch: 'takt/first' }), task('second', 'pending')]);

    expect([...mockDeleteTask.mock.calls].sort()).toEqual(failure === 'cleanup'
      ? [['second', 'pending']] : [['first', 'failed'], ['second', 'pending']]);
    expect(mockDeleteBranch).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalledWith('Deleted 1 of 2 tasks.');
  });

  it('reports zero successful deletions when every selected task fails', async () => {
    selectLabels(['[completed] first (takt/first)', '[failed] second (takt/second)']);
    mockDeleteBranch.mockReturnValue(false);

    await deleteSelectedTasks([
      task('first', 'completed', { branch: 'takt/first' }), task('second', 'failed', { branch: 'takt/second' }),
    ]);

    expect(mockDeleteBranch).toHaveBeenCalledTimes(2);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalledWith('Deleted 0 of 2 tasks.');
  });

  it('starts a new selection empty after declining a previous selection', async () => {
    const tasks = [task('first', 'pending'), task('second', 'failed')];
    selectLabels(['[pending] first']);
    mockConfirm.mockResolvedValueOnce(false);

    await deleteSelectedTasks(tasks);
    await deleteSelectedTasks(tasks);

    expect(mockSelectMultipleOptions).toHaveBeenCalledTimes(2);
    expect(mockSelectMultipleOptions.mock.calls.map((call) => call[2])).toEqual([[], []]);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expectNoDeletion();
  });

  it.each([{ tasks: [] }, { tasks: [task('active', 'running')] }])('does not confirm or delete when there are no non-running tasks: $tasks', async ({ tasks }) => {
    await deleteSelectedTasks(tasks);

    expect(mockConfirm).not.toHaveBeenCalled();
    expectNoDeletion();
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});

describe('deleteAllTasks regression', () => {
  it('keeps the zero-success result without displaying a success summary or a selector', async () => {
    mockDeleteBranch.mockReturnValue(false);

    const result = await deleteAllTasks([
      task('first', 'completed', { branch: 'takt/first' }), task('active', 'running'),
    ]);

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalledExactlyOnceWith('Delete all 1 tasks?', false);
    expect(mockDeleteBranch).toHaveBeenCalledTimes(1);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockSelectMultipleOptions).not.toHaveBeenCalled();
  });
});
