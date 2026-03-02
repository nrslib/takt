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

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushBranch: vi.fn(),
}));

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { error as logError, success } from '../shared/ui/index.js';
import { pushBranch } from '../infra/task/index.js';
import { pullFromRemote } from '../features/tasks/list/taskPullAction.js';
import type { TaskListItem } from '../infra/task/index.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockLogError = vi.mocked(logError);
const mockSuccess = vi.mocked(success);
const mockPushBranch = vi.mocked(pushBranch);

const PROJECT_DIR = '/project';
const ORIGIN_URL = 'git@github.com:user/repo.git';

function makeTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    kind: 'completed',
    name: 'test-task',
    branch: 'task/test-task',
    createdAt: '2026-01-01T00:00:00Z',
    filePath: '/project/.takt/tasks.yaml',
    content: 'Implement feature X',
    worktreePath: '/project-worktrees/test-task',
    ...overrides,
  };
}

describe('pullFromRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('' as never);
  });

  it('should throw when called with a non-task BranchActionTarget', () => {
    const branchTarget = {
      info: { branch: 'some-branch', commit: 'abc123' },
      originalInstruction: 'Do something',
    };

    expect(
      () => pullFromRemote(PROJECT_DIR, branchTarget as never),
    ).toThrow('Pull requires a task target.');
  });

  it('should return false and log error when worktreePath is missing', () => {
    const task = makeTask({ worktreePath: undefined });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Worktree directory does not exist'),
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('should return false and log error when worktreePath does not exist on disk', () => {
    const task = makeTask();
    mockExistsSync.mockReturnValue(false);

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Worktree directory does not exist'),
    );
  });

  it('should get origin URL from projectDir', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      return '' as never;
    });

    pullFromRemote(PROJECT_DIR, task);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['config', '--get', 'remote.origin.url'],
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('should add temporary origin, pull, and remove origin', () => {
    const task = makeTask();
    const calls: string[][] = [];
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      calls.push(argsArr);
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Pulled & pushed.');

    // Verify git remote add was called on worktree
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['remote', 'add', 'origin', ORIGIN_URL],
      expect.objectContaining({ cwd: task.worktreePath }),
    );

    // Verify git pull --ff-only was called on worktree
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['pull', '--ff-only', 'origin', 'task/test-task'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );

    // Verify git remote remove was called on worktree
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['remote', 'remove', 'origin'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
  });

  it('should push to projectDir then to origin after successful pull', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      return '' as never;
    });

    pullFromRemote(PROJECT_DIR, task);

    // worktree → project push
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['push', PROJECT_DIR, 'HEAD'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
    // project → origin push
    expect(mockPushBranch).toHaveBeenCalledWith(PROJECT_DIR, 'task/test-task');
  });

  it('should return false and suggest sync when pull fails (not fast-forwardable)', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      if (argsArr[0] === 'pull') throw new Error('fatal: Not possible to fast-forward');
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Pull failed'),
    );
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Sync with root'),
    );
    // Should NOT push when pull fails
    expect(mockPushBranch).not.toHaveBeenCalled();
  });

  it('should remove temporary remote even when pull fails', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      if (argsArr[0] === 'pull') throw new Error('fatal: Not possible to fast-forward');
      return '' as never;
    });

    pullFromRemote(PROJECT_DIR, task);

    // Verify remote remove was still called (cleanup in finally)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['remote', 'remove', 'origin'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
  });

  it('should not throw when git remote remove itself fails', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      if (argsArr[0] === 'pull') throw new Error('pull failed');
      if (argsArr[0] === 'remote' && argsArr[1] === 'remove') throw new Error('remove failed');
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
  });

  it('should return false when getOriginUrl fails (root repo has no origin)', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') throw new Error('fatal: No such remote \'origin\'');
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get origin URL'),
    );
    // Should not attempt remote add or pull
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git', expect.arrayContaining(['remote', 'add']),
      expect.anything(),
    );
  });

  it('should return false when git remote add fails', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      if (argsArr[0] === 'remote' && argsArr[1] === 'add') throw new Error('fatal: remote origin already exists');
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to add temporary remote'),
    );
    // Should still attempt remote remove (finally block)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['remote', 'remove', 'origin'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
    // Should not push
    expect(mockPushBranch).not.toHaveBeenCalled();
  });

  it('should return false when git push to projectDir fails after pull', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      if (argsArr[0] === 'push') throw new Error('push failed');
      return '' as never;
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Push failed after pull'),
    );
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should return false when pushBranch fails after pull', () => {
    const task = makeTask();
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'config') return `${ORIGIN_URL}\n` as never;
      return '' as never;
    });
    mockPushBranch.mockImplementation(() => {
      throw new Error('push to origin failed');
    });

    const result = pullFromRemote(PROJECT_DIR, task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('Push failed after pull'),
    );
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});
