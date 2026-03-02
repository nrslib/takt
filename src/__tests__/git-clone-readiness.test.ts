/**
 * Tests for checkGitCloneReadiness (git state validation before clone creation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFileSync } from 'node:child_process';
import { checkGitCloneReadiness } from '../infra/task/git.js';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkGitCloneReadiness', () => {
  it('should return ready when git repo is initialized and has commits', () => {
    // Given: both git commands succeed
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--is-inside-work-tree') {
        return 'true\n';
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === 'HEAD') {
        return 'abc123\n';
      }
      return Buffer.from('');
    });

    // When
    const result = checkGitCloneReadiness('/project');

    // Then
    expect(result).toEqual({ ready: true });
  });

  it('should return not_git_repo when directory is not a git repository', () => {
    // Given: git rev-parse --is-inside-work-tree fails
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--is-inside-work-tree') {
        throw new Error('fatal: not a git repository');
      }
      return Buffer.from('');
    });

    // When
    const result = checkGitCloneReadiness('/not-a-repo');

    // Then
    expect(result).toEqual({ ready: false, reason: 'not_git_repo' });
  });

  it('should return no_commits when git repo has no commits', () => {
    // Given: git is initialized but HEAD does not exist
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--is-inside-work-tree') {
        return 'true\n';
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === 'HEAD') {
        throw new Error('fatal: ambiguous argument \'HEAD\': unknown revision');
      }
      return Buffer.from('');
    });

    // When
    const result = checkGitCloneReadiness('/empty-repo');

    // Then
    expect(result).toEqual({ ready: false, reason: 'no_commits' });
  });

  it('should pass cwd to execFileSync for both checks', () => {
    // Given: both commands succeed
    mockExecFileSync.mockReturnValue(Buffer.from('true\n'));

    // When
    checkGitCloneReadiness('/my/project/dir');

    // Then: both calls use the provided cwd
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      expect.objectContaining({ cwd: '/my/project/dir' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/my/project/dir' }),
    );
  });

  it('should not check HEAD when not a git repo', () => {
    // Given: not a git repo
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--is-inside-work-tree') {
        throw new Error('fatal: not a git repository');
      }
      return Buffer.from('');
    });

    // When
    checkGitCloneReadiness('/not-a-repo');

    // Then: only one call was made (not_git_repo short-circuits)
    const revParseCalls = mockExecFileSync.mock.calls.filter(
      (call) => call[0] === 'git',
    );
    expect(revParseCalls).toHaveLength(1);
    expect((revParseCalls[0]![1] as string[])[1]).toBe('--is-inside-work-tree');
  });
});
