import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const {
  mockRecoverInterruptedRunningTasks,
  mockGetTasksFilePath,
  mockWatch,
  mockStop,
  mockExecuteAndCompleteTask,
  mockInfo,
  mockHeader,
  mockBlankLine,
  mockStatus,
  mockSuccess,
  mockWarn,
  mockError,
  mockResolveConfigValue,
} = vi.hoisted(() => ({
  mockRecoverInterruptedRunningTasks: vi.fn(),
  mockGetTasksFilePath: vi.fn(),
  mockWatch: vi.fn(),
  mockStop: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockBlankLine: vi.fn(),
  mockStatus: vi.fn(),
  mockSuccess: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockResolveConfigValue: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn().mockImplementation(() => ({
    recoverInterruptedRunningTasks: mockRecoverInterruptedRunningTasks,
    getTasksFilePath: mockGetTasksFilePath,
  })),
  TaskWatcher: vi.fn().mockImplementation(() => ({
    watch: mockWatch,
    stop: mockStop,
  })),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: mockExecuteAndCompleteTask,
}));

vi.mock('../shared/ui/index.js', () => ({
  header: mockHeader,
  info: mockInfo,
  warn: mockWarn,
  error: mockError,
  success: mockSuccess,
  status: mockStatus,
  blankLine: mockBlankLine,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => key),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: mockResolveConfigValue,
}));

import { watchTasks } from '../features/tasks/watch/index.js';

describe('watchTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfigValue.mockReturnValue('default');
    mockRecoverInterruptedRunningTasks.mockReturnValue(0);
    mockGetTasksFilePath.mockReturnValue('/project/.takt/tasks.yaml');
    mockExecuteAndCompleteTask.mockResolvedValue(true);

    mockWatch.mockImplementation(async (onTask: (task: TaskInfo) => Promise<void>) => {
      await onTask({
        name: 'task-1',
        content: 'Task 1',
        filePath: '/project/.takt/tasks.yaml',
        createdAt: '2026-02-09T00:00:00.000Z',
        status: 'running',
        data: null,
      });
    });
  });

  it('watch開始時に中断されたrunningタスクをpendingへ復旧する', async () => {
    mockRecoverInterruptedRunningTasks.mockReturnValue(1);

    await watchTasks('/project');

    expect(mockRecoverInterruptedRunningTasks).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith('Recovered 1 interrupted running task(s) to pending.');
    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledTimes(1);
  });
});
