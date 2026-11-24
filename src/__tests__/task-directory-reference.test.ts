import { beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { hasTaskDirectory } from '../infra/task/taskStateReader.js';
import { readWatchTasks } from '../features/daemon/watchers/state.js';

const { read, stat } = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: read, lstat: stat }));
beforeEach(() => {
  vi.resetAllMocks();
  stat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
});

const task = {
  name: 'task-a', status: 'pending', task_dir: '.takt/tasks/image-task',
  created_at: '2026-11-18T00:00:00Z', started_at: null, completed_at: null,
};

it.each(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed'] as const)(
  'retains a directory reference while a %s task record exists', async (status) => {
    read.mockResolvedValue(stringify({ tasks: [{ ...task, status }] }));
    expect(await hasTaskDirectory('/repository', resolve('/repository', task.task_dir))).toBe(true);
    expect(await hasTaskDirectory('/repository', '.takt/tasks/other-task')).toBe(false);
    read.mockResolvedValue(stringify({ tasks: [{ ...task, task_dir: undefined }] }));
    expect(await hasTaskDirectory('/repository', task.task_dir)).toBe(false);
    read.mockResolvedValue(stringify({ tasks: [] }));
    expect(await hasTaskDirectory('/repository', task.task_dir)).toBe(false);
  });

it('uses the same saved task directory for watcher observations and image retention', async () => {
  read.mockResolvedValue(stringify({ tasks: [task] }));
  expect(await readWatchTasks('/repository')).toEqual([task]);
  expect(await hasTaskDirectory('/repository', task.task_dir)).toBe(true);

  const changed = { ...task, task_dir: '.takt/tasks/other-task' };
  read.mockResolvedValue(stringify({ tasks: [changed] }));
  expect(await readWatchTasks('/repository')).toEqual([changed]);
  expect(await hasTaskDirectory('/repository', task.task_dir)).toBe(false);
});

it('treats an absent tasks file as no task references', async () => {
  stat.mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  expect(await hasTaskDirectory('/repository', task.task_dir)).toBe(false);
  expect(await readWatchTasks('/repository')).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it('rejects a broken tasks file symlink before reading task references', async () => {
  stat.mockResolvedValue({ isFile: () => false, isSymbolicLink: () => true });
  read.mockRejectedValue(Object.assign(new Error('broken link'), { code: 'ENOENT' }));
  await expect(hasTaskDirectory('/repository', task.task_dir)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('propagates a read failure instead of reporting an absent reference', async () => {
  const failure = Object.assign(new Error('task storage unreadable'), { code: 'EACCES' });
  read.mockRejectedValue(failure);
  await expect(hasTaskDirectory('/repository', task.task_dir)).rejects.toBe(failure);
  await expect(readWatchTasks('/repository')).rejects.toBe(failure);
});

it.each([
  'tasks: [',
  'tasks: [{ name: task-a, status: unknown }]',
  'tasks:\n  - &task { name: task-a, status: pending, created_at: now, started_at: null, completed_at: null }\n  - *task',
])('rejects malformed or invalid task snapshots rather than releasing their images', async (content) => {
  read.mockResolvedValue(content);
  await expect(hasTaskDirectory('/repository', task.task_dir)).rejects.toThrow();
  await expect(readWatchTasks('/repository')).rejects.toThrow();
});
