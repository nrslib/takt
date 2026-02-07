/**
 * Tests for resolveTaskExecution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: vi.fn(),
  isPiecePath: vi.fn(() => false),
  loadGlobalConfig: vi.fn(() => ({})),
}));

import { loadGlobalConfig } from '../infra/config/index.js';
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TaskRunner: vi.fn(),
}));

vi.mock('../infra/task/clone.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
}));

vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentBranch: vi.fn(() => 'main'),
}));

vi.mock('../infra/task/autoCommit.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: vi.fn((e) => e.message),
}));

vi.mock('../features/tasks/execute/pieceExecution.js', () => ({
  executePiece: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../shared/constants.js', () => ({
  DEFAULT_PIECE_NAME: 'default',
  DEFAULT_LANGUAGE: 'en',
}));

import { createSharedClone } from '../infra/task/clone.js';
import { getCurrentBranch } from '../infra/task/git.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { info } from '../shared/ui/index.js';
import { resolveTaskExecution } from '../features/tasks/index.js';
import type { TaskInfo } from '../infra/task/index.js';

const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockInfo = vi.mocked(info);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTaskExecution', () => {
  it('should return defaults when task has no data', async () => {
    // Given: Task without structured data
    const task: TaskInfo = {
      name: 'simple-task',
      content: 'Simple task content',
      filePath: '/tasks/simple-task.yaml',
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result).toEqual({
      execCwd: '/project',
      execPiece: 'default',
      isWorktree: false,
    });
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
  });

  it('should return defaults when data has no worktree option', async () => {
    // Given: Task with data but no worktree
    const task: TaskInfo = {
      name: 'task-with-data',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.isWorktree).toBe(false);
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should create shared clone with AI-summarized slug when worktree option is true', async () => {
    // Given: Task with worktree option
    const task: TaskInfo = {
      name: 'japanese-task',
      content: '認証機能を追加する',
      filePath: '/tasks/japanese-task.yaml',
      data: {
        task: '認証機能を追加する',
        worktree: true,
      },
    };

    mockSummarizeTaskName.mockResolvedValue('add-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-add-auth',
      branch: 'takt/20260128T0504-add-auth',
    });

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('認証機能を追加する', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      branch: undefined,
      taskSlug: 'add-auth',
    });
    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/project');
    expect(result).toEqual({
      execCwd: '/project/../20260128T0504-add-auth',
      execPiece: 'default',
      isWorktree: true,
      branch: 'takt/20260128T0504-add-auth',
      baseBranch: 'main',
    });
  });

  it('should display generating message before AI call', async () => {
    // Given: Task with worktree
    const task: TaskInfo = {
      name: 'test-task',
      content: 'Test task',
      filePath: '/tasks/test.yaml',
      data: {
        task: 'Test task',
        worktree: true,
      },
    };

    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../test-task',
      branch: 'takt/test-task',
    });

    // When
    await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('Generating branch name...');
  });

  it('should use task content (not name) for AI summarization', async () => {
    // Given: Task where name differs from content
    const task: TaskInfo = {
      name: 'old-file-name',
      content: 'New feature implementation details',
      filePath: '/tasks/old-file-name.yaml',
      data: {
        task: 'New feature implementation details',
        worktree: true,
      },
    };

    mockSummarizeTaskName.mockResolvedValue('new-feature');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../new-feature',
      branch: 'takt/new-feature',
    });

    // When
    await resolveTaskExecution(task, '/project', 'default');

    // Then: Should use content, not file name
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('New feature implementation details', { cwd: '/project' });
  });

  it('should use piece override from task data', async () => {
    // Given: Task with piece override
    const task: TaskInfo = {
      name: 'task-with-piece',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        piece: 'custom-piece',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.execPiece).toBe('custom-piece');
  });

  it('should pass branch option to createSharedClone when specified', async () => {
    // Given: Task with custom branch
    const task: TaskInfo = {
      name: 'task-with-branch',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        worktree: true,
        branch: 'feature/custom-branch',
      },
    };

    mockSummarizeTaskName.mockResolvedValue('custom-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../custom-task',
      branch: 'feature/custom-branch',
    });

    // When
    await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      branch: 'feature/custom-branch',
      taskSlug: 'custom-task',
    });
  });

  it('should display clone creation info', async () => {
    // Given: Task with worktree
    const task: TaskInfo = {
      name: 'info-task',
      content: 'Info task',
      filePath: '/tasks/info.yaml',
      data: {
        task: 'Info task',
        worktree: true,
      },
    };

    mockSummarizeTaskName.mockResolvedValue('info-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128-info-task',
      branch: 'takt/20260128-info-task',
    });

    // When
    await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      'Clone created: /project/../20260128-info-task (branch: takt/20260128-info-task)'
    );
  });

  it('should return autoPr from task YAML when specified', async () => {
    // Given: Task with auto_pr option
    const task: TaskInfo = {
      name: 'task-with-auto-pr',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        auto_pr: true,
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.autoPr).toBe(true);
  });

  it('should return autoPr: false from task YAML when specified as false', async () => {
    // Given: Task with auto_pr: false
    const task: TaskInfo = {
      name: 'task-no-auto-pr',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        auto_pr: false,
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.autoPr).toBe(false);
  });

  it('should fall back to global config autoPr when task YAML does not specify', async () => {
    // Given: Task without auto_pr, global config has autoPr
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      autoPr: true,
    });

    const task: TaskInfo = {
      name: 'task-no-auto-pr-setting',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.autoPr).toBe(true);
  });

  it('should return undefined autoPr when neither task nor config specifies', async () => {
    // Given: Neither task nor config has autoPr
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
    });

    const task: TaskInfo = {
      name: 'task-default',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.autoPr).toBeUndefined();
  });

  it('should prioritize task YAML auto_pr over global config', async () => {
    // Given: Task has auto_pr: false, global config has autoPr: true
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      autoPr: true,
    });

    const task: TaskInfo = {
      name: 'task-override',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        auto_pr: false,
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.autoPr).toBe(false);
  });

  it('should capture baseBranch from getCurrentBranch when worktree is used', async () => {
    // Given: Task with worktree, on 'develop' branch
    mockGetCurrentBranch.mockReturnValue('develop');
    const task: TaskInfo = {
      name: 'task-on-develop',
      content: 'Task on develop branch',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task on develop branch',
        worktree: true,
      },
    };

    mockSummarizeTaskName.mockResolvedValue('task-develop');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../task-develop',
      branch: 'takt/task-develop',
    });

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/project');
    expect(result.baseBranch).toBe('develop');
  });

  it('should not set baseBranch when worktree is not used', async () => {
    // Given: Task without worktree
    const task: TaskInfo = {
      name: 'task-no-worktree',
      content: 'Task without worktree',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task without worktree',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
    expect(result.baseBranch).toBeUndefined();
  });
});
