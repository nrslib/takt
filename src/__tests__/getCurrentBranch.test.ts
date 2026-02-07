/**
 * Tests for getCurrentBranch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

import { getCurrentBranch } from '../infra/task/git.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCurrentBranch', () => {
  it('should return the current branch name', () => {
    // Given
    mockExecFileSync.mockReturnValue('feature/my-branch\n');

    // When
    const result = getCurrentBranch('/project');

    // Then
    expect(result).toBe('feature/my-branch');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' },
    );
  });

  it('should trim whitespace from output', () => {
    // Given
    mockExecFileSync.mockReturnValue('  main  \n');

    // When
    const result = getCurrentBranch('/project');

    // Then
    expect(result).toBe('main');
  });

  it('should propagate errors from git', () => {
    // Given
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    // When / Then
    expect(() => getCurrentBranch('/not-a-repo')).toThrow('not a git repository');
  });
});
