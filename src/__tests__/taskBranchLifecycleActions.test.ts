import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecFileSync,
  mockSpawnSync,
  mockSuccess,
  mockInfo,
  mockError,
  mockWarn,
  mockEnsureRootBranchReady,
  mockLstatSync,
  mockRmSync,
  mockUnlinkSync,
  mockCleanupOrphanedClone,
  mockWorktreePath,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockEnsureRootBranchReady: vi.fn(),
  mockLstatSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockCleanupOrphanedClone: vi.fn(),
  mockWorktreePath: vi.fn(),
}));

vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  lstatSync: mockLstatSync,
  rmSync: mockRmSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawnSync: mockSpawnSync,
}));

vi.mock('../shared/ui/index.js', () => ({
  success: mockSuccess,
  info: mockInfo,
  error: mockError,
  warn: mockWarn,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../features/tasks/list/taskActionTarget.js', () => ({
  ensureRootBranchReady: (...args: unknown[]) => mockEnsureRootBranchReady(...args),
  resolveTargetBranch: () => 'takt/test-branch',
  resolveTargetWorktreePath: mockWorktreePath,
}));

vi.mock('../infra/task/index.js', () => ({
  cleanupOrphanedClone: mockCleanupOrphanedClone,
}));

import { deleteBranch, tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';

const target = { kind: 'failed' as const, name: 'task', content: 'task',
  createdAt: '2026-01-01T00:00:00Z', filePath: '/project/.takt/tasks.yaml', branch: 'takt/test-branch' };
const resume = { quiet: true, resume: true };

describe('taskBranchLifecycleActions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnsureRootBranchReady.mockReturnValue(true);
    mockWorktreePath.mockReturnValue('/tmp/worktree');
  });

  it.each([false, true])('resumes only remaining branch and orphan clone cleanup (branch exists: %s)', (branchExists) => {
    mockWorktreePath.mockReturnValue(undefined);
    mockLstatSync.mockReturnValue({});
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'for-each-ref') return branchExists ? 'refs/heads/takt/test-branch\n' : '';
      if (!branchExists) throw new Error('branch already deleted');
      return '';
    });

    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(branchExists ? 1 : 0);
    expect(mockCleanupOrphanedClone).toHaveBeenCalledOnce();
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
  });

  it('does not mistake a branch inspection failure for completed cleanup', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation(() => { throw new Error('git read failed'); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it('retains a cleanup failure after the branch has disappeared until orphan cleanup succeeds', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockReturnValue({});
    mockCleanupOrphanedClone.mockImplementationOnce(() => { throw new Error('clone cleanup failed'); });

    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(0);
    expect(mockCleanupOrphanedClone).toHaveBeenCalledTimes(2);
  });

  it('skips completed branch and orphan cleanup when neither resource remains', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(0);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it('does not treat failed orphan resource inspection as completed cleanup', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it.each([[false, false], [false, true], [true, false]])(
    'resumes only remaining worktree and session cleanup (directory: %s, session: %s)', (directory, session) => {
      mockLstatSync.mockImplementation((path: string) => {
        if (path === '/tmp/worktree' ? directory : path.includes('worktree-sessions') && session) return {};
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      });
      expect(deleteBranch('/project', target, resume)).toBe(true);
      expect(mockRmSync).toHaveBeenCalledTimes(directory ? 1 : 0);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(session ? 1 : 0);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
    },
  );

  it('keeps worktree recovery incomplete when existence inspection fails', () => {
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('surfaces git stderr when try-merge fails', () => {
    const err = new Error('Command failed: git merge --squash takt/test-branch');
    Object.assign(err, {
      stderr: Buffer.from('error: Merging is not possible because you have unmerged files.\n'),
    });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    const result = tryMergeBranch('/project', {
      kind: 'completed',
      name: 'task',
      createdAt: '2026-01-01T00:00:00Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'task',
      branch: 'takt/test-branch',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('error: Merging is not possible because you have unmerged files.'),
    );
  });
});
