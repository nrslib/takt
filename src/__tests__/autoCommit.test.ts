/**
 * Tests for autoCommitAndPush
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoCommitAndPush } from '../infra/task/autoCommit.js';

// Mock child_process.execFileSync
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockResolveConfigValue = vi.fn(() => undefined);
vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

function includesCommand(args: readonly string[], command: string): boolean {
  return args.includes(command);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConfigValue.mockReturnValue(undefined);
});

describe('autoCommitAndPush', () => {
  it('should create a commit and push when there are changes', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (includesCommand(argsArr, 'status')) {
        return 'M src/index.ts\n';
      }
      if (includesCommand(argsArr, 'rev-parse')) {
        return 'abc1234\n';
      }
      if (includesCommand(argsArr, 'config')) {
        return 'filter.test.clean\nfilter.test.required\n';
      }
      return Buffer.from('');
    });

    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.message).toContain('abc1234');

    const addCall = mockExecFileSync.mock.calls.find(
      call => includesCommand(call[1] as string[], 'add')
    );
    expect(addCall).toBeDefined();
    expect(addCall![0]).toBe('git');
    expect(addCall![1]).toEqual(['add', '-A']);
    expect(addCall![2]).toEqual(expect.objectContaining({
      cwd: '/tmp/clone',
      env: expect.objectContaining({
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_KEY_1: 'filter.test.clean',
        GIT_CONFIG_VALUE_1: '',
        GIT_CONFIG_KEY_2: 'filter.test.required',
        GIT_CONFIG_VALUE_2: 'false',
      }),
    }));

    // Verify commit was called with correct message and --no-verify
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['commit', '--no-verify', '-m', 'takt: my-task'],
      expect.objectContaining({
        cwd: '/tmp/clone',
        env: expect.objectContaining({
          GIT_CONFIG_KEY_0: 'core.hooksPath',
        }),
      })
    );

    // Verify push was called with projectDir directly (no origin remote)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', '/project', 'HEAD'],
      expect.objectContaining({ cwd: '/tmp/clone' })
    );
  });

  it('should return success with no commit when there are no changes', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (includesCommand(argsArr, 'status')) {
        return ''; // No changes
      }
      if (includesCommand(argsArr, 'config')) {
        return '';
      }
      return Buffer.from('');
    });

    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
    expect(result.message).toBe('No changes to commit');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['add', '-A'],
      expect.objectContaining({
        cwd: '/tmp/clone',
        env: expect.objectContaining({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
        }),
      })
    );

    // Verify commit was NOT called
    expect(
      mockExecFileSync.mock.calls.some(call => includesCommand(call[1] as string[], 'commit'))
    ).toBe(false);

    // Verify push was NOT called
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['push', '/project', 'HEAD'],
      expect.anything()
    );
  });

  it('should return failure when git command fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('git error: not a git repository');
    });

    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    expect(result.success).toBe(false);
    expect(result.commitHash).toBeUndefined();
    expect(result.message).toContain('Auto-commit failed');
    expect(result.message).toContain('not a git repository');
  });

  it('should not include co-author in commit message', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (includesCommand(argsArr, 'status')) {
        return 'M file.ts\n';
      }
      if (includesCommand(argsArr, 'rev-parse')) {
        return 'def5678\n';
      }
      if (includesCommand(argsArr, 'config')) {
        return '';
      }
      return Buffer.from('');
    });

    autoCommitAndPush('/tmp/clone', 'test-task', '/project');

    // Find the commit call
    const commitCall = mockExecFileSync.mock.calls.find(
      call => includesCommand(call[1] as string[], 'commit')
    );

    expect(commitCall).toBeDefined();
    const args = commitCall![1] as string[];
    const commitMessage = args[args.indexOf('-m') + 1];
    expect(commitMessage).toBe('takt: test-task');
    expect(commitMessage).not.toContain('Co-Authored-By');
  });

  it('should use the correct commit message format', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (includesCommand(argsArr, 'status')) {
        return 'A new-file.ts\n';
      }
      if (includesCommand(argsArr, 'rev-parse')) {
        return 'aaa1111\n';
      }
      if (includesCommand(argsArr, 'config')) {
        return '';
      }
      return Buffer.from('');
    });

    autoCommitAndPush('/tmp/clone', '認証機能を追加する', '/project');

    const commitCall = mockExecFileSync.mock.calls.find(
      call => includesCommand(call[1] as string[], 'commit')
    );
    const args = commitCall![1] as string[];
    expect(args[args.indexOf('-m') + 1]).toBe('takt: 認証機能を追加する');
  });

  it('should allow hooks and filters only when explicitly configured', () => {
    mockResolveConfigValue.mockImplementation((_projectDir: string, key: string) => {
      if (key === 'allowGitHooks' || key === 'allowGitFilters') {
        return true;
      }
      return undefined;
    });
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (includesCommand(argsArr, 'status')) {
        return 'M src/index.ts\n';
      }
      if (includesCommand(argsArr, 'rev-parse')) {
        return 'abc1234\n';
      }
      return Buffer.from('');
    });

    autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['add', '-A'],
      expect.objectContaining({ cwd: '/tmp/clone', env: undefined })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'takt: my-task'],
      expect.objectContaining({ cwd: '/tmp/clone', env: undefined })
    );
    expect(
      mockExecFileSync.mock.calls.some(call => includesCommand(call[1] as string[], 'config'))
    ).toBe(false);
  });
});
