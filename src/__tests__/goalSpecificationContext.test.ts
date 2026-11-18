import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { stageGoalSpecificationsForExecution } from '../features/tasks/execute/goalSpecificationContext.js';

vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class {
    getSync() { return { specifications: { gherkin: 'Feature: Export', quint: 'module export {}' } }; }
  },
}));

const paths = buildRunPaths('/project', 'specifications');
beforeEach(() => { vi.resetAllMocks(); });

it('removes partially staged files and preserves the write failure when cleanup succeeds', () => {
  const writeFailure = new Error('write failed');
  vi.mocked(writeFileSync).mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw writeFailure; });

  expect(() => stageGoalSpecificationsForExecution('/project', 'goal', paths)).toThrow(writeFailure);
  expect(writeFileSync).toHaveBeenCalledTimes(2);
  expect(rmSync).toHaveBeenCalledExactlyOnceWith(`${paths.contextTaskAbs}/specifications`, { recursive: true, force: true });
});

it('keeps the write failure as the primary cause and retains a cleanup failure', () => {
  const writeFailure = new Error('write failed');
  const cleanupFailure = new Error('cleanup failed');
  vi.mocked(writeFileSync).mockImplementation(() => { throw writeFailure; });
  vi.mocked(rmSync).mockImplementation(() => { throw cleanupFailure; });

  expect(() => stageGoalSpecificationsForExecution('/project', 'goal', paths)).toThrow(expect.objectContaining({
    cause: writeFailure, errors: [writeFailure, cleanupFailure], message: writeFailure.message,
  }));
});

it('preserves a directory creation failure when cleanup succeeds', () => {
  const failure = new Error('mkdir failed');
  vi.mocked(mkdirSync).mockImplementation(() => { throw failure; });

  expect(() => stageGoalSpecificationsForExecution('/project', 'goal', paths)).toThrow(failure);
  expect(writeFileSync).not.toHaveBeenCalled();
});
