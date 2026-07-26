import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCheckoutWorktreeBranchFromOrigin,
  mockCloneAndIsolate,
  mockRemoveClone,
  mockRandomBytes,
  mockResolveCloneBaseDir,
} = vi.hoisted(() => ({
  mockCheckoutWorktreeBranchFromOrigin: vi.fn(),
  mockCloneAndIsolate: vi.fn(),
  mockRemoveClone: vi.fn(),
  mockRandomBytes: vi.fn(),
  mockResolveCloneBaseDir: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: mockRandomBytes,
}));

vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolate: mockCloneAndIsolate,
}));

vi.mock('../infra/task/index.js', () => ({
  removeClone: mockRemoveClone,
  resolveCloneBaseDir: mockResolveCloneBaseDir,
}));

vi.mock('../infra/workflow/system/system-effect-git-helpers.js', () => ({
  checkoutWorktreeBranchFromOrigin: mockCheckoutWorktreeBranchFromOrigin,
}));

import {
  acquirePrSyncSession,
  releasePrSyncSession,
  type PrSyncSession,
} from '../infra/workflow/system/system-pr-sync-worktree.js';

beforeEach(() => {
  vi.resetAllMocks();
  let randomByteValue = 1;
  mockRandomBytes.mockImplementation((size: number) => {
    const value = Buffer.alloc(size, randomByteValue);
    randomByteValue += 1;
    return value;
  });
  mockResolveCloneBaseDir.mockReturnValue('/tmp/takt-worktrees');
});

describe('PR sync worktree paths', () => {
  it('should create separate readable filesystem-safe paths when distinct PR sessions start in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.123Z'));

    try {
      const store = new Map<number, PrSyncSession>();
      const first = acquirePrSyncSession(store, '/project', 816, 'takt/816/implement-finding-contract');
      const second = acquirePrSyncSession(store, '/project', 827, 'takt/827/add-trace-task-metadata');

      expect(first.worktreePath).toMatch(/^\/tmp\/takt-worktrees\/pr-sync-\d+-[a-f0-9]{16}$/);
      expect(second.worktreePath).toMatch(/^\/tmp\/takt-worktrees\/pr-sync-\d+-[a-f0-9]{16}$/);
      expect(first.worktreePath).not.toBe(second.worktreePath);
      expect(mockCloneAndIsolate).toHaveBeenCalledWith('/project', first.worktreePath);
      expect(mockCloneAndIsolate).toHaveBeenCalledWith('/project', second.worktreePath);
      expect(mockCheckoutWorktreeBranchFromOrigin).toHaveBeenCalledWith(
        '/project',
        first.worktreePath,
        'takt/816/implement-finding-contract',
      );
      expect(mockCheckoutWorktreeBranchFromOrigin).toHaveBeenCalledWith(
        '/project',
        second.worktreePath,
        'takt/827/add-trace-task-metadata',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('should remove the generated path associated with the released PR session', () => {
    const store = new Map<number, PrSyncSession>();
    const session = acquirePrSyncSession(store, '/project', 816, 'takt/816/implement-finding-contract');

    releasePrSyncSession(store, 816);

    expect(store.has(816)).toBe(false);
    expect(mockRemoveClone).toHaveBeenCalledWith(session.worktreePath);
  });

  it('should remove the generated path when PR session creation fails', () => {
    mockCheckoutWorktreeBranchFromOrigin.mockImplementation(() => {
      throw new Error('checkout failed');
    });
    const store = new Map<number, PrSyncSession>();

    expect(() => acquirePrSyncSession(store, '/project', 816, 'takt/816/implement-finding-contract'))
      .toThrow('checkout failed');

    const clonedPath = mockCloneAndIsolate.mock.calls[0]?.[1];
    expect(store.size).toBe(0);
    expect(mockRemoveClone).toHaveBeenCalledWith(clonedPath);
  });
});
