import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { getFilesChanged } from '../infra/task/branchList.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFilesChanged', () => {
  it('should count changed files from branch entry base commit via reflog', () => {
    mockExecFileSync
      .mockReturnValueOnce('f00dbabe\nfeedface\nabc123\n')
      .mockReturnValueOnce('1\t0\tfile1.ts\n2\t1\tfile2.ts\n');

    const result = getFilesChanged('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--numstat', 'abc123..takt/20260128-fix-auth'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
  });

  it('should infer base from refs when reflog is unavailable', () => {
    let developMergeBaseCalls = 0;
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'git') {
        throw new Error('unexpected command');
      }

      if (args[0] === 'reflog') {
        throw new Error('reflog unavailable');
      }

      if (args[0] === 'merge-base' && args[1] === 'develop') {
        developMergeBaseCalls += 1;
        if (developMergeBaseCalls === 1) {
          throw new Error('priority develop failed');
        }
        return 'base999\n';
      }

      if (args[0] === 'merge-base' && args[1] === 'origin/develop') {
        throw new Error('priority origin/develop failed');
      }

      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return '.git\n';
      }

      if (args[0] === 'for-each-ref') {
        return 'develop\n';
      }

      if (args[0] === 'rev-list') {
        return '1\n';
      }

      if (args[0] === 'log' && args[1] === '--format=%s') {
        return 'takt: initial\n';
      }

      if (args[0] === 'diff' && args[1] === '--numstat') {
        return '1\t0\tfile1.ts\n';
      }

      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const result = getFilesChanged('/project', 'develop', 'takt/20260128-fix-auth');

    expect(result).toBe(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'develop', 'takt/20260128-fix-auth'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
  });

  it('should return 0 when base commit resolution fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('base resolution failed');
    });

    const result = getFilesChanged('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe(0);
  });
});
