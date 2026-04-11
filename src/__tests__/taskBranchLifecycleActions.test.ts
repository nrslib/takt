import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecFileSync,
  mockSpawnSync,
  mockSuccess,
  mockInfo,
  mockError,
  mockWarn,
  mockEnsureRootBranchReady,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockEnsureRootBranchReady: vi.fn(),
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
  resolveTargetWorktreePath: () => '/tmp/worktree',
}));

vi.mock('../infra/task/index.js', () => ({
  cleanupOrphanedClone: vi.fn(),
}));

import { tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';

describe('taskBranchLifecycleActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureRootBranchReady.mockReturnValue(true);
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
      'Squash merge failed: error: Merging is not possible because you have unmerged files.',
    );
  });
});
