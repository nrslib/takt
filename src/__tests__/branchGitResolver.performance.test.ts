import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  createBranchBaseResolutionCache,
  findFirstTaktCommit,
  resolveBranchBaseCommit,
} from '../infra/task/branchGitResolver.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('branchGitResolver performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip full ref scan when default branch candidate resolves', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'git') {
        throw new Error('unexpected command');
      }

      if (args[0] === 'reflog') {
        throw new Error('reflog unavailable');
      }

      if (args[0] === 'merge-base' && args[1] === 'main') {
        return 'base-main';
      }

      if (args[0] === 'merge-base' && args[1] === 'origin/main') {
        throw new Error('origin/main not available');
      }

      if (args[0] === 'rev-list') {
        return '1';
      }

      if (args[0] === 'log' && args[1] === '--format=%s') {
        return 'takt: first';
      }

      if (args[0] === 'for-each-ref') {
        throw new Error('for-each-ref should not be called');
      }

      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const baseCommit = resolveBranchBaseCommit('/project', 'main', 'takt/feature-a');

    expect(baseCommit).toBe('base-main');
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      expect.anything(),
    );
  });

  it('should reuse ref list cache across branch resolutions', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'git') {
        throw new Error('unexpected command');
      }

      if (args[0] === 'reflog') {
        throw new Error('reflog unavailable');
      }

      if (args[0] === 'merge-base') {
        const baseRef = args[1];
        const branch = args[2];
        if (baseRef === 'main' || baseRef === 'origin/main') {
          throw new Error('priority refs unavailable');
        }
        if (baseRef === 'develop' && branch === 'takt/feature-a') {
          return 'base-a';
        }
        if (baseRef === 'origin/develop' && branch === 'takt/feature-a') {
          return 'base-a-remote';
        }
        if (baseRef === 'develop' && branch === 'takt/feature-b') {
          return 'base-b';
        }
        if (baseRef === 'origin/develop' && branch === 'takt/feature-b') {
          return 'base-b-remote';
        }
        throw new Error(`unexpected merge-base args: ${args.join(' ')}`);
      }

      if (args[0] === 'for-each-ref') {
        return 'develop\norigin/develop\n';
      }

      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return '/project/.git';
      }

      if (args[0] === 'rev-list') {
        const range = args[3];
        if (range === 'base-a..takt/feature-a') {
          return '1';
        }
        if (range === 'base-a-remote..takt/feature-a') {
          return '5';
        }
        if (range === 'base-b..takt/feature-b') {
          return '1';
        }
        if (range === 'base-b-remote..takt/feature-b') {
          return '6';
        }
        throw new Error(`unexpected rev-list args: ${args.join(' ')}`);
      }

      if (args[0] === 'log' && args[1] === '--format=%s') {
        return 'takt: first';
      }

      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const cache = createBranchBaseResolutionCache();
    const baseA = resolveBranchBaseCommit('/project', 'main', 'takt/feature-a', cache);
    const baseB = resolveBranchBaseCommit('/project', 'main', 'takt/feature-b', cache);

    expect(baseA).toBe('base-a');
    expect(baseB).toBe('base-b');

    const forEachRefCalls = mockExecFileSync.mock.calls.filter(([, args]) =>
      args[0] === 'for-each-ref',
    );
    expect(forEachRefCalls).toHaveLength(1);
  });

  it('should skip reflog lookup when baseCommit is provided to findFirstTaktCommit', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'git') {
        throw new Error('unexpected command');
      }

      if (args[0] === 'reflog') {
        throw new Error('reflog should not be called');
      }

      if (args[0] === 'log' && args[1] === '--format=%H\t%s') {
        return 'abc123\ttakt: first instruction\n';
      }

      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const first = findFirstTaktCommit('/project', 'main', 'takt/feature-a', { baseCommit: 'base-a' });

    expect(first).toEqual({ subject: 'takt: first instruction' });
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['reflog', 'show', '--format=%H', 'takt/feature-a'],
      expect.anything(),
    );
  });

  it('should reuse ref list cache across worktrees in the same repository', () => {
    mockExecFileSync.mockImplementation((cmd, args, options) => {
      if (cmd !== 'git') {
        throw new Error('unexpected command');
      }

      if (args[0] === 'reflog') {
        throw new Error('reflog unavailable');
      }

      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        if (options?.cwd === '/repo/worktrees/a' || options?.cwd === '/repo/worktrees/b') {
          return '/repo/.git';
        }
        throw new Error(`unexpected rev-parse cwd: ${String(options?.cwd)}`);
      }

      if (args[0] === 'merge-base') {
        const baseRef = args[1];
        const branch = args[2];
        if (baseRef === 'main' || baseRef === 'origin/main') {
          throw new Error('priority refs unavailable');
        }
        if (baseRef === 'develop' && branch === 'takt/feature-a') {
          return 'base-a';
        }
        if (baseRef === 'origin/develop' && branch === 'takt/feature-a') {
          return 'base-a-remote';
        }
        if (baseRef === 'develop' && branch === 'takt/feature-b') {
          return 'base-b';
        }
        if (baseRef === 'origin/develop' && branch === 'takt/feature-b') {
          return 'base-b-remote';
        }
        throw new Error(`unexpected merge-base args: ${args.join(' ')}`);
      }

      if (args[0] === 'for-each-ref') {
        return 'develop\norigin/develop\n';
      }

      if (args[0] === 'rev-list') {
        const range = args[3];
        if (range === 'base-a..takt/feature-a') {
          return '1';
        }
        if (range === 'base-a-remote..takt/feature-a') {
          return '5';
        }
        if (range === 'base-b..takt/feature-b') {
          return '1';
        }
        if (range === 'base-b-remote..takt/feature-b') {
          return '6';
        }
        throw new Error(`unexpected rev-list args: ${args.join(' ')}`);
      }

      if (args[0] === 'log' && args[1] === '--format=%s') {
        return 'takt: first';
      }

      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const cache = createBranchBaseResolutionCache();
    const baseA = resolveBranchBaseCommit('/repo/worktrees/a', 'main', 'takt/feature-a', cache);
    const baseB = resolveBranchBaseCommit('/repo/worktrees/b', 'main', 'takt/feature-b', cache);

    expect(baseA).toBe('base-a');
    expect(baseB).toBe('base-b');

    const forEachRefCalls = mockExecFileSync.mock.calls.filter(([, args]) =>
      args[0] === 'for-each-ref',
    );
    expect(forEachRefCalls).toHaveLength(1);
  });
});
