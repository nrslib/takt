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
  StreamDisplay: vi.fn(() => ({
    createHandler: vi.fn(() => vi.fn()),
  })),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getErrorMessage: vi.fn((err) => String(err)),
}));

const mockAgentCall = vi.fn();

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({
    setup: vi.fn(() => ({ call: mockAgentCall })),
  })),
}));

vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn(() => 'en'),
  resolveConfigValues: vi.fn(() => ({ provider: 'claude', model: 'sonnet' })),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushBranch: vi.fn(),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn((_name: string, _lang: string, vars?: Record<string, string>) => {
    if (_name === 'sync_conflict_resolver_system_prompt') return 'system-prompt';
    if (_name === 'sync_conflict_resolver_message') return `message:${vars?.originalInstruction ?? ''}`;
    return '';
  }),
}));

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { error as logError, success } from '../shared/ui/index.js';
import { pushBranch } from '../infra/task/index.js';
import { getProvider } from '../infra/providers/index.js';
import { syncBranchWithRoot } from '../features/tasks/list/taskSyncAction.js';
import type { TaskListItem } from '../infra/task/index.js';
import type { AgentResponse } from '../core/models/index.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockLogError = vi.mocked(logError);
const mockSuccess = vi.mocked(success);
const mockPushBranch = vi.mocked(pushBranch);
const mockGetProvider = vi.mocked(getProvider);

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

function makeAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'conflict-resolver',
    status: 'done',
    content: 'Conflicts resolved',
    timestamp: new Date(),
    ...overrides,
  };
}

const PROJECT_DIR = '/project';

describe('syncBranchWithRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockAgentCall.mockResolvedValue(makeAgentResponse());
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
    expect(mockAgentCall).not.toHaveBeenCalled();
  });

  it('returns true and pushes when merge succeeds without conflicts', async () => {
    const task = makeTask();
    mockExecFileSync.mockReturnValue('' as never);

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Synced & pushed.');
    expect(mockAgentCall).not.toHaveBeenCalled();
    // worktree → project push
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['push', PROJECT_DIR, 'HEAD'],
      expect.objectContaining({ cwd: task.worktreePath }),
    );
    // project → origin push
    expect(mockPushBranch).toHaveBeenCalledWith(PROJECT_DIR, 'task/test-task');
  });

  it('calls provider agent when merge has conflicts', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); });

    const result = await syncBranchWithRoot(PROJECT_DIR, task);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Conflicts resolved & pushed.');
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(mockAgentCall).toHaveBeenCalledWith(
      expect.stringContaining('Implement feature X'),
      expect.objectContaining({
        cwd: task.worktreePath,
        model: 'sonnet',
        permissionMode: 'edit',
        onPermissionRequest: expect.any(Function),
        onStream: expect.any(Function),
      }),
    );
  });

  it('aborts merge and returns false when AI resolution fails', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); })
      .mockReturnValueOnce('' as never);
    mockAgentCall.mockResolvedValue(makeAgentResponse({ status: 'error' }));

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

  it('does not throw when git merge --abort itself fails', async () => {
    const task = makeTask();
    mockExecFileSync
      .mockReturnValueOnce('' as never)
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); })
      .mockImplementationOnce(() => { throw new Error('abort failed'); });
    mockAgentCall.mockResolvedValue(makeAgentResponse({ status: 'error' }));

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
});
