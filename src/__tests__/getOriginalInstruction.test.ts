/**
 * Tests for getOriginalInstruction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.execFileSync
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { getOriginalInstruction } from '../infra/task/branchList.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOriginalInstruction', () => {
  it('should extract instruction from branch entry commit via reflog', () => {
    mockExecFileSync
      .mockReturnValueOnce('last789\nfirst456\nbase123\n')
      .mockReturnValueOnce('takt: 認証機能を追加する\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('認証機能を追加する');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['reflog', 'show', '--format=%H', 'takt/20260128-fix-auth'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['show', '-s', '--format=%s', 'first456'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
  });

  it('should infer base from refs when reflog is unavailable', () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('reflog unavailable');
      })
      .mockReturnValueOnce('develop\n')
      .mockReturnValueOnce('base123\n')
      .mockReturnValueOnce('2\n')
      .mockReturnValueOnce('takt: Initial implementation\nfollow-up\n')
      .mockReturnValueOnce('first456\ttakt: Initial implementation\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('Initial implementation');
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

  it('should return empty string when no commits on branch', () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('reflog unavailable');
      })
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('');
  });

  it('should return empty string when git command fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = getOriginalInstruction('/non-existent', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('');
  });

  it('should handle multi-line commit messages (use only first line)', () => {
    mockExecFileSync
      .mockReturnValueOnce('f00dbabe\ndeadbeef\nbase123\n')
      .mockReturnValueOnce('takt: Fix the login bug\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-login');

    expect(result).toBe('Fix the login bug');
  });

  it('should return empty string when takt prefix has no content', () => {
    mockExecFileSync
      .mockReturnValueOnce('cafebabe\nbase123\n')
      .mockReturnValueOnce('takt:\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-task');

    expect(result).toBe('');
  });

  it('should return instruction text when takt prefix has content', () => {
    mockExecFileSync
      .mockReturnValueOnce('beadface\nbase123\n')
      .mockReturnValueOnce('takt: add search feature\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-task');

    expect(result).toBe('add search feature');
  });

  it('should return original subject when branch entry commit has no takt prefix', () => {
    mockExecFileSync
      .mockReturnValueOnce('last789\nfirst456\nbase123\n')
      .mockReturnValueOnce('Initial implementation\n');

    const result = getOriginalInstruction('/project', 'main', 'takt/20260128-fix-auth');

    expect(result).toBe('Initial implementation');
  });
});
