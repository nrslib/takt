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
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('reflog unavailable');
      })
      .mockReturnValueOnce('develop\n')
      .mockReturnValueOnce('base999\n')
      .mockReturnValueOnce('1\n')
      .mockReturnValueOnce('takt: fix auth\n')
      .mockReturnValueOnce('1\t0\tfile1.ts\n');

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
