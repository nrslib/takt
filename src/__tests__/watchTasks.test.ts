import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

const {
  mockFailInterruptedRunningTasks,
  mockGetTasksFilePath,
  mockWatch,
  mockStop,
  mockExecuteAndCompleteTask,
  mockExecuteRunTaskAndComplete,
  mockInfo,
  mockHeader,
  mockBlankLine,
  mockStatus,
  mockSuccess,
  mockWarn,
  mockError,
  mockResolveWorkflowConfigValues,
} = vi.hoisted(() => ({
  mockFailInterruptedRunningTasks: vi.fn(),
  mockGetTasksFilePath: vi.fn(),
  mockWatch: vi.fn(),
  mockStop: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockExecuteRunTaskAndComplete: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockBlankLine: vi.fn(),
  mockStatus: vi.fn(),
  mockSuccess: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn().mockImplementation(() => ({
    failInterruptedRunningTasks: mockFailInterruptedRunningTasks,
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

vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete: mockExecuteRunTaskAndComplete,
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
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
}));

import { watchTasks } from '../features/tasks/watch/index.js';

describe('watchTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFailInterruptedRunningTasks.mockReturnValue(0);
    mockGetTasksFilePath.mockReturnValue('/project/.takt/tasks.yaml');
    mockExecuteRunTaskAndComplete.mockResolvedValue(true);
    mockResolveWorkflowConfigValues.mockReturnValue({ ignoreExceed: false });

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

  it('watch開始時に中断されたrunningタスクをfailedへ倒す', async () => {
    mockFailInterruptedRunningTasks.mockReturnValue(1);

    await watchTasks('/project');

    expect(mockFailInterruptedRunningTasks).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith('Marked 1 interrupted running task(s) as failed.');
    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteRunTaskAndComplete).toHaveBeenCalledTimes(1);
  });

  it('watch ループで executeRunTaskAndComplete を呼び出す', async () => {
    await watchTasks('/project');

    expect(mockExecuteRunTaskAndComplete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '/project',
      undefined,
      undefined,
      undefined,
    );
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('config 解決が失敗した場合は task 状態変更と watch 開始を行わない', async () => {
    mockResolveWorkflowConfigValues.mockImplementation(() => {
      throw new Error('Invalid config');
    });

    await expect(watchTasks('/project')).rejects.toThrow('Invalid config');

    expect(mockFailInterruptedRunningTasks).not.toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
    expect(mockExecuteRunTaskAndComplete).not.toHaveBeenCalled();
  });

  it('config 由来の ignoreExceed を runContext に変換する', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({ ignoreExceed: true });

    await watchTasks('/project');

    expect(mockResolveWorkflowConfigValues).toHaveBeenCalledWith('/project', ['ignoreExceed']);
    expect(mockExecuteRunTaskAndComplete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '/project',
      undefined,
      undefined,
      { ignoreIterationLimit: true },
    );
  });

  it('ignoreExceed を runContext に変換しつつ agentOverrides を維持する', async () => {
    await watchTasks('/project', {
      provider: 'codex',
      providerSource: 'cli',
      model: 'gpt-5',
      modelSource: 'cli',
      autoStrategy: 'balanced',
      ignoreExceed: true,
    });

    expect(mockExecuteRunTaskAndComplete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '/project',
      {
        provider: 'codex',
        providerSource: 'cli',
        model: 'gpt-5',
        modelSource: 'cli',
        autoStrategy: 'balanced',
      },
      undefined,
      { ignoreIterationLimit: true },
    );
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });
});
