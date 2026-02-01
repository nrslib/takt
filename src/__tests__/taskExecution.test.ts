/**
 * Tests for resolveTaskExecution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../config/index.js', () => ({
  loadWorkflowByIdentifier: vi.fn(),
  isWorkflowPath: vi.fn(() => false),
  loadGlobalConfig: vi.fn(() => ({})),
}));

vi.mock('../task/index.js', () => ({
  TaskRunner: vi.fn(),
}));

vi.mock('../task/clone.js', () => ({
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
}));

vi.mock('../task/autoCommit.js', () => ({
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../utils/ui.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../utils/debug.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../utils/error.js', () => ({
  getErrorMessage: vi.fn((e) => e.message),
}));

vi.mock('./workflowExecution.js', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('../cli.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../constants.js', () => ({
  DEFAULT_WORKFLOW_NAME: 'default',
  DEFAULT_LANGUAGE: 'en',
}));

import { createSharedClone } from '../task/clone.js';
import { summarizeTaskName } from '../task/summarize.js';
import { info } from '../utils/ui.js';
import { resolveTaskExecution } from '../commands/taskExecution.js';
import type { TaskInfo } from '../task/index.js';

const mockCreateSharedClone = vi.mocked(createSharedClone);
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
      execWorkflow: 'default',
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
    expect(result).toEqual({
      execCwd: '/project/../20260128T0504-add-auth',
      execWorkflow: 'default',
      isWorktree: true,
      branch: 'takt/20260128T0504-add-auth',
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

  it('should use workflow override from task data', async () => {
    // Given: Task with workflow override
    const task: TaskInfo = {
      name: 'task-with-workflow',
      content: 'Task content',
      filePath: '/tasks/task.yaml',
      data: {
        task: 'Task content',
        workflow: 'custom-workflow',
      },
    };

    // When
    const result = await resolveTaskExecution(task, '/project', 'default');

    // Then
    expect(result.execWorkflow).toBe('custom-workflow');
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
});
