import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getErrorMessage: vi.fn((err) => String(err)),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: vi.fn(),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  determinePiece: vi.fn(),
}));

vi.mock('../shared/constants.js', () => ({
  DEFAULT_PIECE_NAME: 'default',
}));

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { error as logError, success } from '../shared/ui/index.js';
import { executeTask } from '../features/tasks/execute/taskExecution.js';
import { determinePiece } from '../features/tasks/execute/selectAndExecute.js';
import { syncBranchWithRoot } from '../features/tasks/list/taskSyncAction.js';
import type { TaskListItem } from '../infra/task/index.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExecuteTask = vi.mocked(executeTask);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockLogError = vi.mocked(logError);
const mockSuccess = vi.mocked(success);

function makeTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    kind: 'completed',
    name: 'test-task',
    createdAt: '2026-01-01T00:00:00Z',
    filePath: '/project/.takt/tasks.yaml',
    content: 'Implement feature X',
    worktreePath: '/project-worktrees/test-task',
    ...overrides,
  };
}

const PROJECT_DIR = '/project';

describe('syncBranchWithRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockDeterminePiece.mockResolvedValue('default');
  });

  it('throws when called with a non-task BranchActionTarget', async () => {
    const branchTarget = {
      info: { branch: 'some-branch', commit: 'abc123' },
      originalInstruction: 'Do something',
    };

    await expect(
      syncBranchWithRoot(PROJECT_DIR, branchTarget as never),
    ).rejects.toThrow('Sync requires a task target.');
  });

  it('returns false and logs error when worktreePath is missing', async () => {
    const task = makeTask({ worktreePath: undefined });

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Worktree directory does not exist'),
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns false and logs error when worktreePath does not exist on disk', async () => {
    const task = makeTask();
    mockExistsSync.mockReturnValue(false);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Worktree directory does not exist'),
    );
  });

  it('returns false and logs error when git fetch fails', async () => {
    const task = makeTask();
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('fetch error'); });

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch from root'));
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('returns true and shows "Synced." when merge succeeds without conflicts', async () => {
    const task = makeTask();
    mockExecFileSync.mockReturnValue('' as never);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Synced.');
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('calls executeTask with conflict resolution instruction when merge has conflicts', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });

    mockExecuteTask.mockResolvedValue(true);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Conflicts resolved.');
    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: task.worktreePath,
        projectCwd: PROJECT_DIR,
        pieceIdentifier: 'default',
        task: expect.stringContaining('Git merge has stopped due to merge conflicts.'),
      }),
    );
  });

  it('includes original task content in conflict resolution instruction', async () => {
    const task = makeTask({ content: 'Implement feature X' });
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });
    mockExecuteTask.mockResolvedValue(true);

    await syncBranchWithRoot(PROJECT_DIR, task);

    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining('Implement feature X'),
      }),
    );
  });

  it('uses task piece when available for AI resolution', async () => {
    const task = makeTask({ data: { piece: 'custom-piece' } });
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });
    mockDeterminePiece.mockResolvedValue('custom-piece');
    mockExecuteTask.mockResolvedValue(true);

    await syncBranchWithRoot(PROJECT_DIR, task);

    expect(mockDeterminePiece).toHaveBeenCalledWith(PROJECT_DIR, 'custom-piece');
  });

  it('uses DEFAULT_PIECE_NAME when task.data.piece is not set', async () => {
    const task = makeTask({ data: undefined });
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });
    mockExecuteTask.mockResolvedValue(true);

    await syncBranchWithRoot(PROJECT_DIR, task);

    expect(mockDeterminePiece).toHaveBeenCalledWith(PROJECT_DIR, 'default');
  });

  it('aborts merge and returns false when AI resolution fails', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); })
      .mockReturnValueOnce('' as never);
    mockExecuteTask.mockResolvedValue(false);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve conflicts'),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['merge', '--abort'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
  });

  it('aborts merge and returns false when determinePiece returns null', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); })
      .mockReturnValueOnce('' as never);
    mockDeterminePiece.mockResolvedValue(null);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockExecuteTask).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['merge', '--abort'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
  });

  it('does not throw when git merge --abort itself fails', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); })
      .mockImplementationOnce(() => { throw new Error('abort failed'); });
    mockDeterminePiece.mockResolvedValue(null);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(false);
  });

  it('fetches from projectDir using local path ref', async () => {
    const task = makeTask();
    mockExecFileSync.mockReturnValue('' as never);

    await syncBranchWithRoot(PROJECT_DIR, task);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', PROJECT_DIR, 'HEAD:refs/remotes/root/sync-target'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
  });

  it('passes agentOverrides to executeTask', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });
    mockExecuteTask.mockResolvedValue(true);
    const options = { provider: 'anthropic' as never };

    await syncBranchWithRoot(PROJECT_DIR, task, options);

    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentOverrides: options }),
    );
  });
});
